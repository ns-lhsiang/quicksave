# PWA Identity, Device Sync, and Key Rotation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent PWA identity, encrypted device-to-device sync via signaling server mailboxes, and key rotation for both PWA and agent.

**Architecture:** Each PWA gets a persistent X25519 keypair as its identity. PWAs connect to the signaling server via a single persistent WebSocket addressed by public key. Messages include explicit `from`/`to` routing. An encrypted sync mailbox on the signaling server enables one-directional machine list sync between paired devices. Key rotation (agent or PWA) serves as the revocation mechanism.

**Tech Stack:** TweetNaCl.js (X25519, XSalsa20-Poly1305, Ed25519), Zustand + IndexedDB, WebSocket (ws), vitest

**Design doc:** `docs/plans/2026-02-16-pwa-identity-and-sync-design.md`

---

## Task 1: Shared Types — Routing, Sync, and Tombstone

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/types.test.ts` (new — optional, types are structural)

**Step 1: Add routed message envelope types**

In `packages/shared/src/types.ts`, add after the `KeyExchangeV2Ack` interface (line ~326):

```typescript
// --- Routed message envelope ---

export interface RoutedMessage {
  from: string;   // "pwa:{publicKey}" or "agent:{agentId}"
  to: string;     // "pwa:{publicKey}" or "agent:{agentId}"
  payload: string; // opaque string (encrypted or JSON)
}

// --- Sync types ---

export interface SyncBlob {
  encryptedData: string; // sealed-box encrypted backup v2 JSON
  timestamp: number;
}

export interface Tombstone {
  type: 'rotated';
  oldPublicKey: string;  // base64 X25519 public key
  signature: string;     // Ed25519 sign("rotated:{oldPublicKey}", oldSigningSecretKey)
}

export interface PairedDevice {
  publicKey: string;
  label: string;
  pairedAt: number;
}

// --- Signaling message types (extend existing) ---

export type SignalingMessageType =
  | 'peer-connected'
  | 'peer-offline'
  | 'data'
  | 'bye'
  | 'sync-updated'    // server notifies PWA that their mailbox was updated
  | 'error';
```

**Step 2: Add new signing-based crypto helpers to types for tombstone**

In `packages/shared/src/types.ts`, add to the `MessageType` union a new `'sync:push'` type. Actually — sync messages don't go through the Message protocol. They use the RoutedMessage envelope or HTTP. No changes needed to MessageType.

**Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add routed message, sync blob, tombstone, and paired device types"
```

---

## Task 2: Shared Crypto — Tombstone Signing and Encrypted Sync Blob

**Files:**
- Modify: `packages/shared/src/crypto.ts`
- Modify: `packages/shared/src/crypto.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export new functions)

**Step 1: Write failing tests for tombstone and sync blob crypto**

Add to `packages/shared/src/crypto.test.ts`:

```typescript
describe('tombstone signing', () => {
  it('should create and verify a valid tombstone', () => {
    const signingKeyPair = generateSigningKeyPair();
    const identityKeyPair = generateKeyPair();
    const publicKeyB64 = encodeBase64(identityKeyPair.publicKey);

    const tombstone = createTombstone(publicKeyB64, signingKeyPair.secretKey);

    expect(tombstone.type).toBe('rotated');
    expect(tombstone.oldPublicKey).toBe(publicKeyB64);
    expect(verifyTombstone(tombstone, signingKeyPair.publicKey)).toBe(true);
  });

  it('should reject a tombstone with wrong signing key', () => {
    const signingKeyPair = generateSigningKeyPair();
    const otherKeyPair = generateSigningKeyPair();
    const publicKeyB64 = encodeBase64(generateKeyPair().publicKey);

    const tombstone = createTombstone(publicKeyB64, signingKeyPair.secretKey);

    expect(verifyTombstone(tombstone, otherKeyPair.publicKey)).toBe(false);
  });
});

