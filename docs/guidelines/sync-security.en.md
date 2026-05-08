# PWA ↔ PWA Sync Security

How to securely sync "device (agent running machines)" information and account settings across multiple PWA clients.
This document targets the **single-user app** scenario (each user owns their own set of PWA devices; the relay is shared across users and holds no per-account state).

The overall design converges on [Happy Coder](https://github.com/slopus/happy): **all PWAs belonging to the same account share a single `masterSecret`, and every encryption / signing key is derived from it.** There is no per-PWA identity, no allowlist, and no endorsement propagation.

## Threat Model

**Trust boundary**:

- **Mutually trusted**: the user's PWA devices (sharing `masterSecret` ⇒ a single cryptographic principal)
- **Untrusted**: the relay (a best-effort buffering layer; can be reverse-engineered, fail, or be swapped out)
- **Observable**: the mailbox address `hash(shared_pubkey)` (an external attacker may guess it via traffic analysis)

**Attacks we want to defend against**:

| Threat | Mechanism |
|---|---|
| Forgery | Attacker writes a sync blob impersonating a legitimate device; on the next sync the malicious `Machine` is injected and the user is funneled into an MITM agent connection |
| LWW spoof | Attacker sets `updatedAt` to a huge value so a forged entry overrides the legitimate one (a special case of forgery) |
| Mailbox spam / DoS | Attacker continuously PUTs garbage, overwriting the single-slot mailbox blob from a legitimate sender and breaking sync |
| Pairing impersonation | When a new PWA joins, an attacker intercepts the pairing channel and pushes a malicious `masterSecret` to the new device (and can subsequently read/write the mailbox) |

**Out of scope for this document**:

- Vulnerabilities in the relay code itself (injection, overload protection, and other baseline service hygiene)
- Follow-on attacks after a fully compromised endpoint (the on-device IndexedDB `masterSecret` is stolen)
- A user actively handing over `masterSecret` via phishing

## Identity Model

`masterSecret` (32 bytes) is the sole root credential. Every keypair we need is derived from it:

| Key | Derivation | Purpose |
|---|---|---|
| Shared X25519 keypair | `crypto_box_seed_keypair(masterSecret)` (or an equivalent KDF) | sealed-box encryption/decryption of sync mailbox blobs |
| Shared Ed25519 signing key | `crypto_sign_seed_keypair(masterSecret)` | Signs sync blobs and cancel / lock requests |

**Key properties**:

- All paired PWAs derive the **identical** keypair → there is exactly one mailbox address (`hash(shared_pubkey)`) for the whole group
- Holding `masterSecret` ⇔ being a legitimate member. There is no cryptographic distinction between "which device is which"
- The device nickname (`nickname`) is just a convenient UI label and **plays no part in any verification or authorization decision**

The derivation lives in `packages/shared/src/crypto.ts`; secureStorage only persists `masterSecret` and no longer stores per-device keypairs.

### Why we abandoned per-PWA crypto identity

In an earlier design we tried giving each PWA its own X25519 + Ed25519 keypair and maintaining a `pairedDevices` allowlist. Re-examining each problem we originally hoped to solve:

| What we wanted to solve | Reassessment |
|---|---|
| Tell "which device wrote this" for after-the-fact tracking | In a single-user setting nobody actually does this tracking; if you want it you need monitoring, and per-device signatures don't solve that problem |
| Kick a specific device out | Routine retirement = the user wipes browser storage themselves; lost device = full-group reset (rotate `masterSecret`); neither needs an allowlist |
| Defend against forgery | Once `masterSecret` is shared, "legitimate member" and "attacker holding the key" are cryptographically indistinguishable → don't rely on an allowlist; rely on protecting `masterSecret` and the secrecy of the mailbox address |

Conclusion: drop the entire complexity.

## Sync Mailbox: Single Slot + Read-Modify-Write

### Slot semantics

There is only **one mailbox**, and its address = `hash(shared_pubkey)`. Every paired PWA is both a sender and a receiver.

- Each write is a **full-blob overwrite** (single slot)
- The blob payload is `SyncPayloadV3` (`apps/pwa/src/lib/syncMerge.ts`); every synced field is wrapped in `Timestamped<T>` and the machine list pairs with `machineTombstones`
- Conflict resolution: field-level LWW (already implemented in `syncMerge.ts`)

### Read-Modify-Write flow

Every time there's a local change to push:

```
1. GET  /sync/{hash(shared_pubkey)}            ← fetch latest blob
2. decryptSyncBlob(blob, sharedSecretKey)
3. local = mergeSyncPayloads(local, remote)    ← LWW convergence
4. signedBlob = sign(encrypted)                ← using the shared signing key
5. PUT  /sync/{hash(shared_pubkey)}            ← write back
```

LWW is commutative, so two devices writing concurrently without locks **will still converge**—but the intermediate state before convergence may briefly drop fields (A writes the blob from A's view, B writes the blob from B's view). To avoid this kind of jitter:

### Per-Mailbox Mutex (serialize PUT)

The relay maintains a simple in-flight flag per mailbox in `apps/relay/src/syncStore.ts`:

```ts
inFlight: Map<mailboxKeyHash, { sigPubkey: string; acquiredAt: number }>
```

- On PUT, if the mailbox has no in-flight entry, mark the sender as the current holder and accept the write
- On PUT, if there's already an in-flight entry held by a different sender → **HTTP 409** (with `Retry-After` seconds plus a `retryAfterMs` body field); the client backs off exponentially and retries (read-modify-write runs again, naturally merging in whatever the other side just wrote)
- TTL: 10 seconds (so a client that crashes mid-PUT doesn't permanently lock the mailbox)
- The same `sigPubkey` re-acquiring is treated as an idempotent renew and refreshes the TTL
- The in-flight flag is cleared immediately once the write completes (`releaseLock(keyHash, sigPubkey)` only clears a lock held by that sender)

**Why this is good enough (in a single-user setting)**:

- Legitimate senders are the user's own ~3–5 devices; one human doesn't operate them simultaneously. The window of concurrent writes is extremely narrow
- An actual 409 hit just backs off and retries; convergence happens within seconds and the user notices nothing
- Even if an attacker knows the mailbox address, without `masterSecret` they can't produce a decryptable blob—but they can PUT garbage and squat on the in-flight slot to harass us. **That's spam, not forgery**, and is mitigated by per-IP rate limiting

### Write authorization: signatures are mandatory

Although the mailbox payload is sealed-box encrypted and an attacker cannot produce valid ciphertext, the relay still needs to distinguish "legitimate PUT" from "garbage PUT" in order to do mutex and rate-limit accounting.

Every PUT / DELETE body (`packages/shared/src/syncEnvelope.ts`):

```ts
type SyncEnvelopeAction = 'sync-write' | 'sync-tombstone' | 'sync-lock-release';

interface SignedSyncEnvelope {
  v: 1;
  action: SyncEnvelopeAction;
  ciphertext?: string;      // absent for sync-lock-release
  sigPubkey: string;        // base64url Ed25519 pubkey
  ts: number;
  nonce: string;            // base64url 16-byte random
  sig: string;              // base64url Ed25519 signature
}

// canonical signed body (pipe-separated UTF-8):
// `${action}|${sigPubkey}|${ts}|${nonce}|${keyHash}|${ciphertextHash}`
// ciphertextHash = urlsafe-base64(SHA-512(ciphertext bytes))
// For lock-release, ciphertextHash = '' and ciphertext must be absent/empty.
```

The relay's `verifySignedRequest` (see `apps/relay/src/sigVerify.ts`) performs the following checks; any failure rejects with 401:

1. Ed25519 verify `sig` against the canonical body
2. `ts` is within ±skew (default ±5 minutes) — defends against stale or future-dated replay
3. `nonce` is not in the TTL nonce cache (the cache is shared across `/sync/*` so an envelope cannot replay across actions)
4. `action` must match the URL subpath: `blob → sync-write`, `tombstone → sync-tombstone`, `lock → sync-lock-release`

This prevents an attacker from blowing through the mutex with arbitrary payloads, and also blocks cross-action replay where a legitimate envelope is copied from one action to another. Binding `sigPubkey` to a specific mailbox is achieved automatically via the `keyHash` field in the canonical body—the same signature cannot be reused against a different mailbox.

### Cancel (release the mutex)

If a client decides to abandon a write mid-flight (user cancellation, retry from a higher layer), it can release proactively:

```http
DELETE /sync/{mailbox_hash}/lock
Body: SignedSyncEnvelope { action: 'sync-lock-release', ... }  // no ciphertext
```

The relay verifies the signature, checks `sigPubkey === inFlight.sigPubkey`, and clears the in-flight entry. If there's no lock or it's held by someone else, it returns `released: false`. Cancel is best-effort (the 10s TTL also cleans up automatically).

## Pairing Flow

The goal when a new PWA joins an existing group: securely deliver `masterSecret` from one of the existing PWAs (A) to the new PWA (B).
**Role conventions** (fixed from this section onward):
- **A** = an existing group member that holds `masterSecret`; the user clicks "yes, add this new device" in A's UI
- **B** = the joiner; has no group state, only a local ephemeral keypair

### Design highlights

Two authentication channels stack and each plays its part:

- **First channel (A → B, pubkey delivery)**: A generates an ephemeral keypair `(eA_pub, eA_sec)` and presents `eA_pub` simultaneously as a **QR code and a deep-link URL** (see [Pubkey delivery channel](#pubkey-delivery-channel)). The user picks either one — both prove at the physical / channel layer that "the pubkey B received belongs to this pairing initiated by A," and yield the mailbox address `hash(eA_pub)` (not globally visible) plus the encryption pubkey
- **SAS channel (B → A, naked-eye)**: B's screen displays `SAS = sasEncode(HMAC(eB_pub ‖ bucket(now, 60s)), 6)`. The user types it into A → A independently computes the SAS for **each candidate pubkey it received from the mailbox** and finds the unique match
- **Multi-slot mailbox + TTL**: the `hash(eA_pub)` mailbox is **not a single-slot overwrite** but **append-only with multiple slots**, each with its own TTL (5 minutes). An attacker's injection becomes one entry of noise in the mailbox rather than overwriting B's legitimate submission; the SAS filter discards the noise. The mailbox self-destructs at expiry
- **SAS is not an encryption key, it's a naked-eye verification value**: computing it from public data is not a flaw — it doesn't defend against eavesdropping, only against pubkey substitution

### Pubkey delivery channel

A's "add new device" UI offers both forms simultaneously; the user picks whichever fits the device on hand:

```
URL form (deep link):
  http://localhost:5173/pair#k=<base64url(eA_pub)>

QR form:
  the QR code encodes the same URL string above (B scanning the QR is equivalent to opening the URL)
```

**Why `eA_pub` lives in the fragment (after `#`) rather than the query (`?`)**:

The fragment is not sent by the browser to the server, doesn't appear in HTTP request logs, CDN logs, or referer headers. The PWA frontend JS reads `location.hash` to recover `eA_pub` and processes it locally. From the relay's perspective this is an honest "doesn't know, can't see." A query string, by contrast, could leave traces at the relay's TLS terminator.

**Are QR and URL equivalent?**

Their security semantics are equivalent: both transmit only `eA_pub` (public data). The difference is in **how they leak**:

| Channel | Typical exposure surface | Impact on pairing security |
|---|---|---|
| QR shown on A's screen | shoulder-surfing, long-lens cameras | Attacker still has to win the SAS lottery to fool A; see [Security analysis](#security-analysis) |
| URL manually copied / shared | clipboard, chat rooms, browser history, screenshot sync | Same as above — getting the URL = getting `eA_pub`, which lets you inject but doesn't get past the SAS filter |

In other words, the URL channel **does not weaken the SAS guarantee**; it only widens the window in which an attacker can obtain `eA_pub` from "physically present" to "able to see the user's clipboard or chat messages." The SAS layer remains the final gate.

**UX division of labor**:

- Phone → phone / phone → desktop: use QR (the camera is natural)
- Desktop → phone: scan the QR or click the URL
- Desktop → desktop, or when a camera is inconvenient: click the URL / copy the link (B pastes it into a browser or the PWA's "add device" field)
- Cross-network sharing (rare and not recommended, but technically possible): send the URL to your other device. The whole flow must complete within the 5-minute TTL

### SAS encoding and length

```ts
// packages/shared/src/crypto.ts
const SAS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';  // 32 symbols, removing 0/1/I/O, case-insensitive
function sasEncode(hmacOutput: Uint8Array, chars: number): string {
  // Take the first chars*5 bits of hmacOutput and look each 5 bits up in the table
}
```

**Settled: 6 characters, 32-symbol alphabet, 30 bits total.**

#### Reasoning

A 6-character space = 32⁶ ≈ 1.07 billion. The actual probabilities under typical attack scenarios:

| Scenario | Attacker capability | Probability of compromising a single pairing |
|---|---|---|
| **A: Normal threat model** | Sees relay traffic; **cannot see** B's screen | **1 / 16.8M** (blind shots, capped at 64 slots, each independently 1/32⁶) |
| **B: Paranoid scenario** | Physically sees A's QR + B's screen at the same time + has GPU resources (brute-force search for a colliding pubkey) | 6 chars: ~1/bucket; 8 chars: ~10⁻³; 10 chars: ~10⁻⁶ |

**Why 6 chars for scenario A**:

- 1/16.8M is rarer than dying in a plane crash (1/11M) and more common than winning the Powerball jackpot (1/292M) — landing in the "rarer than disaster, more common than the lottery" range, which feels intuitively safe
- 6 characters fit within human short-term memory (7±2); after a glance at B you remember and type it into A without ping-ponging between two screens
- The SAS only lives within the 60s bucket of that pairing moment and is not stored anywhere; even if a colliding attacker manages a successful POST, only that session is affected — no permanent account-level compromise

**Why we don't go to 8 or 10 chars to cover scenario B**:

Scenario B presupposes that the attacker can remotely watch B's screen in real time. Achieving that usually means:
1. malware / remote desktop control is installed on B → **the attacker already has full control of B**, can directly grab the IndexedDB `masterSecret`, steal session tokens, and read messages, with no need to bypass SAS
2. they can physically see B's screen (peek over the shoulder, through-wall camera) → in that scenario the attacker can usually **directly operate B as well**, again with no need to bypass SAS

In other words, **an attacker who can see B's screen almost certainly has a faster attack path than colliding with the SAS**. Using 8–10 characters to defend against an already-compromised endpoint costs the user a longer random string at every pairing — for no meaningful added security, only worse UX.

If there ever emerges a clear threat class of "can see screens but can't take data" (public displays, projector pairing, etc.), the SAS length can be made configurable without affecting the core protocol.

### Flow

```
A = existing (has masterSecret)
B = joiner  (fresh)

[Phase 1. A opens an ephemeral mailbox]
  1. A UI "add new device" → generate ephemeral (eA_pub, eA_sec)
  2. A composes pair_url = http://localhost:5173/pair#k=<base64url(eA_pub)>
     A simultaneously displays QR(pair_url) and the copyable pair_url text
     A opens an SSE stream on /pair-requests/hash(eA_pub)/subscribe
  3. Relay defaults mailbox TTL = 5 minutes; auto-destructs at expiry

[Phase 2. B receives eA_pub via QR or URL]
  4. The user picks one on B:
     (a) point the camera at A's QR → automatically opens pair_url; B's PWA recovers eA_pub from location.hash
     (b) paste pair_url into B's browser / PWA "add device" field → same result
  5. B generates ephemeral (eB_pub, eB_sec)
  6. B composes slot = sealed_box(JSON.stringify({ eB_pub, ts }), eA_pub)
  7. B POST /pair-requests/hash(eA_pub) { slot }
     ＊ Relay appends to that mailbox's slot array and returns slot_id
  8. B's screen shows SAS = sasCompute(eB_pub, bucket(now, 60s), 6)
     SAS is fixed for the bucket it was computed in; A accepts ±1 bucket
     of skew (≈3-minute total verify window) to tolerate input delay

[Phase 3. A receives candidates → enters SAS → filters]
  9. A receives a `slot` SSE event from /pair-requests/hash(eA_pub)/subscribe
     (and on first connect SSE replays any already-stored slots)
  10. A uses eA_sec to decryptSealedBox each slot, producing a candidate list
      candidates = [{ eB_pub_i, ts_i }, ...]
      An attacker's injected slot decrypts to garbage (sealed_box was encrypted to eA_pub; they don't have eA_sec)
      → only successful decryptions remain (already filters out unknown sources)
  11. A UI "please enter the 6-character code on the new device's screen"
  12. The user types the SAS
  13. For each candidate A computes expected_i = sasCompute(eB_pub_i, bucket(now ±1, 60s), 6)
      matched = candidates.filter(c => expected_i == typed_SAS)
  14. matched.length:
        0 → UI "no device matched, please verify the code" (allow retry)
        1 → adopt that eB_pub, proceed to Phase 4
        2+ → UI red alert "suspicious collision detected, pairing aborted", DELETE mailbox

[Phase 4. Deliver masterSecret]
  15. A composes blob = sealed_box(JSON.stringify({ masterSecret }), matched.eB_pub)
  16. A POST /pair-requests/hash(eA_pub) { blob, kind: 'secret' }
      (a new slot; B filters by slot.kind)
  17. B receives the kind='secret' slot via its own SSE subscription on
      /pair-requests/hash(eA_pub)/subscribe (also replayed on reconnect)
  18. B decryptSealedBox(blob, eB_sec) → masterSecret
  19. B derives the shared X25519 + Ed25519 keypair, writes to secureStorage
  20. B fetchMyMailbox → mergeSyncPayloads → done

[Phase 5. Destruction]
  21. A DELETE /pair-requests/hash(eA_pub) (proactive)
  22. Or relay auto-clears at TTL expiry
  23. Both sides destroy the ephemeral keypair
```

### Multi-slot mailbox schema (relay side)

```ts
// apps/relay/src/pairStore.ts
interface PairSlot {
  id: string;              // relay-assigned
  data: string;            // sealed_box ciphertext (anonymous)
  kind?: string;           // optional tag for client filtering
  createdAt: number;
}

interface PairMailbox {
  addr: string;            // hash(eA_pub)
  slots: PairSlot[];       // append-only, cap 64
  expiresAt: number;       // createdAt + 5min
}
```

- POST can only append (cannot overwrite an existing slot)
- GET returns the entire slots array (the client decrypts and filters)
- Each mailbox has a hard cap of 64 slots; further submissions are rejected (DoS flood protection)
- The mailbox itself has a 5-minute TTL; the entire structure is dropped at expiry

### Security analysis

| Attack | Defense |
|---|---|
| Passive observation of relay traffic | `masterSecret` and `eB_pub` both travel via sealed_box (encrypted to `eA_pub`); the attacker sees ciphertext but cannot decrypt |
| Attacker isn't physically near A and tries to find the in-flight mailbox via the relay | Mailbox address = `hash(eA_pub)`; without seeing the QR you cannot compute the address (256-bit entropy) |
| Attacker sees the QR (shoulder-surfing / long-lens camera) or intercepts the URL (clipboard / chat / history) | Can POST their own slot, but their pubkey's SAS doesn't match what B's screen displays → filtered out by A. QR and URL are equivalent at this layer |
| Attacker brute-force searches for a pubkey whose SAS collides | 6-character 32-symbol SAS = 30 bits ≈ 1.07 billion space. Under the normal threat model (attacker can't see B's screen) the attacker can only blind-shoot; with the 64-slot cap the chance of compromising a single pairing is 1/16.8M (17× rarer than the Powerball jackpot). See [SAS encoding and length](#sas-encoding-and-length) for the full discussion |
| Multiple candidates pass the SAS check | Treated as an attack; abort pairing and clear the mailbox — under normal flow there can never be two legitimate pubkeys |
| Relay forges or reorders slots | The relay can try, but a forged slot won't decrypt (sealed_box requires eA_sec); reordering doesn't affect SAS filtering |
| DoS flooding the mailbox | Per-mailbox hard cap of 64 slots + 5-minute TTL + per-IP rate limiting |

### No more endorsement propagation

Because the new PWA receives the actual `masterSecret`, **once pairing finishes it automatically belongs to the group**—the other members do not need to broadcast any "welcome the newcomer" message. The next time any member does a read-modify-write, the new PWA participates as a peer.

## Agent-side trust model

Quicksave's agent is not a peer in the PWA group; it is a **controlled endpoint**: it does not hold `masterSecret`, only its own locally generated X25519 + Ed25519 keypair, and it pins one shared pubkey from the PWA group as its upstream trust anchor. This is fundamentally different from Happy's "agent also stores the root secret" — a compromised agent here does not equal a compromised group.

### TOFU (Trust On First Use)

Already implemented in `apps/agent/src/connection/connection.ts` + `apps/agent/src/config.ts`:

1. The user runs `quicksave pair` on the agent host → the agent enters pairing mode and advertises its own pubkey (the existing invite flow)
2. The first PWA client to complete the handshake successfully is treated as the upstream trust anchor; the handshake envelope is signed by the client's shared Ed25519 key, and the agent only accepts after verifying it
3. The agent writes the **shared X25519 pubkey + shared Ed25519 signing pubkey** presented by that client into the agent config (the `peerPWAPublicKey` / `peerPWASignPublicKey` fields in `~/.quicksave/config.json`)
4. Subsequent handshakes must be signed with the **same signing pubkey**; otherwise they are refused (`handleKeyExchange` emits an error and drops the connection)

**Why TOFU is sufficient**: the agent's `quicksave pair` is locally and intentionally triggered by the user on the agent host — the user knows pairing mode is open right now, and the first thing to connect is the target PWA group. Same nature as SSH's known_hosts.

### Tombstone delivery channel: Push (primary) + Catch-up GET (fallback)

Key rotation is an **emergency event**: the PWA group triggers it usually because a device was just lost or `masterSecret` is suspected to have leaked. If an attacker holds an old `masterSecret`, all they need is to complete one handshake before a legitimate PWA notifies the agent in order to maintain access — so the agent must receive the tombstone **nearly instantly**. The agent–relay WS may stay connected for long stretches over a stable network, and relying solely on catch-up GET would have too much latency, so we use two channels:

1. **Push (pubsub) — primary path, propagates within seconds**
   - When the agent's signaling is `'connected'` and it is in the paired state, it sends `tombstone-subscribe { keyHash: hash(peerPWAPublicKey) }` (uncompressed JSON; different from the compressed agent↔agent path)
   - It also subscribes to the same mailbox immediately after a TOFU pin completes
   - On the relay side, the `TombstoneSubs` in `apps/relay/src/tombstoneSubs.ts` maintains `Map<keyHash, Set<WebSocket>>`
   - At subscribe time, if the mailbox already has a tombstone, the relay immediately pushes a `tombstone-event` (race-avoidance: if the rotate happened and was written before the agent subscribed, subscribing alone is enough to receive it)
   - When any PWA's `PUT /sync/{keyHash}/tombstone` succeeds, the `onTombstone` callback in `createSyncRouter` fires `tombstoneSubs.publish(keyHash, ciphertext)`, fanning out `{ type: 'tombstone-event', payload: { keyHash, data } }` to all subscribers
   - The agent's `SignalingClient` maintains the subscription set locally, and the WS automatically replays it on every `'open'` (so subscriptions aren't lost across relay restarts / network blips)
   - Signature verification is still done by the agent itself using the pinned `peerPWASignPublicKey` (`verifyTombstonePayload`); the relay merely passes data through and does not participate in trust decisions. If the relay injects garbage, the worst case is one extra verify failure on the agent — it cannot trigger self-destruct

2. **Catch-up GET — reliability backstop, propagates within at most 3 minutes**
   - Same module, `apps/agent/src/tombstoneCheck.ts`: `GET /sync/{keyHash}` and verify on connect to relay, and on a 180-second `setInterval` thereafter
   - Handles edge cases like the relay not pushing, the push being eaten by a proxy, or subscribing earlier than the tombstone write but the relay not re-sending
   - **If nothing comes back, treat it as nothing happened**: `status === 'absent'` or network errors are silently dropped (consistent with prior behavior)
   - The 3-minute upper bound is intentional: tighter intervals barely shorten latency once the push channel exists, but they create unnecessary GET pressure on the relay across healthy clusters

3. **Idempotency between the two channels**
   - `handlePushedTombstone` and `runTombstoneCheck` both converge to the same `handleVerifiedTombstone`
   - The first line of `handleVerifiedTombstone` checks `getState() === 'closed'` → returns immediately; the first execution of `clearPeerPWA()` persists `closed=true`, so any racing second or third invocation becomes a no-op
   - After entering closed, the agent also fires off one `tombstone-unsubscribe` (best-effort; even on failure the relay will `unsubscribeAll` automatically when the WS disconnects)

4. **Self-destruct side effects** (identical after both channels' signature verification)
   1. Clear `peerPWAPublicKey` / `peerPWASignPublicKey`
   2. **Rotate the agent's full identity**: `agentId`, X25519 `keyPair`, Ed25519 `signKeyPair` are all regenerated
   3. Persist `closed: true` to `~/.quicksave/config.json`
   4. Emit a `'tombstoned'` event

**Why `closed` must be persisted**: if it were only a runtime flag, after a daemon restart (crash, manual kill, OS reboot) the flag would clear, but at that point the config's `peerPWAPublicKey` is already cleared, so the state regresses to `unpaired` → the next handshake follows the TOFU path, and an attacker who already knew the old `agentId` could swoop in and pin themselves. Persistence + identity rotation form double insurance: a restart still yields `closed`, and even if the attacker holds the old `agentId`, they can't locate the current agent (the relay routing address has changed).

### Agent pairing state machine

`AgentPairState = 'unpaired' | 'paired' | 'closed'`:

| State | Determined by (config-side) | Inbound handshake |
|---|---|---|
| `unpaired` | `closed == false` and no `peerPWAPublicKey` | Accept the first signed envelope → TOFU pin |
| `paired` | `closed == false` and a `peerPWAPublicKey` exists | Only accept envelopes signed with the pinned signing key |
| `closed` | `closed == true` (persisted by `clearPeerPWA`) | Reject everything until `quicksave pair` is run |

`getState()` in `apps/agent/src/connection/connection.ts` re-reads `loadConfig()` on every call, so state changes from tombstone and unlock take effect immediately.

CLI surface:
- `quicksave status` — prints the current state + agentId + connectionState + peers + peerPWA pubkey
- `quicksave pair` — IPC `unlock-pairing` → `unlockPairingAndRotate()`:
  1. Clears the `closed` flag
  2. **Rotates `agentId` + X25519 + Ed25519** — the entire identity (every re-pair gets a fresh identity, severing all residual state from the previous pairing)
  3. `AgentConnection` tears down the current `SignalingClient` (`removeAllListeners` + `disconnect`) and re-establishes the connection under the new `agentId`; the next `get-pairing-info` returns the new `agentId` as the routing address
  4. The next signed handshake performs TOFU again

### Signaling control messages (agent ↔ relay)

The general data flow between agent and relay travels in compressed packets (`{ z: <gzip base64> }`); the tombstone subscription path uses **uncompressed** JSON because the relay's `onMessage` hook only parses plaintext control messages:

| Type | Direction | Payload | Semantics |
|---|---|---|---|
| `tombstone-subscribe` | agent → relay | `{ keyHash: string }` | Subscribe to tombstone push for that mailbox; if a tombstone already exists, the relay immediately echoes a `tombstone-event` |
| `tombstone-unsubscribe` | agent → relay | `{ keyHash: string }` | Best-effort unsubscribe; the relay also auto-cleans on WS disconnect |
| `tombstone-event` | relay → agent | `{ keyHash: string, data: string }` | A new tombstone write or the initial replay at subscribe time; `data` is the raw ciphertext (same format as the `data` field in catch-up GET) |

When the agent is offline it does not send the subscription (`SignalingClient.sendRaw` is a no-op), but `tombstoneSubscriptions` is fully replayed on the next WS `'open'`. This layer is decoupled from the higher-level `AgentConnection`'s subscription state — `AgentConnection` only re-subscribes when the "pinned peer changes."

## Device retirement and group reset

### Routine retirement (you still have the device)

"Retiring an old tablet / old browser" is correctly handled by **clearing that device's browser storage**: `masterSecret` and all synced data go with it, and the device can no longer decrypt the mailbox.

No protocol, no notification to other devices, no roster update. The other devices notice nothing — that's the intended behavior.

### Group reset (device lost / stolen)

A device falls into a third party's hands and the user wants a clean cut → rotate `masterSecret` for the entire group. The flow:

1. Any surviving PWA triggers `quicksave rotate-keys` (reuses the existing [tombstone mechanism](../plans/2026-02-16-pwa-identity-and-sync-design.md))
2. PUT a tombstone to the old mailbox `hash(shared_pubkey_old)` (`createTombstone` in `packages/shared/src/crypto.ts`), permanently locking that address
3. Every online agent receives `tombstone-event` within seconds via the [tombstone push channel](#tombstone-delivery-channel-push-primary--catch-up-get-fallback); after signature verification it immediately runs `clearPeerPWA()`. Agents that are offline or whose push was missed are caught the next time they connect to the relay, or by the 180-second catch-up GET. Side effects of `clearPeerPWA()`: clear peerPWA*, rotate agentId + X25519 + Ed25519, set `closed: true` (persisted to config)
4. Generate a new `masterSecret` and run the [Pairing Flow](#pairing-flow) again with the other surviving PWAs
5. Run `quicksave pair` (the agent-side CLI) on every agent → `unlockPairingAndRotate()` rotates the agent identity once more, clears `closed`, and TOFUs again at the new routing address

The cost is obvious (every agent needs to re-pair), but this is a low-frequency operation (only triggered by a lost device) and **it is simple and predictable**: there's no fuzzy "who got kicked but can still decrypt how many historical blobs" window. A key advantage is that the agent's self-destruct is **automatic** — there's no leftover trust window where "the PWA group has rotated but the agent still trusts the old key," nor a window of "agent restarts → an attacker grabs the old agentId via TOFU before legitimate pairing."

## Relay Layer Protections

| Mechanism | What it solves |
|---|---|
| Per-IP rate-limit on PUT / DELETE | Bulk DoS; sliding window (`apps/relay/src/index.ts: rateLimitOk`) |
| Single-slot mailbox + per-mailbox in-flight mutex (10s TTL) | Read-modify-write convergence; blocks attackers without `masterSecret` from squatting and harassing (combined with sig verify) |
| Ed25519 signature verify + TTL nonce cache on PUT / DELETE | Without the shared signing key the attacker cannot consume resources beyond the mutex / rate-limit budget; the nonce cache is shared across `/sync/*` actions to prevent replay |
| `extra=[keyHash, ciphertextHash]` in canonical body | Binds the envelope to a specific mailbox + specific payload; cannot be moved to another mailbox or have its content swapped |
| Tombstone (existing) | Locks the old mailbox during a group reset |

The relay remains **completely stateless** (in-memory map, restartable at any time). The cost of a restart: all mutexes are released, in-flight writes need client retry; mailbox content is rebuilt by the next push from paired devices.

## Differences from Happy Coder

| Aspect | Quicksave | Happy |
|---|---|---|
| Identity derivation | `masterSecret` → shared X25519 + Ed25519 | `secret` → shared Ed25519 (with challenge auth) |
| Relay architecture | Stateless; HTTP PUT/GET + mutex | Stateful; token-based auth, persistent session |
| Sender authentication | Per-PUT Ed25519 signature (stateless verification) | Pre-authenticated session token (verified once on connect) |
| Mailbox semantics | Shared single slot + per-mailbox mutex + LWW | Per-session push stream |
| PWA pairing | QR(ephemeral pubkey) + multi-slot mailbox + SAS filtering → sealed-box bootstrap | QR(ephemeral pubkey) → sealed-box bootstrap |
| What the agent stores | Its own keypair + **stored PWA pubkey** (TOFU; does not hold `masterSecret`) | The full `secret` (peer identity with the phone) |
| Agent on rotate | Self-destructs automatically (pubsub push primary + 180s catch-up GET fallback) | Not supported; user re-pairs manually |
| Notify the group after adding a device | Not needed (holding `masterSecret` = membership) | Not needed (same) |

There are two core differences:
1. **Relay philosophy**: Quicksave insists on a stateless relay; Happy accepts a stateful relay in exchange for a push experience.
2. **Agent trust model**: Quicksave's agent does not hold `masterSecret` and only pins one PWA pubkey via TOFU; a compromised agent ≠ a compromised group. Happy's agent holds the full secret, so a compromised agent = full account compromise. This is the substantive security improvement we make over Happy.

## Files Map

**Sync mailbox (steady state)**

| Change | File |
|---|---|
| Derive shared X25519 + Ed25519 keypair from `masterSecret` (helper) | `packages/shared/src/crypto.ts` |
| `SignedSyncEnvelope` schema + canonical body / sign helper | `packages/shared/src/syncEnvelope.ts` |
| Client-side envelope signing + 409 backoff retry (exponential, max 4 retries, max 5s, respects `Retry-After`) | `apps/pwa/src/lib/syncClient.ts` |
| Read-modify-write flow | `apps/pwa/src/lib/syncClient.ts` (orchestrated from `apps/pwa/src/App.tsx`) |
| Per-mailbox in-flight mutex (10s TTL, `tryAcquireLock/releaseLock/peekLock`) | `apps/relay/src/syncStore.ts` |
| Ed25519 verify + nonce cache + extra binding + routing | `apps/relay/src/sigVerify.ts`, `apps/relay/src/syncRoutes.ts` (`createSyncRouter`) |
| `POST /sync/{hash}/*` HTTP entrypoint | `apps/relay/src/index.ts` (wires up `parseSyncUrl` + `syncRouter.handle`) |
| Cancel route (`DELETE /sync/{hash}/lock`) | `apps/relay/src/syncRoutes.ts` (action `sync-lock-release`) |
| Dev middleware parity (strip envelope, support `/lock`; no signature verification) | `apps/pwa/vite-plugin-relay.ts` |
| Per-IP rate-limit middleware | `apps/relay/src/index.ts: rateLimitOk` |
| Removed: `PairedDevice` type, allowlist persistence, endorsement handling | `apps/pwa/src/stores/identityStore.ts` (drop `pairedDevices`-related fields) |

**PWA pairing (QR + SAS + multi-slot mailbox)**

| Change | File |
|---|---|
| `/pair-requests/{addr}` routes (POST append / GET all / DELETE / `/subscribe` SSE) | `apps/relay/src/index.ts` (`handlePairRequest`), `apps/relay/src/pairStore.ts` |
| Multi-slot mailbox structure (append-only, cap 64, TTL 5min) | `apps/relay/src/pairStore.ts` |
| SAS helper (`sasCompute(pubkey, bucket, 6)`, 32-symbol alphabet, ±1 bucket verify) | `packages/shared/src/crypto.ts` |
| Ephemeral keypair generation + pair URL composition + QR encoding + slot decryption / SAS filtering | `apps/pwa/src/lib/pairClient.ts` |
| HTTP/SSE transport for `/pair-requests/*` (POST/GET/DELETE + EventSource on `/subscribe`) | `apps/pwa/src/lib/httpPairTransport.ts` |
| `#/pair?k=<eA_pub>` HashRouter route, recover `eA_pub` from `location.hash`, deep-link handler | `apps/pwa/src/routes/JoinGroupPage.tsx` |
| Pairing UI (A side: QR + copyable URL + SAS input; B side: QR scan or paste URL + display SAS) | `apps/pwa/src/components/PairDeviceModal.tsx`, `apps/pwa/src/components/ScanToJoinModal.tsx`, `apps/pwa/src/components/DevicePairingSection.tsx` |

**Agent trust (TOFU + self-destruct)**

| Change | File |
|---|---|
| Agent config `peerPWAPublicKey` / `peerPWASignPublicKey` / persisted `closed` flag | `apps/agent/src/config.ts` |
| Identity rotation helpers (`clearPeerPWA` on tombstone; `unlockPairingAndRotate` on `quicksave pair`: rotate `agentId` + X25519 + Ed25519) | `apps/agent/src/config.ts` |
| Handshake mandatorily verifies peer signature against stored pubkey | `apps/agent/src/connection/connection.ts: handleKeyExchange` |
| Tombstone push channel (relay subscribe / event dispatch / disconnect cleanup) | `apps/relay/src/tombstoneSubs.ts` (`TombstoneSubs` class), `apps/relay/src/index.ts` (WS `tombstone-subscribe/-unsubscribe` handling + `onPeerDisconnect` cleanup), `apps/relay/src/syncRoutes.ts` (`onTombstone` callback fan-out in `createSyncRouter`) |
| Tombstone delivery: agent-side subscribe + signature verification + 180s periodic catch-up GET | `apps/agent/src/connection/relay.ts` (`SignalingClient.subscribeTombstone` / `unsubscribeTombstone` / `sendRaw` / reconnect replay), `apps/agent/src/connection/connection.ts` (`handlePushedTombstone` / `resubscribeIfPaired` / `startTombstonePolling`), `apps/agent/src/tombstoneCheck.ts` (`checkTombstone` + shared `verifyTombstonePayload`), `packages/shared/src/crypto.ts: verifyTombstone` |
| Self-destruct shared sink (identity rotation + `closed=true` + idempotency guard) | `apps/agent/src/connection/connection.ts: handleVerifiedTombstone` |
| Signaling control message types (`tombstone-subscribe` / `tombstone-unsubscribe` / `tombstone-event` + payload interfaces) | `packages/shared/src/types.ts` |
| State machine `getState()` (derived from config) + `unlockPairing()` (rotate + rebuild `SignalingClient`) | `apps/agent/src/connection/connection.ts` |
| IPC `get-agent-state` / `unlock-pairing` / `get-pairing-info` (all read fresh config) + CLI `status` / `pair` | `apps/agent/src/service/run.ts`, `apps/agent/src/index.ts` |

## Open Questions

1. **Relay persistence**: `SyncStore` is entirely in memory, wiped on restart. For the pairing flow this is a short-window disaster (if the relay restarts within the mailbox's 5-minute TTL, the user has to scan the QR from scratch); for steady-state sync the impact is smaller (rebuilt on the next read-modify-write). Do we need KV / R2 persistence?
2. ~~Relay tombstone pubsub reliability~~: now uses two channels — pubsub push for immediacy and catch-up GET (every 180s + on every `'connected'`) as the reliability backstop, both converging to the same idempotent sink.
3. **Automatic agent re-pair**: after a group reset every agent has to manually run `quicksave pair` from the CLI, which is annoying at scale. Could the agent print an invite URL to stdout / log after self-destructing so the PWA can scan and finish? The first version conservatively sticks with pure manual operation.
4. **Configurable SAS length**: the default 6 chars / 30 bits already covers the normal threat model (see [SAS encoding and length](#sas-encoding-and-length)). If a special scenario emerges where "the attacker can see the screen but cannot take data" (projector pairing, public displays, etc.), the `sasEncode` length parameter can be made configurable without changing the protocol.
5. **Pair URL handling in PWA installs**: can the deep link `http://localhost:5173/pair#k=...` directly invoke the PWA on a device with the PWA installed? Depends on the browser's support for `url_handlers` (Chrome has it; Safari is weaker). Fallback: if the PWA is not installed, the browser opens the web version of the pair flow directly.

## Maintenance

When you change any of the following, **update this document in the same change**:

- The sign / verify / encrypt / seed-keypair / SAS derivation in `packages/shared/src/crypto.ts`
- The `SignedSyncEnvelope` schema / canonical body / sign helper in `packages/shared/src/syncEnvelope.ts`
- The slot / mutex / in-flight structure in `apps/relay/src/syncStore.ts`
- `createSyncRouter` / `parseSyncUrl` / `/sync/*` dispatch in `apps/relay/src/syncRoutes.ts`
- The `/pair-requests/*` lifecycle in `apps/relay/src/pairStore.ts`
- The envelope schema, read-modify-write, or 409 backoff flow in `apps/pwa/src/lib/syncClient.ts` or `syncMerge.ts`
- The pairing flow in `apps/pwa/src/lib/pairClient.ts` + `apps/pwa/src/lib/httpPairTransport.ts` (ephemeral keypair generation, SAS computation, SSE subscription)
- The `peerPWA*` / `closed` fields and `clearPeerPWA` / `unlockPairingAndRotate` identity rotation in `apps/agent/src/config.ts`
- Handshake pubkey verification flow, `getState()` / `unlockPairing()` state machine, `handlePushedTombstone` / `resubscribeIfPaired` / `startTombstonePolling` in `apps/agent/src/connection/connection.ts`
- `subscribeTombstone` / `unsubscribeTombstone` / `sendRaw` / reconnect replay and `'tombstone-event'` handling in `apps/agent/src/connection/relay.ts`
- The shared `checkTombstone` / `verifyTombstonePayload` verification logic in `apps/agent/src/tombstoneCheck.ts`
- `TombstoneSubs` (subscription registry / publish fan-out / dead-socket cleanup) in `apps/relay/src/tombstoneSubs.ts`
- The `onTombstone` callback interface and `createSyncRouter` integration in `apps/relay/src/syncRoutes.ts`
- The `tombstone-subscribe` / `tombstone-unsubscribe` WS handlers, `onPeerDisconnect` cleanup, and `/stats` exposing tombstoneSubs in `apps/relay/src/index.ts`
- `SignalingMessageType` / `TombstoneSubscribePayload` / `TombstoneEventPayload` in `packages/shared/src/types.ts`
- Group reset / tombstone behavior (push primary + 180s catch-up GET fallback)
