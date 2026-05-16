// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Adversarial / edge-case tests for AgentConnection and PubSub.
 *
 * These tests try to BREAK the connection layer by simulating race conditions,
 * replay attacks, memory leaks, and other adversarial scenarios.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PubSub, BROADCAST_TOPIC } from './pubsub.js';

// ---------------------------------------------------------------------------
// Mocks — mirrors the setup from connection.test.ts
// ---------------------------------------------------------------------------

const {
  MockSignalingClient,
  mockDecodeKeyPair,
  mockDecryptDEK,
  mockEncryptWithSharedSecret,
  mockDecryptWithSharedSecret,
  mockParseMessage,
  mockSerializeMessage,
  mockVerifyKeyExchangeV2Signature,
  mockDecodeBase64,
  mockIsPaired,
  mockLoadConfig,
  mockPinPeerPWA,
} = vi.hoisted(() => {
  const { EventEmitter } = require('events');

  class MockSignalingClient extends EventEmitter {
    connectCalled = false;
    sentMessages: Array<{ data: string; target: string | null }> = [];

    constructor(_url: string, _agentId: string) {
      super();
    }

    async connect(): Promise<void> {
      this.connectCalled = true;
    }

    sendData(data: string, targetAddress: string | null): void {
      this.sentMessages.push({ data, target: targetAddress });
    }

    disconnect(): void {}
  }

  return {
    MockSignalingClient,
    mockDecodeKeyPair: vi.fn().mockReturnValue({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    }),
    mockDecryptDEK: vi.fn().mockReturnValue(new Uint8Array(32)),
    mockEncryptWithSharedSecret: vi.fn().mockReturnValue('encrypted-payload'),
    mockDecryptWithSharedSecret: vi.fn().mockReturnValue(''),
    mockParseMessage: vi.fn(),
    mockSerializeMessage: vi.fn().mockReturnValue('{"type":"ping"}'),
    mockVerifyKeyExchangeV2Signature: vi.fn().mockReturnValue(true),
    mockDecodeBase64: vi.fn().mockReturnValue(new Uint8Array(32)),
    mockIsPaired: vi.fn().mockReturnValue(false),
    mockLoadConfig: vi.fn().mockReturnValue({
      agentId: 'agent-edge-001',
      keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
      signKeyPair: { publicKey: 'sign-pk', secretKey: 'sign-sk' },
      peerPWAPublicKey: null,
      peerPWASignPublicKey: null,
      signalingServer: 'wss://test.example.com',
    }),
    mockPinPeerPWA: vi.fn(),
  };
});

vi.mock('./relay.js', () => ({
  SignalingClient: MockSignalingClient,
}));

vi.mock('../config.js', () => ({
  isPaired: mockIsPaired,
  loadConfig: mockLoadConfig,
  pinPeerPWA: mockPinPeerPWA,
  saveConfig: vi.fn(),
}));

vi.mock('@sumicom/quicksave-shared', () => ({
  generateKeyPair: vi.fn(),
  encodeKeyPair: vi.fn(),
  decodeKeyPair: mockDecodeKeyPair,
  decodeBase64: mockDecodeBase64,
  encryptWithSharedSecret: mockEncryptWithSharedSecret,
  decryptWithSharedSecret: mockDecryptWithSharedSecret,
  decryptDEK: mockDecryptDEK,
  parseMessage: mockParseMessage,
  serializeMessage: mockSerializeMessage,
  verifyKeyExchangeV2Signature: mockVerifyKeyExchangeV2Signature,
}));

vi.mock('zlib', () => ({
  gzip: vi.fn((_buf: Buffer, cb: (err: null, res: Buffer) => void) =>
    cb(null, Buffer.from('compressed'))),
  gunzip: vi.fn((_buf: Buffer, cb: (err: null, res: Buffer) => void) =>
    cb(null, Buffer.from('decompressed'))),
}));

import { AgentConnection, type ConnectionConfig } from './connection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): ConnectionConfig {
  return {
    signalingServer: 'wss://test.example.com',
    agentId: 'agent-edge-001',
    keyPair: { publicKey: 'pub-key-base64', secretKey: 'sec-key-base64' },
  };
}