describe('sync blob encryption', () => {
  it('should encrypt and decrypt a sync blob', () => {
    const recipientKeyPair = generateKeyPair();
    const plaintext = JSON.stringify({
      version: 2,
      masterSecret: encodeBase64(nacl.randomBytes(32)),
      machines: [],
      exportedAt: new Date().toISOString(),
    });

    const encrypted = encryptSyncBlob(plaintext, recipientKeyPair.publicKey);
    const decrypted = decryptSyncBlob(encrypted, recipientKeyPair.secretKey);

    expect(decrypted).toBe(plaintext);
  });

  it('should fail to decrypt with wrong key', () => {
    const recipientKeyPair = generateKeyPair();
    const otherKeyPair = generateKeyPair();
    const plaintext = 'secret data';

    const encrypted = encryptSyncBlob(plaintext, recipientKeyPair.publicKey);

    expect(() => decryptSyncBlob(encrypted, otherKeyPair.secretKey)).toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/jimmy/workspace/quicksave && npx vitest run packages/shared/src/crypto.test.ts`
Expected: FAIL — `createTombstone`, `verifyTombstone`, `encryptSyncBlob`, `decryptSyncBlob` not defined

**Step 3: Implement the crypto helpers**

In `packages/shared/src/crypto.ts`, add after the `verify` function (line ~260):

```typescript
import type { Tombstone } from './types.js';

/**
 * Create a tombstone proving key rotation.
 * Signs the message "rotated:{oldPublicKey}" with an Ed25519 signing key.
 */
export function createTombstone(
  oldPublicKeyB64: string,
  signingSecretKey: Uint8Array
): Tombstone {
  const message = `rotated:${oldPublicKeyB64}`;
  const signature = sign(message, signingSecretKey);
  return {
    type: 'rotated',
    oldPublicKey: oldPublicKeyB64,
    signature,
  };
}

/**
 * Verify a tombstone's signature.
 */
export function verifyTombstone(
  tombstone: Tombstone,
  signingPublicKey: Uint8Array
): boolean {
  const message = `rotated:${tombstone.oldPublicKey}`;
  return verify(message, tombstone.signature, signingPublicKey);
}

/**
 * Encrypt a sync blob for a recipient using sealed-box pattern.
 * Reuses encryptDEK internally — works for any small payload, not just DEKs.
 */
export function encryptSyncBlob(
  plaintext: string,
  recipientPublicKey: Uint8Array
): string {
  const data = decodeUTF8(plaintext);
  return encryptDEK(data, recipientPublicKey);
}

/**
 * Decrypt a sync blob using the recipient's secret key.
 */
export function decryptSyncBlob(
  encrypted: string,
  mySecretKey: Uint8Array
): string {
  const data = decryptDEK(encrypted, mySecretKey);
  return encodeUTF8(data);
}
```

Note: `encryptDEK` works on `Uint8Array` payloads of any size (not just 32-byte DEKs). The sync blob is small (<8KB) so this is fine. If the backup data is larger, compress with gzip before encrypting.

**Step 4: Export new functions from `packages/shared/src/index.ts`**

Verify that `index.ts` re-exports all from `crypto.ts` (it likely already does via `export * from './crypto.js'`). If not, add the new function names.

**Step 5: Run tests to verify they pass**

Run: `cd /Users/jimmy/workspace/quicksave && npx vitest run packages/shared/src/crypto.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/shared/src/crypto.ts packages/shared/src/crypto.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add tombstone signing/verification and sync blob encryption"
```

---

## Task 3: Signaling Server — Sync HTTP Endpoints (PUT/GET /sync)

**Files:**
- Modify: `apps/signaling/src/index.ts` (add HTTP routes)
- Create: `apps/signaling/src/syncStore.ts` (in-memory blob + tombstone storage)
- Create: `apps/signaling/src/syncStore.test.ts`
- Modify: `tests/signaling.e2e.test.ts` (add sync endpoint tests)

**Step 1: Write the SyncStore unit tests**

Create `apps/signaling/src/syncStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SyncStore } from './syncStore.js';

describe('SyncStore', () => {
  let store: SyncStore;

  beforeEach(() => {
    store = new SyncStore({ maxBlobSize: 8192 });
  });

  it('should store and retrieve a blob', () => {
    store.put('abc123', 'encrypted-data');
    expect(store.get('abc123')).toEqual({ type: 'blob', data: 'encrypted-data' });
  });

  it('should return null for missing key', () => {
    expect(store.get('missing')).toBeNull();
  });

  it('should overwrite existing blob', () => {
    store.put('abc123', 'old-data');
    store.put('abc123', 'new-data');
    expect(store.get('abc123')).toEqual({ type: 'blob', data: 'new-data' });
  });

  it('should reject blobs exceeding max size', () => {
    const largeBlob = 'x'.repeat(8193);
    expect(() => store.put('abc123', largeBlob)).toThrow('exceeds max size');
  });

  it('should store a tombstone and block future writes', () => {
    store.putTombstone('abc123', '{"type":"rotated","oldPublicKey":"pk","signature":"sig"}');
    expect(store.get('abc123')).toEqual({
      type: 'tombstone',
      data: '{"type":"rotated","oldPublicKey":"pk","signature":"sig"}',
    });
    expect(() => store.put('abc123', 'new-data')).toThrow('tombstone');
  });

  it('should reject tombstone overwrite', () => {
    store.putTombstone('abc123', 'tombstone1');
    expect(() => store.putTombstone('abc123', 'tombstone2')).toThrow('tombstone');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/jimmy/workspace/quicksave && npx vitest run apps/signaling/src/syncStore.test.ts`
Expected: FAIL — module not found

**Step 3: Implement SyncStore**

Create `apps/signaling/src/syncStore.ts`:

```typescript
interface SyncEntry {
  data: string;
  isTombstone: boolean;
  updatedAt: number;
}

interface SyncStoreConfig {
  maxBlobSize: number; // bytes
}

export class SyncStore {
  private entries = new Map<string, SyncEntry>();
  private config: SyncStoreConfig;

  constructor(config: SyncStoreConfig = { maxBlobSize: 8192 }) {
    this.config = config;
  }

  get(keyHash: string): { type: 'blob' | 'tombstone'; data: string } | null {
    const entry = this.entries.get(keyHash);
    if (!entry) return null;
    return {
      type: entry.isTombstone ? 'tombstone' : 'blob',
      data: entry.data,
    };
  }

  put(keyHash: string, data: string): void {
    const existing = this.entries.get(keyHash);
    if (existing?.isTombstone) {
      throw new Error('Cannot write to key with tombstone');
    }
    if (data.length > this.config.maxBlobSize) {
      throw new Error(`Blob exceeds max size (${this.config.maxBlobSize} bytes)`);
    }
    this.entries.set(keyHash, {
      data,
      isTombstone: false,
      updatedAt: Date.now(),
    });
  }

  putTombstone(keyHash: string, data: string): void {
    const existing = this.entries.get(keyHash);
    if (existing?.isTombstone) {
      throw new Error('Tombstone already exists for this key');
    }
    this.entries.set(keyHash, {
      data,
      isTombstone: true,
      updatedAt: Date.now(),
    });
  }

  get stats() {
    let blobs = 0;
    let tombstones = 0;
    for (const entry of this.entries.values()) {
      if (entry.isTombstone) tombstones++;
      else blobs++;
    }
    return { blobs, tombstones, total: this.entries.size };
  }
}
```

**Step 4: Run SyncStore tests**

Run: `cd /Users/jimmy/workspace/quicksave && npx vitest run apps/signaling/src/syncStore.test.ts`
Expected: PASS

**Step 5: Add HTTP sync endpoints to signaling server**

In `apps/signaling/src/index.ts`, import SyncStore and add routes.

At the top, add: `import { SyncStore } from './syncStore.js';`

Create the store instance after the rate limiter: `const syncStore = new SyncStore();`

In the HTTP request handler (the `server.on('request', ...)` block starting at line ~18), add before the 404 fallback:

```typescript
// PUT /sync/:keyHash
if (req.method === 'PUT' && req.url?.startsWith('/sync/')) {
  const keyHash = req.url.slice('/sync/'.length);
  if (!keyHash || keyHash.length < 8 || keyHash.length > 64) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid key hash' }));
    return;
  }

  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    try {
      syncStore.put(keyHash, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('tombstone')) {
        // Return the tombstone data so the caller can verify it
        const entry = syncStore.get(keyHash);
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tombstone', tombstone: entry?.data }));
      } else if (message.includes('max size')) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    }
  });
  return;
}

// PUT /sync/:keyHash/tombstone
if (req.method === 'PUT' && req.url?.match(/^\/sync\/[a-zA-Z0-9_-]+\/tombstone$/)) {
  const keyHash = req.url.slice('/sync/'.length, req.url.lastIndexOf('/'));
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    try {
      syncStore.putTombstone(keyHash, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });
  return;
}

// GET /sync/:keyHash
if (req.method === 'GET' && req.url?.startsWith('/sync/')) {
  const keyHash = req.url.slice('/sync/'.length);
  if (!keyHash || keyHash.length < 8 || keyHash.length > 64) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid key hash' }));
    return;
  }

  const entry = syncStore.get(keyHash);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (entry.type === 'tombstone') {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'tombstone', data: entry.data }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'blob', data: entry.data }));
  return;
}
```

**Step 6: Add sync stats to the /stats endpoint**

In the `/stats` handler, add `syncStore: syncStore.stats` to the response.

**Step 7: Write E2E tests for sync endpoints**

Add to `tests/signaling.e2e.test.ts` or create a new `tests/sync.e2e.test.ts`:

```typescript
describe('sync endpoints', () => {
  it('PUT and GET a sync blob', async () => {
    const putRes = await fetch(`http://localhost:${port}/sync/testhash123`, {
      method: 'PUT',
      body: 'encrypted-blob-data',
    });
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`http://localhost:${port}/sync/testhash123`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.type).toBe('blob');
    expect(body.data).toBe('encrypted-blob-data');
  });

  it('returns 404 for missing key', async () => {
    const res = await fetch(`http://localhost:${port}/sync/doesnotexist`);
    expect(res.status).toBe(404);
  });

  it('tombstone blocks future writes and returns 410', async () => {
    // First put a blob
    await fetch(`http://localhost:${port}/sync/tombtest`, {
      method: 'PUT',
      body: 'some-data',
    });

    // Place tombstone
    const tombRes = await fetch(`http://localhost:${port}/sync/tombtest/tombstone`, {
      method: 'PUT',
      body: JSON.stringify({ type: 'rotated', oldPublicKey: 'pk', signature: 'sig' }),
    });
    expect(tombRes.status).toBe(200);

    // GET returns 410
    const getRes = await fetch(`http://localhost:${port}/sync/tombtest`);
    expect(getRes.status).toBe(410);

    // PUT returns 410
    const putRes = await fetch(`http://localhost:${port}/sync/tombtest`, {
      method: 'PUT',
      body: 'new-data',
    });
    expect(putRes.status).toBe(410);
  });
});
```

**Step 8: Run all signaling tests**

Run: `cd /Users/jimmy/workspace/quicksave && npx vitest run apps/signaling/ tests/`
Expected: PASS

**Step 9: Commit**

```bash
git add apps/signaling/src/syncStore.ts apps/signaling/src/syncStore.test.ts apps/signaling/src/index.ts tests/
git commit -m "feat(signaling): add sync mailbox endpoints with tombstone support"
```

---

## Task 4: Signaling Server — Explicit Message Routing

**Files:**
- Modify: `apps/signaling/src/index.ts`
- Modify: `apps/signaling/src/connections.ts`
- Modify: `apps/signaling/src/utils.ts`
- Modify: `apps/signaling/src/utils.test.ts`
- Modify: `tests/signaling.e2e.test.ts`

This is the most complex server change. Currently the server pairs by URL path and relays blindly. The new model supports:
- Agents still connect at `/agent/{agentId}` (unchanged)
- PWAs connect at `/pwa/{publicKey}` (new)
- Messages include `from`/`to` for routing
- PWA-to-PWA relay is supported

**Step 1: Update URL parsing in `utils.ts`**

The existing regex validates agentId as 8-64 chars `[a-zA-Z0-9_-]`. PWA public keys are base64-encoded (~44 chars). The same regex works.

Update the `ParsedUrl` interface to be more general:

```typescript
export interface ParsedUrl {
  role: 'agent' | 'pwa';
  id: string; // agentId for agents, publicKey for PWAs
}
```

Update `parseUrl` to return `id` instead of `agentId`.

**Step 2: Update ConnectionManager to track PWAs by public key**

In `apps/signaling/src/connections.ts`, the existing `pwas` map is keyed by `agentId`. Change it to support keying by either agentId (legacy) or publicKey (new):

Actually — the cleanest approach is to have TWO PWA maps:
- `pwasByAgent: Map<string, WebSocket>` — legacy, keyed by agentId (for backward compat)
- `pwasByKey: Map<string, WebSocket>` — new, keyed by publicKey

And a method to look up the right one based on the `to` field in a routed message.

Add to ConnectionManager:

```typescript
// New map for PWAs connecting by public key
private pwasByKey = new Map<string, WebSocket>();

