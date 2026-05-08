# PWA Identity, Device Sync, and Key Rotation Design

## Problem

1. The QR code (agent ID + public key) is a bearer credential — anyone with it can connect
2. No way to share saved machines across devices (phone, laptop, tablet)
3. No way to revoke access from a compromised device

## Design Decisions

After evaluating account-based sync, derived key trees, multi-layer key hierarchies, and various sync mechanisms, we arrived at a minimal design:

- **No accounts, no server-side auth** — preserve zero-trust model
- **No key hierarchy** — three flat key types, no derived keys
- **Key rotation as revocation** — rotate agent or PWA key to invalidate all connections
- **Per-device mailbox sync** — source device pushes encrypted blobs to each paired device's mailbox on the server
- **Tombstone on PWA key rotation** — signed kill switch that wipes stale state

## Key Model

| Key | Purpose | Lifetime | Where |
|-----|---------|----------|-------|
| Agent X25519 keypair | Authenticates the agent, used in DEK key exchange | Persistent until rotated via `quicksave rotate-keys` | `~/.quicksave/agent.json` |
| PWA identity X25519 keypair | Addresses PWA on signaling server, encrypts sync blobs | Persistent until rotated via PWA settings | Browser IndexedDB |
| Session DEK | Encrypts all messages for one connection | Ephemeral, fresh per session | Memory only |

## Architecture Changes

### 1. PWA Persistent Identity

Each PWA generates a persistent X25519 keypair on first use, stored in IndexedDB alongside the existing master secret. This keypair serves two purposes:

- **Signaling address**: PWA connects to `/pwa/{pwaPublicKey}` instead of `/pwa/{agentId}`
- **Sync encryption**: Other devices encrypt sync blobs to this public key

### 2. Signaling Server: Explicit Routing

Currently the signaling server pairs PWA and agent implicitly by URL path. The new model uses explicit per-message routing:

**Current**: `ws://server/pwa/{agentId}` — one connection per agent
**New**: `ws://server/pwa/{pwaPublicKey}` — one persistent connection, routed per message

Every message includes explicit `from` and `to` fields:

```json
{
  "type": "key-exchange",
  "from": "pwa:{pwaPublicKey}",
  "to": "agent:{agentId}",
  "payload": { ... }
}
```

The server validates `from` matches the sender's connection identity and routes to `to`. Agent connections remain at `/agent/{agentId}`.

The server also supports PWA-to-PWA relay for device pairing — routing messages between two `/pwa/{pubKey}` connections.

### 3. Device Pairing (Sync Setup)

The device that **shows the QR code** is the target (new/empty device). The device that **scans** is the source of truth.

```
Mac (new, shows QR)          Signaling Server          Phone (source, scans)
   |                              |                          |
   | [Shows QR: macPubKey]        |                          |
   |                              |            [Scans QR]    |
   |                              |            [Adds Mac to  |
   |                              |             pairedDevices]|
   |                              |            [Encrypts     |
   |                              |             backup v2 to |
   |                              |             macPubKey]   |
   |                              |                          |
   |                              |◀── PUT /sync/{hash(macPubKey)}
   |                              |    encrypted backup blob |
   |                              |                          |
   | GET /sync/{hash(macPubKey)}  |                          |
   | [Decrypt with own secret key]|                          |
   | [Overwrite all local state]  |                          |
```

### 4. Ongoing Sync

When the source device's machine list changes (add/remove agent, update metadata), it re-encrypts and pushes to each paired device's mailbox:

```
Source device updates machine list
  → for each paired device:
    → encrypt backup v2 to pairedDevice.publicKey
    → PUT /sync/{hash(pairedDevice.publicKey)}
```

Paired devices either poll on connect or receive a WebSocket notification that their mailbox has been updated.

**Sync is one-directional**: the source device is the authority. Other devices receive updates but don't push changes back. If a non-source device adds an agent locally, it stays local only.

### 5. Server Sync API

Minimal REST endpoints on the signaling server:

```
PUT  /sync/{publicKeyHash}  — store encrypted blob (size-capped, e.g. 8KB)
GET  /sync/{publicKeyHash}  — retrieve encrypted blob
```

The server stores opaque blobs keyed by hash of the recipient's public key. It cannot read the contents. Old blobs are overwritten on each PUT.

When a tombstone exists for a key hash, the server:
- Returns `410 Gone` with the tombstone body for GET requests
- Rejects all PUT requests (no one can push to a dead mailbox)

### 6. Sync Data Format

Reuses the existing v2 backup format, encrypted to the recipient's public key using the sealed-box pattern (`encryptDEK` style):

```json
{
  "version": 2,
  "masterSecret": "<base64>",
  "apiKey": "<optional>",
  "machines": [
    {
      "agentId": "...",
      "publicKey": "...",
      "nickname": "...",
      "icon": "...",
      "addedAt": 0,
      "lastConnectedAt": null,
      "lastRepoPath": null,
      "knownRepos": [],
      "isPro": false
    }
  ],
  "exportedAt": "<ISO date>"
}
```

