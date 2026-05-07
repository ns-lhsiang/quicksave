// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRelay } from '@sumicom/ws-relay';
import type { RelayInstance } from '@sumicom/ws-relay';
import http from 'http';
import nacl from 'tweetnacl';
import {
  createSignedSyncEnvelope,
  type SignedSyncEnvelope,
  type SyncEnvelopeAction,
} from '@sumicom/quicksave-shared';
import { SyncStore } from './syncStore.js';
import { createSyncRouter, parseSyncUrl } from './syncRoutes.js';

// ── Test harness ────────────────────────────────────────────────────────────

const TEST_PORT = 18092;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Boot a single relay for the whole file. The SyncStore is shared across
// tests; each test uses a fresh random `keyHash` so they don't interfere.
let relay: RelayInstance;
let syncStore: SyncStore;

beforeAll(async () => {
  syncStore = new SyncStore({ maxBlobSize: 8192 });
  const router = createSyncRouter({ store: syncStore });

  relay = createRelay({
    port: TEST_PORT,
    keyStore: false,
    blobStore: false,
    channels: [{ name: 'agent', onDuplicate: 'reject' }],
    hooks: {
      onHttpRequest(req, res, next) {
        const sync = parseSyncUrl(req.url);
        if (sync) {
          router.handle(req, res, sync.keyHash, sync.subpath);
          return;
        }
        next();
      },
    },
  });
});

afterAll(async () => {
  relay.close();
  await new Promise<void>((resolve) => relay.server.close(() => resolve()));
});

// ── Fetch helper ────────────────────────────────────────────────────────────

