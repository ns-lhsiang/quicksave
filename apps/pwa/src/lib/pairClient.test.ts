// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PairClient,
  MockRelay,
  pairAddrFromPubkey,
  buildPairUrl,
  parsePairUrl,
  getSharedMockRelay,
  resetSharedMockRelayForTests,
  type Candidate,
  type PairSlot,
  type PairTransport,
} from './pairClient';
import {
  decodeBase64,
  encodeBase64,
  decryptSyncBlob,
  generateKeyPair,
  sasBucket,
} from '@sumicom/quicksave-shared';

// ── Helpers ───────────────────────────────────────────────────────────────

function make32ByteSecret(fillByte = 0x42): Uint8Array {
  const buf = new Uint8Array(32);
  buf.fill(fillByte);
  return buf;
}

/**
 * Flush microtasks / zero-delay timers. The transport's
 * subscribeToMailbox-based candidate/secret plumbing uses queued callbacks,
 * so we need a couple of turns to let them settle.
 */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// A consistent fixed "now" across a test to make SAS buckets deterministic.
const FIXED_T = 1_700_000_000_000;
const FIXED_NOW = () => FIXED_T;

// ── pairAddrFromPubkey ────────────────────────────────────────────────────

describe('pairAddrFromPubkey', () => {
  it('returns base64url form (no +, /, or =)', () => {
    // A base64 input that contains +, /, and padding — ensure they all get
    // stripped/converted.
    const raw = new Uint8Array([
      0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8, 0xf7, 0xf6, 0xf5, 0xf4,
      0xf3, 0xf2, 0xf1, 0xf0, 0x00, 0x01, 0x02,
    ]);
    const b64 = encodeBase64(raw);
    const addr = pairAddrFromPubkey(b64);
    expect(addr).not.toMatch(/\+/);
    expect(addr).not.toMatch(/\//);
    expect(addr).not.toMatch(/=/);
  });

  it('is deterministic', () => {
    const b64 = encodeBase64(make32ByteSecret(0x11));
    expect(pairAddrFromPubkey(b64)).toBe(pairAddrFromPubkey(b64));
  });

  it('differs for different inputs', () => {
    const a = encodeBase64(make32ByteSecret(0x01));
    const b = encodeBase64(make32ByteSecret(0x02));
    expect(pairAddrFromPubkey(a)).not.toBe(pairAddrFromPubkey(b));
  });
});

// ── buildPairUrl / parsePairUrl ───────────────────────────────────────────

describe('buildPairUrl / parsePairUrl', () => {
  const SAMPLE_KEY = encodeBase64(make32ByteSecret(0x07));

  it('builds the expected URL shape (HashRouter /#/pair?k=...)', () => {
    const url = buildPairUrl('http://localhost:5173', SAMPLE_KEY);
    expect(url.startsWith('http://localhost:5173/#/pair?k=')).toBe(true);
    const frag = url.split('#')[1];
    const prefix = '/pair?k=';
    expect(frag.startsWith(prefix)).toBe(true);
    const keyValue = frag.slice(prefix.length);
    expect(keyValue).not.toMatch(/\+/);
    expect(keyValue).not.toMatch(/\//);
    expect(keyValue).not.toMatch(/=/);
  });

  it('strips trailing slashes from baseUrl', () => {
    const a = buildPairUrl('http://localhost:5173', SAMPLE_KEY);
    const b = buildPairUrl('http://localhost:5173/', SAMPLE_KEY);
    expect(a).toBe(b);
  });

  it('round-trips through parsePairUrl', () => {
    const url = buildPairUrl('http://localhost:5173', SAMPLE_KEY);
    const parsed = parsePairUrl(url);
    // The key may or may not retain its = padding; compare bytes.
    const originalBytes = decodeBase64(SAMPLE_KEY);
    const roundTripBytes = decodeBase64(parsed.eA_pubB64);
    expect(Array.from(roundTripBytes)).toEqual(Array.from(originalBytes));
  });

  it('throws when URL has no fragment', () => {
    expect(() => parsePairUrl('https://x/pair')).toThrow();
  });

  it('throws when fragment is empty', () => {
    expect(() => parsePairUrl('https://x/pair#')).toThrow();
  });

  it('throws when fragment does not contain k=', () => {
    expect(() => parsePairUrl('https://x/pair#other=1')).toThrow();
  });
});

// ── MockRelay ─────────────────────────────────────────────────────────────

describe('MockRelay', () => {
  let relay: MockRelay;

  beforeEach(() => {
    relay = new MockRelay({ useBroadcastChannel: false });
  });

  afterEach(() => {
    relay.close();
  });

  it('returns [] for a fresh mailbox', async () => {
    const slots = await relay.getSlots('fresh-addr');
    expect(slots).toEqual([]);
  });

  it('stores a posted slot with data/kind/id/createdAt', async () => {
    const { id } = await relay.postSlot('addr1', {
      data: 'hello',
      kind: 'join',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const slots = await relay.getSlots('addr1');
    expect(slots).toHaveLength(1);
    const slot = slots[0];
    expect(slot.data).toBe('hello');
    expect(slot.kind).toBe('join');
    expect(slot.id).toBe(id);
    expect(typeof slot.createdAt).toBe('number');
  });

  it('accumulates multiple posts in insertion order with distinct ids', async () => {
    const r1 = await relay.postSlot('addr2', { data: 'a', kind: 'join' });
    const r2 = await relay.postSlot('addr2', { data: 'b', kind: 'join' });
    const r3 = await relay.postSlot('addr2', { data: 'c' });

    expect(new Set([r1.id, r2.id, r3.id]).size).toBe(3);

    const slots = await relay.getSlots('addr2');
    expect(slots.map((s) => s.data)).toEqual(['a', 'b', 'c']);
  });

  it('invokes subscribers once per postSlot in insertion order', async () => {
    const received: PairSlot[] = [];
    const unsub = relay.subscribeToMailbox('addr3', (s) => received.push(s));

    const { id: id1 } = await relay.postSlot('addr3', {
      data: 'one',
      kind: 'join',
    });
    const { id: id2 } = await relay.postSlot('addr3', { data: 'two' });

    await flush();

    expect(received).toHaveLength(2);
    expect(received[0].data).toBe('one');
    expect(received[0].id).toBe(id1);
    expect(received[1].data).toBe('two');
    expect(received[1].id).toBe(id2);

    unsub();
  });

  it('unsubscribe prevents further callback invocations', async () => {
    const received: PairSlot[] = [];
    const unsub = relay.subscribeToMailbox('addr4', (s) => received.push(s));

    await relay.postSlot('addr4', { data: 'first', kind: 'join' });
    await flush();
    expect(received).toHaveLength(1);

    unsub();

    await relay.postSlot('addr4', { data: 'second', kind: 'join' });
    await flush();
    // Still 1 — the second slot should not have reached our callback.
    expect(received).toHaveLength(1);
  });

  it('deleteMailbox clears state and stops future callbacks', async () => {
    const received: PairSlot[] = [];
    relay.subscribeToMailbox('addr5', (s) => received.push(s));
    await relay.postSlot('addr5', { data: 'before', kind: 'join' });
    await flush();
    expect(received).toHaveLength(1);

    await relay.deleteMailbox('addr5');
    const after = await relay.getSlots('addr5');
    expect(after).toEqual([]);

    await relay.postSlot('addr5', { data: 'after', kind: 'join' });
    await flush();
    // Subscribers attached pre-delete should not receive post-delete slots.
    expect(received).toHaveLength(1);
  });

  it('rejects on the 65th postSlot (mailbox cap = 64)', async () => {
    const addr = 'cap-addr';
    for (let i = 0; i < 64; i++) {
      await relay.postSlot(addr, { data: `s${i}`, kind: 'join' });
    }
    await expect(
      relay.postSlot(addr, { data: 'overflow', kind: 'join' }),
    ).rejects.toThrow();
  });

  it('gcs expired slots after TTL', async () => {
    let current = 0;
    const ttlRelay = new MockRelay({
      ttlMs: 1000,
      now: () => current,
      useBroadcastChannel: false,
    });
    try {
      await ttlRelay.postSlot('ttl-addr', { data: 'old', kind: 'join' });
      // Expose at t=0
      expect(await ttlRelay.getSlots('ttl-addr')).toHaveLength(1);

      // Advance "now" past TTL.
      current = 10_000;
      const slots = await ttlRelay.getSlots('ttl-addr');
      expect(slots).toEqual([]);
    } finally {
      ttlRelay.close();
    }
  });
});

// ── PairClient.createInvite ───────────────────────────────────────────────

describe('PairClient.createInvite', () => {
  let relay: MockRelay;
  let client: PairClient;

  beforeEach(() => {
    relay = new MockRelay({ useBroadcastChannel: false });
    client = new PairClient(relay);
  });

  afterEach(() => {
    relay.close();
  });

  it('returns pairUrl/qrData/addr/expiresAt consistent with inputs', async () => {
    const invite = await client.createInvite({
      baseUrl: 'http://localhost:5173',
      masterSecret: make32ByteSecret(),
      now: FIXED_NOW,
    });

    expect(invite.pairUrl).toBe(
      buildPairUrl('http://localhost:5173', invite.eA_pubB64),
    );
    expect(invite.qrData).toBe(invite.pairUrl);
    expect(invite.addr).toBe(pairAddrFromPubkey(invite.eA_pubB64));
    // default ttl = 5 * 60_000
    expect(invite.expiresAt).toBe(FIXED_T + 5 * 60_000);

    await invite.cancel();
  });

  it('honors an explicit ttlMs', async () => {
    const invite = await client.createInvite({
      baseUrl: 'https://x',
      masterSecret: make32ByteSecret(),
      ttlMs: 10_000,
      now: FIXED_NOW,
    });
    expect(invite.expiresAt).toBe(FIXED_T + 10_000);
    await invite.cancel();
  });

  it('throws when masterSecret is not 32 bytes', async () => {
    await expect(
      client.createInvite({
        baseUrl: 'https://x',
        masterSecret: new Uint8Array(16),
      }),
    ).rejects.toThrow();
  });

  it('generates a fresh ephemeral keypair per call', async () => {
    const a = await client.createInvite({
      baseUrl: 'https://x',
      masterSecret: make32ByteSecret(),
    });
    const b = await client.createInvite({
      baseUrl: 'https://x',
      masterSecret: make32ByteSecret(),
    });
    expect(a.eA_pubB64).not.toBe(b.eA_pubB64);
    await a.cancel();
    await b.cancel();
  });
});

// ── PairClient.acceptInvite ───────────────────────────────────────────────

describe('PairClient.acceptInvite', () => {
  let relay: MockRelay;
  let client: PairClient;

  beforeEach(() => {
    relay = new MockRelay({ useBroadcastChannel: false });
    client = new PairClient(relay);
  });

  afterEach(() => {
    relay.close();
  });

  async function freshEAKey(): Promise<{ eA_pubB64: string }> {
    // Create a throwaway invite to obtain a valid eA_pubB64.
    const invite = await client.createInvite({
      baseUrl: 'https://x',
      masterSecret: make32ByteSecret(),
      now: FIXED_NOW,
    });
    const eA_pubB64 = invite.eA_pubB64;
    await invite.cancel();
    return { eA_pubB64 };
  }

  it('accepts pairUrl', async () => {
    const invite = await client.createInvite({
      baseUrl: 'https://x',
      masterSecret: make32ByteSecret(),
      now: FIXED_NOW,
    });
    const join = await client.acceptInvite({
      pairUrl: invite.pairUrl,
      now: FIXED_NOW,
    });
    expect(join.eA_pubB64).toBe(invite.eA_pubB64);
    expect(join.addr).toBe(invite.addr);
    await invite.cancel();
    await join.cancel();
  });

  it('accepts eA_pubB64 directly', async () => {
    const { eA_pubB64 } = await freshEAKey();
    const join = await client.acceptInvite({
      eA_pubB64,
      now: FIXED_NOW,
    });
    expect(join.eA_pubB64).toBe(eA_pubB64);
    await join.cancel();
  });

  it('throws when neither pairUrl nor eA_pubB64 is provided', async () => {
    await expect(client.acceptInvite({})).rejects.toThrow();
  });

  it('produces an SAS of length === sasChars (default 6)', async () => {
    const { eA_pubB64 } = await freshEAKey();
    const join = await client.acceptInvite({ eA_pubB64, now: FIXED_NOW });
    expect(join.sas.length).toBe(6);
    await join.cancel();
  });

  it('honors sasChars = 4 and = 8', async () => {
    const { eA_pubB64 } = await freshEAKey();
    const a = await client.acceptInvite({
      eA_pubB64,
      sasChars: 4,
      now: FIXED_NOW,
    });
    expect(a.sas.length).toBe(4);
    await a.cancel();

    const b = await client.acceptInvite({
      eA_pubB64,
      sasChars: 8,
      now: FIXED_NOW,
    });
    expect(b.sas.length).toBe(8);
    await b.cancel();
  });

  it('bucket === sasBucket(now(), windowMs)', async () => {
    const { eA_pubB64 } = await freshEAKey();
    const join = await client.acceptInvite({
      eA_pubB64,
      now: FIXED_NOW,
      sasWindowMs: 30_000,
    });
    expect(join.bucket).toBe(sasBucket(FIXED_T, 30_000));
    await join.cancel();
  });

  it('eB_pubB64 is fresh across two calls', async () => {
    const { eA_pubB64 } = await freshEAKey();
    const a = await client.acceptInvite({ eA_pubB64, now: FIXED_NOW });
    const b = await client.acceptInvite({ eA_pubB64, now: FIXED_NOW });
    expect(a.eB_pubB64).not.toBe(b.eB_pubB64);
    await a.cancel();
    await b.cancel();
  });

  it('throws when eA_pub decodes to a non-32-byte key', async () => {
    // 'AAAA' base64 => 3 bytes, invalid length.
    await expect(
      client.acceptInvite({ eA_pubB64: 'AAAA', now: FIXED_NOW }),
    ).rejects.toThrow();
  });
});

// ── End-to-end happy path ────────────────────────────────────────────────

describe('PairClient end-to-end pairing', () => {
  let relay: MockRelay;
  let client: PairClient;
  const MASTER = make32ByteSecret(0xa5);

  beforeEach(() => {
    relay = new MockRelay({ useBroadcastChannel: false });
    client = new PairClient(relay);
  });

  afterEach(() => {
    relay.close();
  });

  it('delivers the master secret from A to B via matching SAS', async () => {
    const candidates: Candidate[] = [];
    const secrets: Uint8Array[] = [];

    // A side: invite.
    const invite = await client.createInvite({
      baseUrl: 'http://localhost:5173',
      masterSecret: MASTER,
      now: FIXED_NOW,
    });
    invite.onCandidate((c) => candidates.push(c));

    // B side: accept.
    const join = await client.acceptInvite({
      pairUrl: invite.pairUrl,
      now: FIXED_NOW,
    });
    join.onSecret((s) => secrets.push(s));

    await flush(5);

    // A should have discovered exactly one candidate matching B's eB_pubB64.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].eB_pubB64).toBe(join.eB_pubB64);

    // A submits B's SAS.
    const result = await invite.submitSAS(join.sas);
    expect(result.status).toBe('sent');
    if (result.status === 'sent') {
      expect(result.matched.eB_pubB64).toBe(join.eB_pubB64);
    }

    await flush(5);

    // B should receive exactly one secret, byte-equal to MASTER.
    expect(secrets).toHaveLength(1);
    expect(Array.from(secrets[0])).toEqual(Array.from(MASTER));

    await invite.cancel();
    await join.cancel();
  });
});

// ── SAS mismatch paths ────────────────────────────────────────────────────

describe('SAS mismatch paths', () => {
  let relay: MockRelay;
  let client: PairClient;

  beforeEach(() => {
    relay = new MockRelay({ useBroadcastChannel: false });
    client = new PairClient(relay);
  });

  afterEach(() => {
    relay.close();
  });

  async function setup() {
    const invite = await client.createInvite({
      baseUrl: 'http://localhost:5173',
      masterSecret: make32ByteSecret(0x5a),
      now: FIXED_NOW,
    });
    const join = await client.acceptInvite({
      pairUrl: invite.pairUrl,
      now: FIXED_NOW,
    });
    await flush(5);
    return { invite, join };
  }

  it('returns no-match for a wrong SAS string', async () => {
    const { invite, join } = await setup();
    // Ensure 'XXXXXX' is definitely not the real SAS (extremely unlikely to
    // collide for 6 chars, but guard against it explicitly).
    const wrong = join.sas === 'XXXXXX' ? 'YYYYYY' : 'XXXXXX';
    const result = await invite.submitSAS(wrong);
    expect(result.status).toBe('no-match');
    await invite.cancel();
    await join.cancel();
  });

  it('returns no-match for wrong-length SAS', async () => {
    const { invite, join } = await setup();
    const result = await invite.submitSAS(join.sas.slice(0, 4));
    expect(result.status).toBe('no-match');
    await invite.cancel();
    await join.cancel();
  });

  it('accepts lowercase SAS (case-insensitive match)', async () => {
    const { invite, join } = await setup();
    const result = await invite.submitSAS(join.sas.toLowerCase());
    expect(result.status).toBe('sent');
    await invite.cancel();
    await join.cancel();
  });
});

// ── Collision path ──────────────────────────────────────────────────────

describe('SAS collision path', () => {
  let relay: MockRelay;
  let client: PairClient;

  beforeEach(() => {
    relay = new MockRelay({ useBroadcastChannel: false });
    client = new PairClient(relay);
  });

  afterEach(() => {
    relay.close();
  });

  it('returns collision when two slots share the same eB_pubB64', async () => {
    const invite = await client.createInvite({
      baseUrl: 'http://localhost:5173',
      masterSecret: make32ByteSecret(0x3c),
      now: FIXED_NOW,
    });
    const join = await client.acceptInvite({
      pairUrl: invite.pairUrl,
      now: FIXED_NOW,
    });
    await flush(5);

    // Grab the sealed-blob that B posted (first slot on A's mailbox),
    // then re-post it so A's candidate list sees the same eB_pubB64 twice
    // (two distinct slot ids, one shared pubkey). This forces the collision
    // branch in submitSAS.
    const slots = await relay.getSlots(invite.addr);
    const joinSlot = slots.find((s) => s.kind === 'join');
    if (!joinSlot) {
      throw new Error('Expected a join slot on the invite mailbox');
    }
    await relay.postSlot(invite.addr, {
      data: joinSlot.data,
      kind: 'join',
    });
    await flush(5);

    const result = await invite.submitSAS(join.sas);
    expect(result.status).toBe('collision');
    if (result.status === 'collision') {
      expect(result.matches.length).toBe(2);
      // Both matches must share the same eB_pubB64.
      expect(result.matches[0].eB_pubB64).toBe(result.matches[1].eB_pubB64);
    }

    await invite.cancel();
    await join.cancel();
  });
});

// ── Ciphertext unreadability ─────────────────────────────────────────────

describe('ciphertext unreadability', () => {
  let relay: MockRelay;
  let client: PairClient;

  beforeEach(() => {
    relay = new MockRelay({ useBroadcastChannel: false });
    client = new PairClient(relay);
  });

  afterEach(() => {
    relay.close();
  });

  it('a third party cannot decrypt the join slot blob', async () => {
    const invite = await client.createInvite({
      baseUrl: 'http://localhost:5173',
      masterSecret: make32ByteSecret(0x77),
      now: FIXED_NOW,
    });
    const join = await client.acceptInvite({
      pairUrl: invite.pairUrl,
      now: FIXED_NOW,
    });
    await flush(5);

    const slots = await relay.getSlots(invite.addr);
    const joinSlot = slots.find((s) => s.kind === 'join');
    if (!joinSlot) throw new Error('Expected join slot');

    // A third-party keypair that has never been on the wire.
    const thirdParty = generateKeyPair();
    expect(() => decryptSyncBlob(joinSlot.data, thirdParty.secretKey)).toThrow();

    await invite.cancel();
    await join.cancel();
  });
});

// ── Cancel semantics ─────────────────────────────────────────────────────

describe('cancel semantics', () => {
  let relay: MockRelay;
  let client: PairClient;

  beforeEach(() => {
    relay = new MockRelay({ useBroadcastChannel: false });
    client = new PairClient(relay);
  });

  afterEach(() => {
    relay.close();
  });

  it('invite.cancel deletes the mailbox', async () => {
    const invite = await client.createInvite({
      baseUrl: 'https://x',
      masterSecret: make32ByteSecret(),
      now: FIXED_NOW,
    });

    // Write something so the mailbox exists on the relay.
    await relay.postSlot(invite.addr, { data: 'blob', kind: 'join' });
    expect((await relay.getSlots(invite.addr)).length).toBeGreaterThan(0);

    await invite.cancel();
    expect(await relay.getSlots(invite.addr)).toEqual([]);
  });

  it('invite.cancel is idempotent', async () => {
    const invite = await client.createInvite({
      baseUrl: 'https://x',
      masterSecret: make32ByteSecret(),
      now: FIXED_NOW,
    });
    await invite.cancel();
    await expect(invite.cancel()).resolves.not.toThrow();
  });

  it('join.cancel is idempotent', async () => {
    const invite = await client.createInvite({
      baseUrl: 'https://x',
      masterSecret: make32ByteSecret(),
      now: FIXED_NOW,
    });
    const join = await client.acceptInvite({
      pairUrl: invite.pairUrl,
      now: FIXED_NOW,
    });
    await join.cancel();
    await expect(join.cancel()).resolves.not.toThrow();
    await invite.cancel();
  });
});

// ── Shared mock relay helpers ────────────────────────────────────────────

describe('getSharedMockRelay / resetSharedMockRelayForTests', () => {
  afterEach(() => {
    resetSharedMockRelayForTests();
  });

  it('returns the same instance across calls', () => {
    const a = getSharedMockRelay();
    const b = getSharedMockRelay();
    expect(a).toBe(b);
  });

  it('reset returns a new instance on the next call', () => {
    const a = getSharedMockRelay();
    resetSharedMockRelayForTests();
    const b = getSharedMockRelay();
    expect(a).not.toBe(b);
  });
});