addPwaByKey(publicKey: string, ws: WebSocket): void { ... }
removePwaByKey(publicKey: string): void { ... }
getPwaByKey(publicKey: string): WebSocket | undefined { ... }

// Route lookup: given a "to" string like "agent:xyz" or "pwa:abc", find the WebSocket
getByAddress(address: string): WebSocket | undefined {
  const [role, id] = address.split(':');
  if (role === 'agent') return this.getAgent(id);
  if (role === 'pwa') return this.getPwaByKey(id) || this.getPwa(id);
  return undefined;
}
```

**Step 3: Update signaling message relay logic**

In `apps/signaling/src/index.ts`, the message handler (line ~126) currently forwards blindly to the peer. Update it to:

1. Try to parse the message as JSON
2. If it has `from` and `to` fields (RoutedMessage), validate `from` matches sender, route to `to`
3. If it doesn't have routing fields, fall back to legacy behavior (blind relay to peer)

```typescript
ws.on('message', (data: RawData) => {
  // Rate limiting (unchanged)
  ...

  const raw = data.toString();

  // Try to parse as routed message
  try {
    const parsed = JSON.parse(raw);
    if (parsed.from && parsed.to) {
      // Validate 'from' matches sender identity
      const expectedFrom = ws.role === 'agent'
        ? `agent:${ws.agentId}`
        : `pwa:${ws.pwaKey || ws.agentId}`;
      if (parsed.from !== expectedFrom) {
        sendMessage(ws, { type: 'error', payload: { code: 'INVALID_FROM', message: 'from does not match connection identity' } });
        return;
      }

      // Route to target
      const target = connections.getByAddress(parsed.to);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(raw);
        connections.incrementMessagesRelayed();
      }
      // If target not found, silently drop (agent offline, etc.)
      return;
    }
  } catch {
    // Not JSON or not routed — fall through to legacy relay
  }

  // Legacy relay (unchanged)
  const peer = ws.role === 'agent'
    ? connections.getPwa(ws.agentId!)
    : connections.getAgent(ws.agentId!);
  if (peer && peer.readyState === WebSocket.OPEN) {
    peer.send(data);
    connections.incrementMessagesRelayed();
  }
});
```

**Step 4: Add `pwaKey` to ExtendedWebSocket**

```typescript
interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  role?: 'agent' | 'pwa';
  agentId?: string;   // for agents and legacy PWAs
  pwaKey?: string;     // for new PWA connections by public key
  messageCount: number;
  lastMessageReset: number;
  ip: string;
}
```

**Step 5: Handle new PWA connections by public key**

In the connection handler, detect whether a PWA is connecting with a public key (longer than typical agentId, or a specific path prefix like `/pwa/key/`). Simplest approach: use URL length or a heuristic. Since base64-encoded X25519 public keys are exactly 44 chars and agent IDs are 22 chars, we can distinguish by length. But this is fragile.

Better approach: add a new path prefix `/pwa/key/{publicKey}` for new-style connections, keeping `/pwa/{agentId}` for legacy. Update `parseUrl`:

```typescript
export interface ParsedUrl {
  role: 'agent' | 'pwa';
  id: string;
  isPwaKey?: boolean; // true if connected as /pwa/key/{publicKey}
}