Encrypted envelope: `encryptDEK(gzip(JSON.stringify(backup)), recipientPublicKey)` — reuses existing sealed-box crypto.

### 7. PWA Key Rotation

Triggered from PWA settings ("Rotate Identity" button):

1. Generate new X25519 keypair
2. Sign a tombstone with the **old** secret key:
   ```json
   {
     "type": "rotated",
     "oldPublicKey": "<base64>",
     "signature": "<base64>"  // sign("rotated:{oldPublicKey}", oldSecretKey)
   }
   ```
3. `PUT /sync/{hash(oldPublicKey)}` with the tombstone (server marks this key hash as permanently dead)
4. Wipe all local data (machines, paired devices, master secret, API key)
5. Reconnect to signaling server with new identity
6. Show onboarding guide: "Scan a trusted device to restore your data"

### 8. Tombstone Discovery

When a source device pushes to a paired device's mailbox and receives `410 Gone`:

1. Verify the tombstone signature against the old public key
2. If valid: remove that device from paired devices list, push updated list to remaining paired devices
3. If invalid: treat as orphaned — show "device offline or key changed, re-scan to re-pair"

When **any** device fetches its own mailbox and finds a tombstone (shouldn't happen in normal flow, but as a safety check):

1. Wipe all local data
2. Show re-pairing guide

### 9. Agent Key Rotation

New CLI command: `quicksave rotate-keys`

1. Generate new X25519 keypair
2. Save to `~/.quicksave/agent.json` (overwrites old keypair)
3. Agent ID remains the same (optional — could also rotate, but keeping it stable is simpler)
4. Display new QR code
5. All existing PWA connections become invalid — they hold the old public key

After rotation, the user re-scans the agent QR on each trusted device. The machine entry in the PWA is updated with the new public key (matched by agent ID).

### 10. PWA Stores Changes

**New: identityStore** (persisted to IndexedDB)
```typescript
interface IdentityStore {
  keyPair: { publicKey: string; secretKey: string };  // X25519
  pairedDevices: PairedDevice[];
  isSource: boolean;  // true if this device is the sync authority
}

interface PairedDevice {
  publicKey: string;
  label: string;
  pairedAt: number;
}
```

**Modified: connectionStore**
- Remove `agentId` and `agentPublicKey` as connection-level state
- Add routing: PWA sends a `route` message to specify which agent to talk to
- Single WebSocket connection, multiple agent sessions

**Modified: machineStore**
- On sync receive: overwrite entire machine list (not merge)

### 11. QR Code Flows

**Agent QR** (existing, unchanged in content):
```
http://localhost:5173/connect?id={agentId}&pk={agentPublicKey}
```

**PWA QR** (new, for device pairing):
```
http://localhost:5173/pair?pk={pwaPublicKey}
```

The QR scanner needs to handle both URL formats and route accordingly.

## Affected Components

### Signaling Server (`apps/signaling/`)
- Support `/pwa/{publicKey}` connections (in addition to existing `/pwa/{agentId}` for backwards compat)
- Add explicit message routing with `from`/`to` fields
- Add PWA-to-PWA relay
- Add `PUT /sync/{hash}` and `GET /sync/{hash}` HTTP endpoints
- Tombstone storage and enforcement

### PWA (`apps/pwa/`)
- New `identityStore` for persistent keypair and paired devices
- New "Pair Device" UI in settings (show QR, scan QR)
- New "Rotate Identity" button in settings
- Modified `WebSocketClient` — single persistent connection with routing
- Modified `QRScanner` — handle both agent and pairing QR formats
- Modified sync logic — overwrite on receive, push on change
- Modified `ConnectionSetup`/`AddMachineModal` — work with new routing model

### Agent (`apps/agent/`)
- New `rotate-keys` CLI command
- No changes to connection protocol (agent side is passive in key exchange)

### Shared (`packages/shared/`)
- New message types for routing (`route`, `pair-request`, etc.)
- Tombstone type definition
- Possible new crypto helpers for tombstone signing/verification

## Security Properties

| Property | How |
|----------|-----|
| Zero-trust server | Signaling server sees only encrypted blobs and opaque relay traffic |
| Forward secrecy | Fresh random DEK per session (unchanged) |
| Revocation (agent) | `quicksave rotate-keys` — new keypair, old public key useless |
| Revocation (PWA) | Rotate identity — tombstone seals old mailbox, local data wiped |
| Sync confidentiality | Sealed-box encryption to recipient's public key |
| Tombstone authenticity | Signed with old secret key — only the real owner can post |
| Replay protection | 60-second timestamp window on key exchange (unchanged) |

## What This Design Does NOT Include

- Bidirectional sync (only source → paired devices)
- Agent-side client authentication / allowlist (agent accepts anyone with its public key)
- Derived key tree / key hierarchy
- User accounts or OAuth
- Passphrase-based key derivation