// Bare-bones fetch on top of Node's http module. Keeps us off undici's
// connection pool so closed sockets don't leak between tests.
interface TestFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface TestFetchResponse {
  status: number;
  headerGet(name: string): string | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function testFetch(url: string, init: TestFetchInit = {}): Promise<TestFetchResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string> = {
      Connection: 'close',
      ...(init.headers ?? {}),
    };
    // Node's http client silently drops DELETE/GET bodies if no Content-Length
    // is set. Set it explicitly for any body we send.
    if (init.body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(init.body).toString();
    }
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        headers,
        agent: false,
      },
      (res) => {
        const headers = new Map<string, string>();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers.set(k.toLowerCase(), v);
          else if (Array.isArray(v)) headers.set(k.toLowerCase(), v.join(', '));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode ?? 0,
            headerGet: (name) => headers.get(name.toLowerCase()) ?? null,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

// ── Envelope / hash helpers ─────────────────────────────────────────────────

const URL_SAFE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function randomHash(len = 16): string {
  // 16 url-safe chars satisfies the relay's {8,64} regex and gives ~2^96 uniqueness.
  const bytes = new Uint8Array(len);
  (globalThis.crypto ?? require('crypto').webcrypto).getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += URL_SAFE_ALPHABET[b % URL_SAFE_ALPHABET.length];
  return out;
}

function buildEnvelope(
  action: SyncEnvelopeAction,
  keyHash: string,
  ciphertext: string | undefined,
  keyPair: nacl.SignKeyPair,
  now?: () => number,
): SignedSyncEnvelope {
  return createSignedSyncEnvelope({
    action,
    keyHash,
    ciphertext,
    signKeyPair: keyPair,
    now,
  });
}

function putBlob(keyHash: string, envelope: SignedSyncEnvelope) {
  return testFetch(`${BASE_URL}/sync/${keyHash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

function putTombstone(keyHash: string, envelope: SignedSyncEnvelope) {
  return testFetch(`${BASE_URL}/sync/${keyHash}/tombstone`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

function deleteLock(keyHash: string, envelope: SignedSyncEnvelope) {
  return testFetch(`${BASE_URL}/sync/${keyHash}/lock`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GET /sync/{hash}', () => {
  it('returns 404 when the mailbox is empty', async () => {
    const res = await testFetch(`${BASE_URL}/sync/${randomHash()}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 200 {type: blob, data} after a successful PUT', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-write', keyHash, 'ciphertext-abc', kp);
    const put = await putBlob(keyHash, env);
    expect(put.status).toBe(200);

    const res = await testFetch(`${BASE_URL}/sync/${keyHash}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; data: string };
    expect(body).toEqual({ type: 'blob', data: 'ciphertext-abc' });
  });
});

describe('PUT /sync/{hash} happy path', () => {
  it('returns 200 {ok: true} and is readable via GET', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-write', keyHash, 'hello-world', kp);

    const put = await putBlob(keyHash, env);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const get = await testFetch(`${BASE_URL}/sync/${keyHash}`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { type: string; data: string };
    expect(body.data).toBe('hello-world');
  });
});

describe('PUT /sync/{hash}/tombstone', () => {
  it('returns 200 and subsequent GET returns 410 with the tombstone data', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope(
      'sync-tombstone',
      keyHash,
      '{"type":"rotated"}',
      kp,
    );

    const put = await putTombstone(keyHash, env);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const get = await testFetch(`${BASE_URL}/sync/${keyHash}`);
    expect(get.status).toBe(410);
    const body = (await get.json()) as { type: string; data: string };
    expect(body).toEqual({ type: 'tombstone', data: '{"type":"rotated"}' });
  });
});

describe('envelope validation', () => {
  it('returns 400 for a body that is not valid JSON', async () => {
    const keyHash = randomHash();
    const res = await testFetch(`${BASE_URL}/sync/${keyHash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid envelope/i);
  });

  it('returns 400 when the JSON is missing required envelope fields', async () => {
    const keyHash = randomHash();
    const res = await testFetch(`${BASE_URL}/sync/${keyHash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, action: 'sync-write' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on action mismatch (tombstone envelope on blob route)', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-tombstone', keyHash, 'ciphertext', kp);
    // Submit a tombstone-action envelope to the blob PUT route.
    const res = await putBlob(keyHash, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/action mismatch/i);
  });

  it('returns 400 when ciphertext is missing for a write action', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    // Sign an envelope with no ciphertext, then send via blob route.
    const env = buildEnvelope('sync-write', keyHash, undefined, kp);
    const res = await putBlob(keyHash, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ciphertext required/i);
  });

  it('returns 400 when DELETE /lock carries ciphertext', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-lock-release', keyHash, 'unexpected', kp);
    const res = await deleteLock(keyHash, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/must not carry ciphertext/i);
  });
});

describe('signature verification', () => {
  it('returns 401 when the envelope is signed by a different key than it claims', async () => {
    const keyHash = randomHash();
    const signer = nacl.sign.keyPair();
    const imposter = nacl.sign.keyPair();
    const env = buildEnvelope('sync-write', keyHash, 'ciphertext', signer);
    // Overwrite sigPubkey to claim the imposter identity — signature now
    // verifies against the wrong pubkey → bad-signature.
    const forged: SignedSyncEnvelope = {
      ...env,
      sigPubkey: buildEnvelope('sync-write', 'xx', 'yy', imposter).sigPubkey,
    };
    const res = await putBlob(keyHash, forged);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('bad-signature');
  });

  it('returns 401 on replay (same envelope submitted twice)', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-write', keyHash, 'payload-1', kp);

    const first = await putBlob(keyHash, env);
    expect(first.status).toBe(200);

    const second = await putBlob(keyHash, env);
    expect(second.status).toBe(401);
    const body = (await second.json()) as { reason: string };
    expect(body.reason).toBe('replay');
  });

  it('returns 401 when the ciphertext is tampered after signing', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-write', keyHash, 'original', kp);
    // Tamper with the ciphertext → hash differs → signature no longer verifies.
    const tampered: SignedSyncEnvelope = { ...env, ciphertext: 'tampered' };
    const res = await putBlob(keyHash, tampered);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('bad-signature');
  });

  it('returns 401 when ts is stale (ten minutes in the past)', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const staleNow = () => Date.now() - 10 * 60_000;
    const env = buildEnvelope('sync-write', keyHash, 'stale-payload', kp, staleNow);
    const res = await putBlob(keyHash, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('stale');
  });

  it('returns 401 when ts is in the future (ten minutes ahead)', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const futureNow = () => Date.now() + 10 * 60_000;
    const env = buildEnvelope('sync-write', keyHash, 'future-payload', kp, futureNow);
    const res = await putBlob(keyHash, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('future');
  });
});

describe('DELETE /sync/{hash}/lock', () => {
  it('returns 200 {released: false} when no lock is held', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-lock-release', keyHash, undefined, kp);
    const res = await deleteLock(keyHash, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { released: boolean };
    expect(body).toEqual({ released: false });
  });

  it('returns 400 when the envelope action is sync-write instead of sync-lock-release', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    // Sign a write-action envelope and send it to the lock route.
    const env = buildEnvelope('sync-write', keyHash, 'ciphertext', kp);
    const res = await deleteLock(keyHash, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/action mismatch/i);
  });
});

describe('blob size limit', () => {
  it('returns 413 when ciphertext exceeds maxBlobSize', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    // maxBlobSize is 8192 — push one byte past.
    const big = 'x'.repeat(8193);
    const env = buildEnvelope('sync-write', keyHash, big, kp);
    const res = await putBlob(keyHash, env);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/max size/i);
  });
});

describe('tombstone collision', () => {
  it('PUT blob after tombstone returns 410 with the tombstone data', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();

    // Drop a tombstone.
    const tomb = buildEnvelope(
      'sync-tombstone',
      keyHash,
      '{"type":"rotated","oldPublicKey":"pk"}',
      kp,
    );
    const tombRes = await putTombstone(keyHash, tomb);
    expect(tombRes.status).toBe(200);

    // Any subsequent blob write should be refused with 410.
    const write = buildEnvelope('sync-write', keyHash, 'new-data', kp);
    const writeRes = await putBlob(keyHash, write);
    expect(writeRes.status).toBe(410);
    const body = (await writeRes.json()) as { type: string; data: string };
    expect(body.type).toBe('tombstone');
    expect(body.data).toBe('{"type":"rotated","oldPublicKey":"pk"}');
  });
});

describe('onTombstone callback', () => {
  // Independent relay + router: the shared harness doesn't wire onTombstone,
  // so stand up a second instance just for these assertions.
  const PORT = 18093;
  const URL_BASE = `http://localhost:${PORT}`;
  let localRelay: RelayInstance;
  const calls: Array<{ keyHash: string; ciphertext: string }> = [];

  beforeAll(async () => {
    const store = new SyncStore();
    const router = createSyncRouter({
      store,
      onTombstone: (keyHash, ciphertext) => calls.push({ keyHash, ciphertext }),
    });
    localRelay = createRelay({
      port: PORT,
      keyStore: false,
      blobStore: false,
      channels: [{ name: 'agent', onDuplicate: 'reject' }],
      hooks: {
        onHttpRequest(req, res, next) {
          const sync = parseSyncUrl(req.url);
          if (sync) {
            router.handle(req, res, sync.keyHash, sync.subpath);
            return;
          }
          next();
        },
      },
    });
  });

  afterAll(async () => {
    localRelay.close();
    await new Promise<void>((resolve) =>
      localRelay.server.close(() => resolve()),
    );
  });

  it('fires with (keyHash, ciphertext) after a successful PUT /sync/{h}/tombstone', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const ciphertext = '{"type":"rotated","oldPublicKey":"pk","signature":"sig"}';
    const env = buildEnvelope('sync-tombstone', keyHash, ciphertext, kp);

    const before = calls.length;
    const res = await testFetch(`${URL_BASE}/sync/${keyHash}/tombstone`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
    });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(before + 1);
    expect(calls[before]).toEqual({ keyHash, ciphertext });
  });

  it('does NOT fire on successful blob PUT', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-write', keyHash, 'not-a-tombstone', kp);

    const before = calls.length;
    const res = await testFetch(`${URL_BASE}/sync/${keyHash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
    });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(before);
  });

  it('does NOT fire on duplicate-tombstone 409 (already exists)', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const ciphertext = '{"type":"rotated","oldPublicKey":"pk","signature":"sig"}';
    const env1 = buildEnvelope('sync-tombstone', keyHash, ciphertext, kp);
    const first = await testFetch(`${URL_BASE}/sync/${keyHash}/tombstone`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env1),
    });
    expect(first.status).toBe(200);

    const before = calls.length;
    const env2 = buildEnvelope('sync-tombstone', keyHash, ciphertext, kp);
    const second = await testFetch(`${URL_BASE}/sync/${keyHash}/tombstone`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env2),
    });
    expect(second.status).toBe(409);
    expect(calls.length).toBe(before);
  });
});

describe('onWriteSuccess callback', () => {
  // Independent local relay so we can wire onWriteSuccess in isolation.
  const PORT = 18094;
  const URL_BASE = `http://localhost:${PORT}`;
  let localRelay: RelayInstance;
  interface WriteCall {
    kind: 'blob' | 'tombstone';
    bytes: number;
    sigPubkey: string;
  }
  const writes: WriteCall[] = [];

  beforeAll(async () => {
    const store = new SyncStore();
    const router = createSyncRouter({
      store,
      onWriteSuccess: (info) => writes.push(info),
    });
    localRelay = createRelay({
      port: PORT,
      keyStore: false,
      blobStore: false,
      channels: [{ name: 'agent', onDuplicate: 'reject' }],
      hooks: {
        onHttpRequest(req, res, next) {
          const sync = parseSyncUrl(req.url);
          if (sync) {
            router.handle(req, res, sync.keyHash, sync.subpath);
            return;
          }
          next();
        },
      },
    });
  });

  afterAll(async () => {
    localRelay.close();
    await new Promise<void>((resolve) =>
      localRelay.server.close(() => resolve()),
    );
  });

  it('fires kind=blob with byte count and sigPubkey on a successful blob write', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const ciphertext = 'hello-blob';
    const env = buildEnvelope('sync-write', keyHash, ciphertext, kp);

    const before = writes.length;
    const res = await testFetch(`${URL_BASE}/sync/${keyHash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
    });
    expect(res.status).toBe(200);
    expect(writes.length).toBe(before + 1);
    expect(writes[before].kind).toBe('blob');
    expect(writes[before].bytes).toBe(ciphertext.length);
    expect(writes[before].sigPubkey).toBe(env.sigPubkey);
  });

  it('fires kind=tombstone on a successful tombstone write', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const ciphertext = '{"type":"rotated"}';
    const env = buildEnvelope('sync-tombstone', keyHash, ciphertext, kp);

    const before = writes.length;
    const res = await testFetch(`${URL_BASE}/sync/${keyHash}/tombstone`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
    });
    expect(res.status).toBe(200);
    expect(writes.length).toBe(before + 1);
    expect(writes[before].kind).toBe('tombstone');
    expect(writes[before].bytes).toBe(ciphertext.length);
  });

  it('does NOT fire when signature verification fails', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env = buildEnvelope('sync-write', keyHash, 'data', kp);
    // Corrupt the sig — server should reject before hitting onWriteSuccess.
    const corrupted = { ...env, sig: 'A'.repeat(env.sig.length) };

    const before = writes.length;
    const res = await testFetch(`${URL_BASE}/sync/${keyHash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corrupted),
    });
    expect(res.status).toBe(401);
    expect(writes.length).toBe(before);
  });

  it('does NOT fire on duplicate-tombstone 409', async () => {
    const keyHash = randomHash();
    const kp = nacl.sign.keyPair();
    const env1 = buildEnvelope('sync-tombstone', keyHash, 'first', kp);
    const first = await testFetch(`${URL_BASE}/sync/${keyHash}/tombstone`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env1),
    });
    expect(first.status).toBe(200);

    const before = writes.length;
    const env2 = buildEnvelope('sync-tombstone', keyHash, 'second', kp);
    const second = await testFetch(`${URL_BASE}/sync/${keyHash}/tombstone`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env2),
    });
    expect(second.status).toBe(409);
    expect(writes.length).toBe(before);
  });
});