// Updated regex to handle both formats
const LEGACY_PATTERN = /^\/(agent|pwa)\/([a-zA-Z0-9_-]+)$/;
const PWA_KEY_PATTERN = /^\/pwa\/key\/([a-zA-Z0-9_+/=-]+)$/;
```

**Step 6: Notify PWA of sync updates via WebSocket**

When a `PUT /sync/{keyHash}` succeeds, the server can optionally notify connected PWAs. Add a lookup: hash each connected PWA's key and check if it matches the keyHash. If so, send `{ type: 'sync-updated' }` over the WebSocket.

This is an optimization — PWAs can also poll on connect. Implement it as a nice-to-have.

**Step 7: Update tests**

Update `apps/signaling/src/utils.test.ts` for the new `ParsedUrl` shape and PWA key paths.

Add E2E tests for routed messages in `tests/signaling.e2e.test.ts`:

```typescript
describe('routed messages', () => {
  it('should route a message from PWA to agent by from/to fields', async () => {
    // Connect agent and PWA
    // PWA sends { from: "pwa:pk1", to: "agent:agentId", payload: "hello" }
    // Agent receives the message
  });

  it('should route PWA-to-PWA messages', async () => {
    // Connect two PWAs by key
    // PWA1 sends { from: "pwa:pk1", to: "pwa:pk2", payload: "pairing data" }
    // PWA2 receives the message
  });

  it('should reject messages with mismatched from field', async () => {
    // PWA sends message with wrong 'from'
    // Should receive error
  });
});
```

**Step 8: Run all tests**

Run: `cd /Users/jimmy/workspace/quicksave && npx vitest run apps/signaling/ tests/`
Expected: PASS

**Step 9: Commit**

```bash
git add apps/signaling/ tests/
git commit -m "feat(signaling): add explicit message routing with from/to fields and PWA key connections"
```

---

## Task 5: PWA — Identity Store

**Files:**
- Create: `apps/pwa/src/stores/identityStore.ts`
- Modify: `apps/pwa/src/lib/secureStorage.ts` (add identity key storage)

**Step 1: Add identity key persistence to secureStorage**

In `apps/pwa/src/lib/secureStorage.ts`, add new functions after the existing API key functions:

```typescript
const IDENTITY_KEY = 'identity-keypair';
const SIGNING_KEY = 'signing-keypair';
const PAIRED_DEVICES_KEY = 'paired-devices';
const IS_SOURCE_KEY = 'is-source';