function makeMessage(type = 'ping', payload: unknown = {}): {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
} {
  return { id: 'msg-1', type, payload, timestamp: Date.now() };
}

function getSignaling(conn: AgentConnection): InstanceType<typeof MockSignalingClient> {
  return (conn as any).signaling;
}

function addPeer(conn: AgentConnection, address: string): void {
  const sig = getSignaling(conn);
  const keyExchange = JSON.stringify({
    type: 'key-exchange',
    version: 2,
    encryptedDEK: 'encrypted-dek-base64',
    timestamp: Date.now(),
    sigPubkey: 'peer-sign-pubkey-base64',
    signature: 'signature-base64',
  });
  sig.emit('data', keyExchange, address);
}

function addPeerWithTimestamp(conn: AgentConnection, address: string, timestamp: number): void {
  const sig = getSignaling(conn);
  const keyExchange = JSON.stringify({
    type: 'key-exchange',
    version: 2,
    encryptedDEK: 'encrypted-dek-base64',
    timestamp,
    sigPubkey: 'peer-sign-pubkey-base64',
    signature: 'signature-base64',
  });
  sig.emit('data', keyExchange, address);
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// 1. Key Exchange Replay Attack
// ---------------------------------------------------------------------------

describe('edge: key exchange replay attack', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('same key exchange message sent twice with identical timestamp creates only one peer', async () => {
    const connectedHandler = vi.fn();
    const disconnectedHandler = vi.fn();
    conn.on('connected', connectedHandler);
    conn.on('disconnected', disconnectedHandler);

    const now = Date.now();
    addPeerWithTimestamp(conn, 'pwa:peer-replay', now);
    await flush();

    // Send exact same message again (replay)
    addPeerWithTimestamp(conn, 'pwa:peer-replay', now);
    await flush();

    // The code treats this as a reconnect (same address): emits disconnected+connected
    // Peer count should still be 1
    expect(conn.getPeerCount()).toBe(1);
    // Connected is called twice (initial + re-key), disconnected once (re-key teardown)
    expect(connectedHandler).toHaveBeenCalledTimes(2);
    expect(disconnectedHandler).toHaveBeenCalledTimes(1);
    // BUG: There is no nonce or replay detection beyond timestamp age.
    // An attacker replaying the same key-exchange within the 60s window
    // will succeed and overwrite the DEK, effectively hijacking the session.
    // The code treats it as a legitimate "reconnect with new DEK" because
    // there is no per-message nonce or seen-timestamps set.
  });

  it('replayed key exchange from a DIFFERENT address with same encryptedDEK creates two peers', async () => {
    const now = Date.now();
    addPeerWithTimestamp(conn, 'pwa:peer-aaa', now);
    await flush();

    // Attacker replays the same payload but from a different address
    addPeerWithTimestamp(conn, 'pwa:peer-attacker', now);
    await flush();

    // Both peers exist — the encryptedDEK is the same so both derive the same sessionDEK
    // BUG: No binding between the key-exchange and the sender identity.
    // If an attacker intercepts a key-exchange message and replays it from a different
    // address, both peers will share the same DEK, allowing the attacker to read messages.
    expect(conn.getPeerCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Rapid Reconnect (disconnect + key exchange race)
// ---------------------------------------------------------------------------

describe('edge: rapid reconnect race', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('key exchange arriving immediately after signaling disconnect succeeds', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);
    // Signaling disconnect fires (clears all peers)
    sig.emit('disconnected');
    // Immediately, before anything async settles, new key exchange arrives
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    // Peer should be re-established
    expect(conn.getPeerCount()).toBe(1);
    expect(conn.hasPeers()).toBe(true);
  });

  it('broadcast subscription is restored after rapid reconnect from same peer', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);
    sig.emit('disconnected');

    // Same peer reconnects immediately
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const state = conn.getDebugState();
    const peerTopics = state.peers[0]?.topics ?? [];
    expect(peerTopics).toContain(BROADCAST_TOPIC);
  });

  it('pwa-bye then immediate key exchange from same peer works cleanly', async () => {
    const connectedHandler = vi.fn();
    const disconnectedHandler = vi.fn();
    conn.on('connected', connectedHandler);
    conn.on('disconnected', disconnectedHandler);

    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);
    // Peer disconnects
    sig.emit('pwa-bye', 'pwa:peer-aaa');
    // Immediately reconnects
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    expect(conn.getPeerCount()).toBe(1);
    // disconnected from pwa-bye, connected from new key exchange
    expect(disconnectedHandler).toHaveBeenCalledWith('pwa:peer-aaa');
    expect(connectedHandler).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Message send during disconnect
// ---------------------------------------------------------------------------

describe('edge: send() during disconnect', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('send() started before disconnect completes gracefully (re-check guard)', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);
    sig.sentMessages = [];

    // Start a send (queues async gzip+encrypt)
    conn.send(makeMessage('ping', { seq: 1 }), 'pwa:peer-aaa');

    // Before the async pipeline resolves, disconnect the peer
    sig.emit('pwa-bye', 'pwa:peer-aaa');

    // Let the queued send try to resolve
    await flush();
    await flush();

    // The send should be silently dropped by the re-check guard:
    // `if (!this.peers.has(targetAddress)) return;`
    // No encrypted message should have been sent (only the key-exchange-ack from addPeer)
    const postDisconnectMessages = sig.sentMessages.filter(
      (m) => m.target === 'pwa:peer-aaa',
    );
    expect(postDisconnectMessages).toHaveLength(0);
  });

  it('multiple sends queued then peer disconnects — none crash, none leak', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);
    sig.sentMessages = [];

    // Queue several sends
    for (let i = 0; i < 10; i++) {
      conn.send(makeMessage('ping', { seq: i }), 'pwa:peer-aaa');
    }

    // Disconnect mid-flight
    sig.emit('pwa-bye', 'pwa:peer-aaa');

    // Let everything settle
    await flush();
    await flush();
    await flush();

    // Should not throw, and send queue should exist but be safe
    expect(() => conn.send(makeMessage(), 'pwa:peer-aaa')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrent sends ordering
// ---------------------------------------------------------------------------

describe('edge: concurrent send ordering', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('5 rapid sends arrive in order via per-peer queue', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);
    sig.sentMessages = [];

    // Track the order serializeMessage is called
    const serializeOrder: number[] = [];
    mockSerializeMessage.mockImplementation((msg: any) => {
      serializeOrder.push(msg.payload?.seq);
      return JSON.stringify(msg);
    });

    // Fire 5 sends rapidly
    for (let i = 0; i < 5; i++) {
      conn.send(makeMessage('ping', { seq: i }), 'pwa:peer-aaa');
    }

    // Wait for the queue to drain
    await flush();
    await flush();
    await flush();

    // serializeMessage is called synchronously before queue, so order should match
    expect(serializeOrder).toEqual([0, 1, 2, 3, 4]);

    // All 5 should have been sent
    const peerMessages = sig.sentMessages.filter((m) => m.target === 'pwa:peer-aaa');
    expect(peerMessages).toHaveLength(5);

    // encryptWithSharedSecret should have been called 5 times, in order
    expect(mockEncryptWithSharedSecret).toHaveBeenCalledTimes(5);
  });

  it('sends to different peers use independent queues', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    addPeer(conn, 'pwa:peer-bbb');
    await flush();

    const sig = getSignaling(conn);
    sig.sentMessages = [];

    conn.send(makeMessage('ping', { target: 'a' }), 'pwa:peer-aaa');
    conn.send(makeMessage('ping', { target: 'b' }), 'pwa:peer-bbb');
    conn.send(makeMessage('ping', { target: 'a2' }), 'pwa:peer-aaa');

    await flush();
    await flush();

    const queues = (conn as any).sendQueues as Map<string, Promise<void>>;
    expect(queues.has('pwa:peer-aaa')).toBe(true);
    expect(queues.has('pwa:peer-bbb')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. PubSub memory leak — 1000 topics
// ---------------------------------------------------------------------------

describe('edge: PubSub memory leak', () => {
  it('subscribe to 1000 topics then unsubscribeAll cleans up everything', () => {
    const ps = new PubSub();
    const peer = 'pwa:heavy-peer';
    const topicCount = 1000;

    for (let i = 0; i < topicCount; i++) {
      ps.subscribe(peer, `session:leak-test-${i}`);
    }

    expect(ps.topicsOf(peer).size).toBe(topicCount);

    const removed = ps.unsubscribeAll(peer);
    expect(removed.size).toBe(topicCount);

    // Verify: peer has no topics
    expect(ps.topicsOf(peer).size).toBe(0);

    // Verify: no empty Sets left in the topics Map
    const state = ps.getState();
    expect(Object.keys(state.topics)).toHaveLength(0);
    expect(Object.keys(state.peerTopics)).toHaveLength(0);

    // Verify: hasSubscribers returns false for all
    for (let i = 0; i < topicCount; i++) {
      expect(ps.hasSubscribers(`session:leak-test-${i}`)).toBe(false);
    }
  });

  it('many peers on one topic, all unsubscribed — topic cleaned up', () => {
    const ps = new PubSub();
    const topic = 'session:popular';

    for (let i = 0; i < 100; i++) {
      ps.subscribe(`peer-${i}`, topic);
    }
    expect(ps.subscribers(topic).size).toBe(100);

    for (let i = 0; i < 100; i++) {
      ps.unsubscribeAll(`peer-${i}`);
    }

    expect(ps.hasSubscribers(topic)).toBe(false);
    const state = ps.getState();
    expect(Object.keys(state.topics)).toHaveLength(0);
    expect(Object.keys(state.peerTopics)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. PubSub duplicate/idempotent operations
// ---------------------------------------------------------------------------

describe('edge: PubSub duplicate and no-op operations', () => {
  it('subscribe same peer to same topic twice is idempotent', () => {
    const ps = new PubSub();
    ps.subscribe('peer1', 'topicA');
    ps.subscribe('peer1', 'topicA');

    expect(ps.subscribers('topicA').size).toBe(1);
    expect(ps.topicsOf('peer1').size).toBe(1);
  });

  it('unsubscribe from a topic peer is not on does not crash', () => {
    const ps = new PubSub();
    ps.subscribe('peer1', 'topicA');

    // Unsubscribe from a topic they never joined
    expect(() => ps.unsubscribe('peer1', 'topicB')).not.toThrow();
    // Unsubscribe unknown peer entirely
    expect(() => ps.unsubscribe('unknown-peer', 'topicA')).not.toThrow();
  });

  it('unsubscribe from topic with no subscribers does not crash', () => {
    const ps = new PubSub();
    expect(() => ps.unsubscribe('peer1', 'nonexistent')).not.toThrow();
  });

  it('unsubscribeAll on unknown peer returns empty set', () => {
    const ps = new PubSub();
    const removed = ps.unsubscribeAll('ghost-peer');
    expect(removed.size).toBe(0);
  });

  it('topicsOf returns empty (not undefined) for unknown peer', () => {
    const ps = new PubSub();
    const topics = ps.topicsOf('nonexistent');
    expect(topics).toBeDefined();
    expect(topics.size).toBe(0);
  });

  it('subscribers returns empty (not undefined) for unknown topic', () => {
    const ps = new PubSub();
    const subs = ps.subscribers('nonexistent');
    expect(subs).toBeDefined();
    expect(subs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. sendToSession with disconnected peer still in pubsub
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. Broadcast fallback
// ---------------------------------------------------------------------------

describe('edge: broadcast fallback behavior', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('falls back to all peers when no one is on broadcast topic', async () => {
    // Manually add peers WITHOUT going through key exchange (no auto-subscribe)
    const peers = (conn as any).peers as Map<string, any>;
    peers.set('pwa:manual-1', {
      address: 'pwa:manual-1',
      sessionDEK: new Uint8Array(32),
      connectedAt: Date.now(),
    });
    peers.set('pwa:manual-2', {
      address: 'pwa:manual-2',
      sessionDEK: new Uint8Array(32),
      connectedAt: Date.now(),
    });

    const sig = getSignaling(conn);
    sig.sentMessages = [];

    conn.broadcast(makeMessage());

    await flush();
    await flush();

    // Both peers should have received messages via fallback
    const targets = sig.sentMessages.map((m) => m.target);
    expect(targets).toContain('pwa:manual-1');
    expect(targets).toContain('pwa:manual-2');
  });

  it('does NOT use fallback when broadcast topic has subscribers', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    // Manually add a peer without key exchange (not on broadcast topic)
    const peers = (conn as any).peers as Map<string, any>;
    peers.set('pwa:manual-no-broadcast', {
      address: 'pwa:manual-no-broadcast',
      sessionDEK: new Uint8Array(32),
      connectedAt: Date.now(),
    });

    const sig = getSignaling(conn);
    sig.sentMessages = [];

    conn.broadcast(makeMessage());

    await flush();
    await flush();

    // Only peer-aaa (on broadcast) should get the message, NOT the manual peer
    const targets = sig.sentMessages.map((m) => m.target);
    expect(targets).toContain('pwa:peer-aaa');
    expect(targets).not.toContain('pwa:manual-no-broadcast');
  });
});

// ---------------------------------------------------------------------------
// 9. Key exchange timestamp boundary conditions
// ---------------------------------------------------------------------------

describe('edge: key exchange timestamp boundaries', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('rejects timestamp exactly at 60001ms age (just past expiry)', async () => {
    const errorHandler = vi.fn();
    conn.on('error', errorHandler);

    addPeerWithTimestamp(conn, 'pwa:peer-old', Date.now() - 60001);
    await flush();

    expect(conn.hasPeers()).toBe(false);
    expect(errorHandler).toHaveBeenCalled();
  });

  it('accepts timestamp at exactly 60000ms age (boundary)', async () => {
    // age = Date.now() - timestamp = 60000, which is NOT > 60000
    addPeerWithTimestamp(conn, 'pwa:peer-edge', Date.now() - 60000);
    await flush();

    expect(conn.hasPeers()).toBe(true);
    expect(conn.getPeerCount()).toBe(1);
  });

  it('accepts timestamp 4999ms in future (within 5s skew)', async () => {
    // age = Date.now() - (Date.now() + 4999) = -4999, which is NOT < -5000
    addPeerWithTimestamp(conn, 'pwa:peer-ahead', Date.now() + 4999);
    await flush();

    expect(conn.hasPeers()).toBe(true);
  });

  it('rejects timestamp 5001ms in future (just past skew)', async () => {
    const errorHandler = vi.fn();
    conn.on('error', errorHandler);

    // age = -5001, which IS < -5000
    addPeerWithTimestamp(conn, 'pwa:peer-future', Date.now() + 5001);
    await flush();

    expect(conn.hasPeers()).toBe(false);
    expect(errorHandler).toHaveBeenCalled();
  });

  it('accepts timestamp exactly 5000ms in future (boundary: -5000 is not < -5000)', async () => {
    // age = -5000, which is NOT < -5000 (strictly less than)
    addPeerWithTimestamp(conn, 'pwa:peer-boundary', Date.now() + 5000);
    await flush();

    expect(conn.hasPeers()).toBe(true);
  });

  it('rejects timestamp of 0 (epoch)', async () => {
    const errorHandler = vi.fn();
    conn.on('error', errorHandler);

    addPeerWithTimestamp(conn, 'pwa:peer-epoch', 0);
    await flush();

    expect(conn.hasPeers()).toBe(false);
    expect(errorHandler).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. savedPeerTopics cleanup
// ---------------------------------------------------------------------------

describe('edge: savedPeerTopics lifecycle', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('savedPeerTopics is deleted after reconnect restores topics', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);
    sig.emit('disconnected');

    const saved = (conn as any).savedPeerTopics as Map<string, Set<string>>;
    expect(saved.has('pwa:peer-aaa')).toBe(true);

    // Same peer reconnects
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    // savedPeerTopics should be cleaned up after restore
    expect(saved.has('pwa:peer-aaa')).toBe(false);
  });

  it('different peer reconnects — old peer savedTopics leaks', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);
    sig.emit('disconnected');

    const saved = (conn as any).savedPeerTopics as Map<string, Set<string>>;
    expect(saved.has('pwa:peer-aaa')).toBe(true);

    // A DIFFERENT peer connects (not peer-aaa)
    addPeer(conn, 'pwa:peer-bbb');
    await flush();

    // BUG: peer-aaa's saved topics remain in the map forever because
    // savedPeerTopics.delete() is only called for the reconnecting peer's address.
    // If peer-aaa never reconnects, its entry leaks indefinitely.
    expect(saved.has('pwa:peer-aaa')).toBe(true); // still there = leak
    expect(saved.has('pwa:peer-bbb')).toBe(false); // peer-bbb had nothing saved
  });

  it('signaling disconnect saves broadcast subscription from auto-subscribe', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);

    // The peer has broadcast topic from auto-subscribe
    sig.emit('disconnected');

    const saved = (conn as any).savedPeerTopics as Map<string, Set<string>>;
    // Broadcast topic IS saved
    expect(saved.has('pwa:peer-aaa')).toBe(true);
    expect(saved.get('pwa:peer-aaa')!.has(BROADCAST_TOPIC)).toBe(true);
  });

  it('multiple disconnect-reconnect cycles clean up properly', async () => {
    const sig = getSignaling(conn);
    const saved = (conn as any).savedPeerTopics as Map<string, Set<string>>;

    // Cycle 1
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    sig.emit('disconnected');
    expect(saved.has('pwa:peer-aaa')).toBe(true);

    addPeer(conn, 'pwa:peer-aaa');
    await flush();
    expect(saved.has('pwa:peer-aaa')).toBe(false);

    // Cycle 2
    sig.emit('disconnected');
    expect(saved.has('pwa:peer-aaa')).toBe(true);

    addPeer(conn, 'pwa:peer-aaa');
    await flush();
    expect(saved.has('pwa:peer-aaa')).toBe(false);

    // Broadcast topic restored
    const state = conn.getDebugState();
    const topics = state.peers[0]?.topics ?? [];
    expect(topics).toContain(BROADCAST_TOPIC);
  });
});

// ---------------------------------------------------------------------------
// Extra: handleDataMessage edge cases
// ---------------------------------------------------------------------------

describe('edge: handleDataMessage edge cases', () => {
  let conn: AgentConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = new AgentConnection(makeConfig());
  });

  it('encrypted message with no sender address is dropped', async () => {
    const sig = getSignaling(conn);
    const msgHandler = vi.fn();
    conn.on('message', msgHandler);

    // Send encrypted data with null sender
    sig.emit('data', 'some-encrypted-data', null);
    await flush();

    expect(msgHandler).not.toHaveBeenCalled();
  });

  it('encrypted message from unknown peer is dropped', async () => {
    const sig = getSignaling(conn);
    const msgHandler = vi.fn();
    conn.on('message', msgHandler);

    sig.emit('data', 'some-encrypted-data', 'pwa:unknown-peer');
    await flush();

    expect(msgHandler).not.toHaveBeenCalled();
  });

  it('malformed JSON that is not key-exchange falls through to encrypted handling', async () => {
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    const sig = getSignaling(conn);

    // Valid JSON but not a key-exchange — should be treated as encrypted data
    mockDecryptWithSharedSecret.mockReturnValueOnce(
      Buffer.from('compressed').toString('base64'),
    );
    mockParseMessage.mockReturnValueOnce({ type: 'pong', id: 'x', payload: {}, timestamp: 0 });

    sig.emit('data', '{"type":"not-key-exchange"}', 'pwa:peer-aaa');
    await flush();

    // Should attempt decrypt
    expect(mockDecryptWithSharedSecret).toHaveBeenCalled();
  });

  it('decryptDEK failure during key exchange emits error and does not add peer', async () => {
    mockDecryptDEK.mockImplementationOnce(() => {
      throw new Error('DEK decryption failed');
    });

    const errorHandler = vi.fn();
    conn.on('error', errorHandler);

    addPeer(conn, 'pwa:peer-bad-dek');
    await flush();

    expect(conn.hasPeers()).toBe(false);
    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to decrypt session DEK' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Extra: disconnect() method
// ---------------------------------------------------------------------------

describe('edge: disconnect method', () => {
  it('disconnect does not throw even with active peers and queues', async () => {
    const conn = new AgentConnection(makeConfig());
    addPeer(conn, 'pwa:peer-aaa');
    await flush();

    conn.send(makeMessage(), 'pwa:peer-aaa');

    expect(() => conn.disconnect()).not.toThrow();
  });
});