export async function getIdentityKeyPair(): Promise<{ publicKey: string; secretKey: string } | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(IDENTITY_KEY);
    request.onsuccess = () => resolve(request.result?.value || null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveIdentityKeyPair(keyPair: { publicKey: string; secretKey: string }): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put({ key: IDENTITY_KEY, value: keyPair });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getSigningKeyPair(): Promise<{ publicKey: string; secretKey: string } | null> {
  // Same pattern as above with SIGNING_KEY
}

export async function saveSigningKeyPair(keyPair: { publicKey: string; secretKey: string }): Promise<void> {
  // Same pattern
}

export async function clearIdentityKeys(): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(IDENTITY_KEY);
    store.delete(SIGNING_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

**Step 2: Create identityStore**

Create `apps/pwa/src/stores/identityStore.ts`:

```typescript
import { create } from 'zustand';
import {
  generateKeyPair,
  generateSigningKeyPair,
  encodeKeyPair,
  decodeKeyPair,
  encodeBase64,
} from '@sumicom/quicksave-shared';
import type { PairedDevice } from '@sumicom/quicksave-shared';
import {
  getIdentityKeyPair,
  saveIdentityKeyPair,
  getSigningKeyPair,
  saveSigningKeyPair,
  clearIdentityKeys,
} from '../lib/secureStorage.js';

interface IdentityState {
  publicKey: string | null;       // base64 X25519 public key
  isSource: boolean;
  pairedDevices: PairedDevice[];
  initialized: boolean;

  // Actions
  initialize: () => Promise<void>;
  addPairedDevice: (device: PairedDevice) => void;
  removePairedDevice: (publicKey: string) => void;
  setIsSource: (isSource: boolean) => void;
  getSecretKey: () => Promise<Uint8Array | null>;
  getSigningSecretKey: () => Promise<Uint8Array | null>;
  getSigningPublicKey: () => Promise<Uint8Array | null>;
  rotateIdentity: () => Promise<{ oldPublicKey: string; oldSigningSecretKey: Uint8Array } | null>;
  clearAll: () => Promise<void>;
}

export const useIdentityStore = create<IdentityState>((set, get) => ({
  publicKey: null,
  isSource: false,
  pairedDevices: [],
  initialized: false,

  initialize: async () => {
    let stored = await getIdentityKeyPair();
    if (!stored) {
      // First use — generate and persist
      const keyPair = generateKeyPair();
      const encoded = encodeKeyPair(keyPair);
      await saveIdentityKeyPair(encoded);
      stored = encoded;

      const signingKeyPair = generateSigningKeyPair();
      const encodedSigning = encodeKeyPair(signingKeyPair);
      await saveSigningKeyPair(encodedSigning);
    }

    // Load paired devices from localStorage
    const savedDevices = localStorage.getItem('quicksave-paired-devices');
    const savedIsSource = localStorage.getItem('quicksave-is-source');

    set({
      publicKey: stored.publicKey,
      pairedDevices: savedDevices ? JSON.parse(savedDevices) : [],
      isSource: savedIsSource === 'true',
      initialized: true,
    });
  },

  addPairedDevice: (device) => {
    set((state) => {
      const updated = [...state.pairedDevices.filter(d => d.publicKey !== device.publicKey), device];
      localStorage.setItem('quicksave-paired-devices', JSON.stringify(updated));
      return { pairedDevices: updated };
    });
  },

  removePairedDevice: (publicKey) => {
    set((state) => {
      const updated = state.pairedDevices.filter(d => d.publicKey !== publicKey);
      localStorage.setItem('quicksave-paired-devices', JSON.stringify(updated));
      return { pairedDevices: updated };
    });
  },

  setIsSource: (isSource) => {
    localStorage.setItem('quicksave-is-source', String(isSource));
    set({ isSource });
  },

  getSecretKey: async () => {
    const stored = await getIdentityKeyPair();
    if (!stored) return null;
    const decoded = decodeKeyPair(stored);
    return decoded.secretKey;
  },

  getSigningSecretKey: async () => {
    const stored = await getSigningKeyPair();
    if (!stored) return null;
    const decoded = decodeKeyPair(stored);
    return decoded.secretKey;
  },

  getSigningPublicKey: async () => {
    const stored = await getSigningKeyPair();
    if (!stored) return null;
    const decoded = decodeKeyPair(stored);
    return decoded.publicKey;
  },

  rotateIdentity: async () => {
    const oldIdentity = await getIdentityKeyPair();
    const oldSigning = await getSigningKeyPair();
    if (!oldIdentity || !oldSigning) return null;

    const oldSigningDecoded = decodeKeyPair(oldSigning);

    // Generate new keys
    const newKeyPair = generateKeyPair();
    const newSigning = generateSigningKeyPair();
    await saveIdentityKeyPair(encodeKeyPair(newKeyPair));
    await saveSigningKeyPair(encodeKeyPair(newSigning));

    set({
      publicKey: encodeBase64(newKeyPair.publicKey),
      pairedDevices: [],
      isSource: false,
    });
    localStorage.removeItem('quicksave-paired-devices');
    localStorage.removeItem('quicksave-is-source');

    return {
      oldPublicKey: oldIdentity.publicKey,
      oldSigningSecretKey: oldSigningDecoded.secretKey,
    };
  },

  clearAll: async () => {
    await clearIdentityKeys();
    localStorage.removeItem('quicksave-paired-devices');
    localStorage.removeItem('quicksave-is-source');
    set({
      publicKey: null,
      pairedDevices: [],
      isSource: false,
      initialized: false,
    });
  },
}));
```

**Step 3: Initialize identity store on app startup**

In `apps/pwa/src/App.tsx`, add an effect in the `AppContent` component:

```typescript
const { initialize: initIdentity, publicKey: identityPublicKey } = useIdentityStore();

useEffect(() => {
  initIdentity();
}, [initIdentity]);
```

**Step 4: Commit**

```bash
git add apps/pwa/src/stores/identityStore.ts apps/pwa/src/lib/secureStorage.ts apps/pwa/src/App.tsx
git commit -m "feat(pwa): add identity store with persistent X25519 keypair and paired devices"
```

---

## Task 6: PWA — Refactor WebSocketClient for Persistent Connection with Routing

**Files:**
- Modify: `apps/pwa/src/lib/websocket.ts`
- Modify: `apps/pwa/src/App.tsx`
- Modify: `apps/pwa/src/stores/connectionStore.ts`

This is the largest and most complex PWA change. The WebSocketClient currently creates one WebSocket per agent connection. The new model uses a single persistent WebSocket addressed by the PWA's public key, with explicit routing per message.

**Step 1: Redesign WebSocketClient**

The refactored `WebSocketClient` should:
- Connect once to `/pwa/key/{identityPublicKey}`
- Maintain multiple active agent sessions (each with its own DEK)
- Route all messages with `from`/`to` fields
- Support receiving PWA-to-PWA relay messages for device pairing

Key internal structure:

```typescript
interface AgentSession {
  agentId: string;
  agentPublicKey: Uint8Array;
  sessionDEK: Uint8Array | null;
  keyExchangeComplete: boolean;
  keyPair: KeyPair; // ephemeral per session
}

class WebSocketClient {
  private ws: WebSocket | null = null;
  private identityPublicKey: string;
  private signalingServer: string;
  private sessions = new Map<string, AgentSession>(); // keyed by agentId
  private activeAgentId: string | null = null;
  private eventHandlers: ConnectionEventHandler;

  constructor(signalingServer: string, identityPublicKey: string, handlers: ConnectionEventHandler) { ... }

  connect(): Promise<void> { /* connects to /pwa/key/{identityPublicKey} */ }

  connectToAgent(agentId: string, agentPublicKey: string): void {
    // Create a new AgentSession, initiate key exchange
    // Messages are routed with from: "pwa:{identityPublicKey}", to: "agent:{agentId}"
  }

  disconnectFromAgent(agentId: string): void { /* cleanup session */ }

  send(message: Message): void {
    // Encrypts with active session's DEK, wraps in RoutedMessage envelope
  }

  private handleMessage(rawData: string): void {
    // Parse RoutedMessage, extract 'from' to determine which session
    // Or handle signaling messages (peer-connected, sync-updated, etc.)
    // Or handle PWA-to-PWA messages for pairing
  }
}
```

**Step 2: Update App.tsx handleConnect**

The `handleConnect` function currently creates a new `WebSocketClient` per agent. Refactor to:
- Create the WebSocketClient once (on app startup, using identity public key)
- `handleConnect` calls `client.connectToAgent(agentId, publicKey)` on the existing client

```typescript
// Create client once
const clientRef = useRef<WebSocketClient | null>(null);

useEffect(() => {
  if (identityPublicKey && !clientRef.current) {
    const client = new WebSocketClient(signalingServer, identityPublicKey, handlers);
    client.connect();
    clientRef.current = client;
  }
  return () => {
    clientRef.current?.disconnect();
    clientRef.current = null;
  };
}, [identityPublicKey, signalingServer]);

const handleConnect = useCallback(async (agentId: string, publicKey: string) => {
  clientRef.current?.connectToAgent(agentId, publicKey);
}, []);
```

**Step 3: Update connectionStore**

Remove `agentPublicKey` from the store (it's now per-session inside WebSocketClient). Keep `agentId` to track which agent is currently active in the UI.

**Step 4: Test manually**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm dev`
- Verify PWA connects to signaling server with identity public key
- Verify connecting to an agent still works (key exchange, handshake)
- Verify switching between agents works

**Step 5: Commit**

```bash
git add apps/pwa/src/lib/websocket.ts apps/pwa/src/App.tsx apps/pwa/src/stores/connectionStore.ts
git commit -m "refactor(pwa): single persistent WebSocket with routed agent sessions"
```

---

## Task 7: PWA — Sync Client (Push and Receive)

**Files:**
- Create: `apps/pwa/src/lib/syncClient.ts`
- Modify: `apps/pwa/src/stores/machineStore.ts` (add overwrite method)
- Modify: `apps/pwa/src/App.tsx` (wire sync on machine list changes)

**Step 1: Create syncClient**

Create `apps/pwa/src/lib/syncClient.ts`:

```typescript
import {
  encryptSyncBlob,
  decryptSyncBlob,
  decodeBase64,
  encodeBase64,
  createTombstone,
  verifyTombstone,
} from '@sumicom/quicksave-shared';
import type { Tombstone, PairedDevice } from '@sumicom/quicksave-shared';
import type { Machine } from '../stores/machineStore.js';

interface SyncPayload {
  version: 2;
  masterSecret: string;
  apiKey?: string;
  machines: Machine[];
  exportedAt: string;
}

function hashPublicKey(publicKey: string): string {
  // Simple hash for URL — SHA-256 truncated, or just use the key as-is
  // For now, use base64url-safe version of the key
  return publicKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export class SyncClient {
  private signalingServer: string;

  constructor(signalingServer: string) {
    // Convert ws:// to http:// for REST calls
    this.signalingServer = signalingServer
      .replace('wss://', 'https://')
      .replace('ws://', 'http://');
  }

  async pushToDevice(
    payload: SyncPayload,
    recipientPublicKey: string,
    recipientPublicKeyBytes: Uint8Array
  ): Promise<'ok' | 'tombstone'> {
    const plaintext = JSON.stringify(payload);
    const encrypted = encryptSyncBlob(plaintext, recipientPublicKeyBytes);
    const keyHash = hashPublicKey(recipientPublicKey);

    const res = await fetch(`${this.signalingServer}/sync/${keyHash}`, {
      method: 'PUT',
      body: encrypted,
    });

    if (res.status === 410) return 'tombstone';
    if (!res.ok) throw new Error(`Sync push failed: ${res.status}`);
    return 'ok';
  }

  async fetchMyMailbox(
    myPublicKey: string,
    mySecretKey: Uint8Array
  ): Promise<{ type: 'blob'; payload: SyncPayload } | { type: 'tombstone'; tombstone: string } | null> {
    const keyHash = hashPublicKey(myPublicKey);
    const res = await fetch(`${this.signalingServer}/sync/${keyHash}`);

    if (res.status === 404) return null;

    const body = await res.json();

    if (res.status === 410 || body.type === 'tombstone') {
      return { type: 'tombstone', tombstone: body.data };
    }

    const decrypted = decryptSyncBlob(body.data, mySecretKey);
    return { type: 'blob', payload: JSON.parse(decrypted) };
  }

  async postTombstone(
    publicKey: string,
    signingSecretKey: Uint8Array
  ): Promise<void> {
    const tombstone = createTombstone(publicKey, signingSecretKey);
    const keyHash = hashPublicKey(publicKey);

    const res = await fetch(`${this.signalingServer}/sync/${keyHash}/tombstone`, {
      method: 'PUT',
      body: JSON.stringify(tombstone),
    });

    if (!res.ok) throw new Error(`Tombstone post failed: ${res.status}`);
  }
}
```

**Step 2: Add `overwriteMachines` to machineStore**

In `apps/pwa/src/stores/machineStore.ts`, add a new action:

```typescript
overwriteMachines: (machines: Machine[]) => void;

// Implementation:
overwriteMachines: (machines) => set({ machines }),
```

**Step 3: Wire sync into App.tsx**

Add a sync effect that:
- On app startup (after identity init), checks own mailbox
- If blob found: overwrites local machine list
- If tombstone found: wipes everything, shows re-pair guide
- When machine list changes (and this device is source): pushes to all paired devices

```typescript
// In AppContent:
const syncClient = useMemo(() => new SyncClient(signalingServer), [signalingServer]);
const { publicKey, pairedDevices, isSource, getSecretKey } = useIdentityStore();
const { machines } = useMachineStore();

// Check mailbox on startup
useEffect(() => {
  if (!publicKey) return;
  (async () => {
    const secretKey = await getSecretKey();
    if (!secretKey) return;
    const result = await syncClient.fetchMyMailbox(publicKey, secretKey);
    if (result?.type === 'blob') {
      overwriteMachines(result.payload.machines);
      if (result.payload.apiKey) await saveApiKey(result.payload.apiKey);
      if (result.payload.masterSecret) await importMasterSecret(result.payload.masterSecret);
    } else if (result?.type === 'tombstone') {
      // Wipe and show re-pair guide
      await clearAll();
    }
  })();
}, [publicKey]);

// Push on machine list changes (if source)
useEffect(() => {
  if (!isSource || pairedDevices.length === 0) return;
  (async () => {
    const masterSecret = await exportMasterSecret();
    const apiKey = await getApiKey();
    const payload = { version: 2, masterSecret, apiKey, machines, exportedAt: new Date().toISOString() };
    for (const device of pairedDevices) {
      const result = await syncClient.pushToDevice(payload, device.publicKey, decodeBase64(device.publicKey));
      if (result === 'tombstone') {
        removePairedDevice(device.publicKey);
      }
    }
  })();
}, [machines, isSource, pairedDevices]);
```

**Step 4: Commit**

```bash
git add apps/pwa/src/lib/syncClient.ts apps/pwa/src/stores/machineStore.ts apps/pwa/src/App.tsx
git commit -m "feat(pwa): add sync client with mailbox fetch, push, and tombstone handling"
```

---

## Task 8: PWA — Device Pairing UI

**Files:**
- Modify: `apps/pwa/src/components/SettingsPanel.tsx`
- Modify: `apps/pwa/src/components/QRScanner.tsx`
- Create: `apps/pwa/src/components/DevicePairingSection.tsx`

**Step 1: Update QRScanner to handle pairing QR codes**

In `apps/pwa/src/components/QRScanner.tsx`, update the `QRScannerProps`:

```typescript
interface QRScannerProps {
  onScan: (agentId: string, publicKey: string) => void;
  onPairingScan?: (publicKey: string) => void; // new — for /pair?pk=... URLs
  onError?: (error: string) => void;
}
```

Update `handleScan` to detect `/pair` URLs:

```typescript
// In handleScan, after URL parsing:
if (url.pathname === '/pair' || url.pathname.endsWith('/pair')) {
  const pk = url.searchParams.get('pk');
  if (pk && onPairingScan) {
    onPairingScan(pk);
    return;
  }
}
```

**Step 2: Create DevicePairingSection component**

Create `apps/pwa/src/components/DevicePairingSection.tsx`:

This component shows:
1. "My Identity" — public key display, QR code button (to be scanned by source device)
2. "Pair with device" — QR scanner to scan another device's public key
3. "Paired Devices" — list of paired devices with remove button
4. "Rotate Identity" — danger button that posts tombstone and wipes local data

Use `qrcode` library (or a React QR component) to show the PWA's public key as a QR code with URL format: `http://localhost:5173/pair?pk={publicKey}`

The "Scan to pair" flow:
- Source device scans target's QR
- Calls `identityStore.addPairedDevice({ publicKey: scannedPk, label, pairedAt: Date.now() })`
- Sets `isSource = true`
- Immediately pushes sync blob to the new device's mailbox

The "Rotate Identity" flow:
- Calls `identityStore.rotateIdentity()` → returns old keys
- Posts tombstone to `/sync/{hash(oldPubKey)}/tombstone`
- Wipes all local data (machines, API key, master secret, paired devices)
- Reconnects WebSocket with new identity
- Shows "Scan a trusted device to restore your data"

**Step 3: Add DevicePairingSection to SettingsPanel**

In `apps/pwa/src/components/SettingsPanel.tsx`, add a new section after the Primary Key section:

```typescript
<DevicePairingSection
  signalingServer={signalingServer}
  onWipe={() => {
    // Navigate back to setup, clear stores
  }}
/>
```

**Step 4: Test manually**

- Open PWA on two browsers
- Device A: open Settings → shows QR code with identity
- Device B: open Settings → scan Device A's QR
- Device B becomes source, pushes machine list to A
- Device A's machine list updates
- Add a new machine on Device B → Device A sees it after refresh

**Step 5: Commit**

```bash
git add apps/pwa/src/components/DevicePairingSection.tsx apps/pwa/src/components/SettingsPanel.tsx apps/pwa/src/components/QRScanner.tsx
git commit -m "feat(pwa): add device pairing UI with QR code, sync push, and identity rotation"
```

---

## Task 9: Agent — rotate-keys CLI Command

**Files:**
- Modify: `apps/agent/src/index.ts`
- Modify: `apps/agent/src/config.ts`

**Step 1: Add `rotateKeyPair` to config.ts**

In `apps/agent/src/config.ts`, add:

```typescript
export function rotateKeyPair(): AgentConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('No config found. Run the agent first to generate a config.');
  }
  const newKeyPair = generateKeyPair();
  config.keyPair = encodeKeyPair(newKeyPair);
  saveConfig(config);
  return config;
}
```

**Step 2: Add the `rotate-keys` command to index.ts**

In `apps/agent/src/index.ts`, add a new subcommand after the main action:

```typescript
program
  .command('rotate-keys')
  .description('Generate a new keypair (invalidates all existing PWA connections)')
  .action(() => {
    try {
      const config = rotateKeyPair();
      console.log('\nKey pair rotated successfully.\n');
      console.log(`  Agent ID:    ${config.agentId} (unchanged)`);
      console.log(`  Public Key:  ${config.keyPair.publicKey} (NEW)\n`);
      console.log('All existing PWA connections are now invalid.');
      console.log('Re-scan the QR code on your trusted devices to reconnect.\n');
      displayConnectionInfo(config.agentId, config.keyPair.publicKey, true);
    } catch (err) {
      console.error('Failed to rotate keys:', (err as Error).message);
      process.exit(1);
    }
  });
```

**Step 3: Test manually**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm dev:agent -- rotate-keys`
Expected: Prints new public key and QR code.

Verify `~/.quicksave/agent.json` has the new keypair but same agentId.

**Step 4: Commit**

```bash
git add apps/agent/src/index.ts apps/agent/src/config.ts
git commit -m "feat(agent): add rotate-keys CLI command for key revocation"
```

---

## Task 10: Update Vite Dev Plugin for New Signaling Routes

**Files:**
- Modify: `apps/pwa/vite-plugin-signaling.ts`

**Step 1: Update the dev plugin to handle new WebSocket paths**

The Vite dev plugin intercepts HTTP upgrade requests for WebSocket paths. Update it to also handle `/pwa/key/` paths and the `/sync/` HTTP routes.

Check the current plugin and extend its URL matching to include:
- `/pwa/key/{publicKey}` WebSocket upgrades
- `/sync/{keyHash}` HTTP routes (PUT/GET)
- `/sync/{keyHash}/tombstone` HTTP routes (PUT)

**Step 2: Test in dev mode**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm dev`
- Verify the signaling server embedded in Vite handles new routes
- Verify both legacy `/pwa/{agentId}` and new `/pwa/key/{publicKey}` paths work

**Step 3: Commit**

```bash
git add apps/pwa/vite-plugin-signaling.ts
git commit -m "feat(pwa): update vite dev plugin for new signaling routes and sync endpoints"
```

---

## Task 11: Integration Testing and Cleanup

**Files:**
- Modify: `tests/signaling.e2e.test.ts`
- Review all modified files for consistency

**Step 1: Write E2E test for full pairing + sync flow**

```typescript
describe('device pairing and sync', () => {
  it('full flow: pair two PWAs, sync machine list, handle tombstone', async () => {
    // 1. PWA-A connects by key, PWA-B connects by key
    // 2. PWA-A pushes sync blob to PWA-B's mailbox
    // 3. PWA-B fetches mailbox, gets the blob
    // 4. PWA-B rotates key, posts tombstone
    // 5. PWA-A tries to push to old mailbox, gets 410
    // 6. PWA-A removes PWA-B from paired devices
  });
});
```

**Step 2: Run all tests**

Run: `cd /Users/jimmy/workspace/quicksave && npx vitest run`
Expected: All PASS

**Step 3: Test full flow manually**

1. Start agent: `pnpm dev:agent -- -r .`
2. Open PWA in Chrome
3. Scan agent QR, verify connection works
4. Open PWA in Firefox (second device)
5. Chrome: Settings → show identity QR
6. Firefox: Settings → scan Chrome's QR → pair
7. Verify Firefox receives Chrome's machine list
8. Add a new agent in Chrome → verify it appears in Firefox
9. Firefox: Settings → Rotate Identity → verify local data wiped
10. Chrome: verify next sync push detects tombstone, removes Firefox from paired devices
11. Agent: `quicksave rotate-keys` → verify both PWAs disconnect, re-scan works

**Step 4: Commit**

```bash
git add tests/
git commit -m "test: add E2E tests for device pairing, sync, and tombstone flow"
```

---

## Summary of Tasks

| # | Task | Files | Estimated Complexity |
|---|------|-------|---------------------|
| 1 | Shared types (routing, sync, tombstone) | `packages/shared/src/types.ts` | Small |
| 2 | Shared crypto (tombstone + sync blob) | `packages/shared/src/crypto.ts`, tests | Small |
| 3 | Signaling sync endpoints (PUT/GET) | `apps/signaling/`, new `syncStore.ts` | Medium |
| 4 | Signaling explicit routing | `apps/signaling/`, connections, utils | Large |
| 5 | PWA identity store | New `identityStore.ts`, `secureStorage.ts` | Medium |
| 6 | PWA WebSocketClient refactor | `websocket.ts`, `App.tsx`, `connectionStore.ts` | Large |
| 7 | PWA sync client (push/receive) | New `syncClient.ts`, `machineStore.ts` | Medium |
| 8 | PWA device pairing UI | New `DevicePairingSection.tsx`, `SettingsPanel.tsx` | Medium |
| 9 | Agent rotate-keys command | `index.ts`, `config.ts` | Small |
| 10 | Vite dev plugin update | `vite-plugin-signaling.ts` | Small |
| 11 | Integration testing + cleanup | E2E tests | Medium |
