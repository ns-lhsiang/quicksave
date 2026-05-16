// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { EventEmitter } from 'events';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import {
  generateKeyPair,
  encodeKeyPair,
  decodeKeyPair,
  decodeBase64,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
  decryptDEK,
  parseMessage,
  serializeMessage,
  verifyKeyExchangeV2Signature,
  type Message,
  type KeyPair,
  type KeyExchangeV2,
} from '@sumicom/quicksave-shared';
import { SignalingClient } from './relay.js';
import { PubSub, BROADCAST_TOPIC } from './pubsub.js';
import {
  clearPeerPWA,
  isPaired,
  loadConfig,
  pinPeerPWA,
  saveConfig,
  unlockPairingAndRotate,
  type AgentConfig,
} from '../config.js';
import {
  checkTombstone,
  hashPublicKey,
  verifyTombstonePayload,
  type TombstoneCheckResult,
} from '../tombstoneCheck.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ConnectionConfig {
  signalingServer: string;
  agentId: string;
  keyPair: { publicKey: string; secretKey: string };
}

export interface PeerSession {
  address: string;
  sessionDEK: Uint8Array;
  connectedAt: number;
}

export interface AgentConnectionEvents {
  connected: (peerAddress: string) => void;
  disconnected: (peerAddress: string) => void;
  message: (message: Message, peerAddress: string) => void;
  error: (error: Error) => void;
  /**
   * A verified tombstone was observed for the pinned peer PWA group. Config
   * has already been cleared and the keypair rotated. Upper layers should
   * typically stop the process or prompt the user to run `quicksave pair`.
   */
  tombstoned: (details: { oldPublicKey: string }) => void;
}

/**
 * Coarse-grained agent pairing state surfaced to the CLI + telemetry.
 *
 * - `unpaired`: ready to TOFU a new PWA group on the next handshake
 * - `paired`:   peerPWA identity is pinned; handshakes validated against it
 * - `closed`:   tombstone was observed; all incoming handshakes are refused
 *               until `unlockPairing()` is called (e.g. by `quicksave pair`)
 */
export type AgentPairState = 'unpaired' | 'paired' | 'closed';

export class AgentConnection extends EventEmitter {
  private config: ConnectionConfig;
  private signaling: SignalingClient;
  private keyPair: KeyPair;
  private peers: Map<string, PeerSession> = new Map();
  private pubsub = new PubSub();

  // Saved session topics per peer — restored after relay reconnect so the peer
  // doesn't lose its pubsub subscriptions during a brief relay blip.
  private savedPeerTopics: Map<string, Set<string>> = new Map();

  // Key exchange replay protection
  private static readonly KEY_EXCHANGE_MAX_AGE_MS = 60000; // 60 seconds

  // Auto-unpair after repeated sigPubkey mismatches (PWA lost its IndexedDB keys)
  private static readonly MISMATCH_AUTO_UNPAIR_THRESHOLD = 3;
  private sigPubkeyMismatchCount = 0;

  // Periodic catch-up GET fallback. Runs even when the relay-push channel is
  // healthy — if the push path is silently broken (relay restart before we
  // resubscribe, proxy dropping the message, etc.) this still catches the
  // rotation within 3 minutes. 180s is the ceiling the user signed off on;
  // tighter intervals trade latency for relay load that's not worth paying
  // unless we see an incident.
  private static readonly TOMBSTONE_POLL_MS = 180_000;
  private tombstonePollTimer: ReturnType<typeof setInterval> | null = null;
  /** The keyHash we currently have an active relay subscription for, if any. */
  private subscribedKeyHash: string | null = null;

  constructor(config: ConnectionConfig) {
    super();
    this.config = config;
    this.keyPair = decodeKeyPair(config.keyPair);
    this.signaling = new SignalingClient(config.signalingServer, config.agentId);
    this.setupSignalingHandlers();
  }

  private setupSignalingHandlers(): void {
    this.signaling.on('connected', () => {
      // Each (re)connect is a chance to catch up on a missed tombstone.
      void this.runTombstoneCheck();
      // (Re-)subscribe the push channel if we already know the pinned peer.
      // Unpaired agents have no mailbox to watch yet; TOFU will call this
      // helper explicitly after pinning.
      this.resubscribeIfPaired();
    });

    this.signaling.on('peer-connected', () => {
      console.log('PWA peer connected, waiting for key exchange...');
    });

    this.signaling.on('data', (data: string, from: string | null) => {
      this.handleDataMessage(data, from);
    });

    this.signaling.on('peer-disconnected', () => {
      // Legacy compatibility: only affects legacy (non-key-based) peers
      // Key-based peers use 'pwa-bye' for targeted disconnect
      for (const [address] of this.peers) {
        this.handlePeerDisconnected(address);
      }
    });

    // Targeted disconnect for key-based PWAs
    this.signaling.on('pwa-bye', (pwaAddress: string) => {
      this.handlePeerDisconnected(pwaAddress);
    });

    // Reset encryption state when WebSocket reconnects (before peer-disconnected)
    this.signaling.on('disconnected', () => {
      // Save each peer's session topics so we can restore them after reconnect
      for (const [address] of this.peers) {
        const topics = this.pubsub.topicsOf(address);
        if (topics.size > 0) {
          this.savedPeerTopics.set(address, new Set(topics));
        }
        this.pubsub.unsubscribeAll(address);
        this.emit('disconnected', address);
      }
      this.peers.clear();
    });

    this.signaling.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Relay-pushed tombstone — the emergency fast path. We still verify locally
    // with the pinned signing pubkey because the relay is untrusted; a forged
    // payload here will simply fail verification and be dropped.
    this.signaling.on('tombstone-event', (keyHash: string, data: string) => {
      this.handlePushedTombstone(keyHash, data);
    });
  }

  private handlePushedTombstone(keyHash: string, data: string): void {
    // Short-circuit once we're already closed: the catch-up GET and the push
    // path can both fire for the same tombstone, and after the first handler
    // runs `peerPWAPublicKey` is null on disk.
    if (this.getState() === 'closed') return;
    const config = loadConfig();
    if (!config || !isPaired(config)) return;
    const expectedHash = hashPublicKey(config.peerPWAPublicKey!);
    if (keyHash !== expectedHash) {
      // Ignore pushes for mailboxes we aren't pinned to. Shouldn't happen
      // because we only subscribe to our pinned peer, but the relay is
      // untrusted so we verify anyway.
      return;
    }
    const result = verifyTombstonePayload(
      data,
      config.peerPWAPublicKey!,
      config.peerPWASignPublicKey!,
    );
    if (result.status === 'tombstoned') {
      this.handleVerifiedTombstone(result.tombstone.oldPublicKey);
    } else if (result.status === 'verify-failed') {
      console.error(`Pushed tombstone verification failed: ${result.reason}`);
    }
  }

  /**
   * Subscribe to the pinned peer's tombstone mailbox via the relay push
   * channel, if the agent is currently paired. Idempotent: safe to call from
   * both `connected` and TOFU completion paths.
   */
  private resubscribeIfPaired(): void {
    const config = loadConfig();
    if (!config || !isPaired(config)) return;
    const keyHash = hashPublicKey(config.peerPWAPublicKey!);
    if (this.subscribedKeyHash === keyHash) {
      // Already subscribed to the same key — but the SignalingClient replays
      // its own subscription set on reconnect, so we don't need to re-send.
      return;
    }
    // If we were subscribed to an old key (e.g. after unlockPairing), drop it.
    if (this.subscribedKeyHash) {
      this.signaling.unsubscribeTombstone(this.subscribedKeyHash);
    }
    this.signaling.subscribeTombstone(keyHash);
    this.subscribedKeyHash = keyHash;
  }

  async start(): Promise<void> {
    console.log('Connecting to signaling server...');
    await this.signaling.connect();
    console.log('Connected to signaling server');
    console.log(`Agent ID: ${this.config.agentId}`);
    console.log(`Public Key: ${this.config.keyPair.publicKey}`);
    // Tombstone catch-up runs from the 'connected' handler registered in
    // setupSignalingHandlers(), so every reconnect re-checks too. Also start
    // the 180s periodic fallback in case the push channel silently breaks.
    this.startTombstonePolling();
  }

  /**
   * Check the pinned peer's mailbox for a signed tombstone. No-op if the
   * agent is not currently paired. Exposed so the signaling reconnect path
   * can piggy-back on the check without re-implementing the policy.
   */
  async runTombstoneCheck(): Promise<TombstoneCheckResult | null> {
    const config = loadConfig();
    if (!config || !isPaired(config)) return null;
    const result = await checkTombstone({
      signalingServer: this.config.signalingServer,
      peerPWAPublicKey: config.peerPWAPublicKey!,
      peerPWASignPublicKey: config.peerPWASignPublicKey!,
    });
    if (result.status === 'tombstoned') {
      this.handleVerifiedTombstone(result.tombstone.oldPublicKey);
    } else if (result.status === 'verify-failed') {
      console.error(`Tombstone check: verification failed (${result.reason})`);
    } else if (result.status === 'error') {
      // Network / transient errors are non-fatal; we'll recheck next connect.
      console.error(`Tombstone check: ${result.error}`);
    }
    return result;
  }

  /**
   * Invoked when a valid tombstone for the pinned peer group has been
   * observed. Clears peer identity state on disk (which also rotates the
   * agent's own keypair), tears down all active peer sessions, and emits
   * `tombstoned` for upper layers. The signaling transport is left running
   * so the agent can accept a fresh TOFU handshake from a rotated group.
   */
  /**
   * Coarse pair-state for CLI + telemetry. Reads the (possibly freshly-saved)
   * config on each call so the answer stays accurate after tombstone cleanup.
   * `closed` is now persisted on disk (`config.closed`), so a daemon restart
   * preserves the self-destructed state.
   */
  getState(): AgentPairState {
    const config = loadConfig();
    if (!config) return 'unpaired';
    if (config.closed) return 'closed';
    return isPaired(config) ? 'paired' : 'unpaired';
  }

  /**
   * Lift the `closed` gate and rotate the agent's own cryptographic identity
   * (`agentId`, X25519 keypair, Ed25519 signing keypair). Called by the
   * `quicksave pair` CLI path. Tears down the current signaling connection
   * and reconnects with the new `agentId` so old routing addresses stop
   * receiving traffic. Safe to call from any state.
   */
  async unlockPairing(): Promise<AgentConfig> {
    const newConfig = unlockPairingAndRotate();
    this.config = {
      ...this.config,
      agentId: newConfig.agentId,
      keyPair: newConfig.keyPair,
    };
    this.keyPair = decodeKeyPair(newConfig.keyPair);

    // Tear down every active peer session — old DEKs are irrelevant under the
    // rotated keypair anyway.
    for (const [address] of this.peers) {
      this.pubsub.unsubscribeAll(address);
      this.emit('disconnected', address);
    }
    this.peers.clear();
    this.savedPeerTopics.clear();

    // No pinned mailbox yet under the rotated identity — clear the locally
    // tracked subscription so the next TOFU can subscribe fresh.
    this.subscribedKeyHash = null;

    // Reinstantiate signaling under the new agentId so the relay routes to
    // this process under the new address only.
    this.signaling.removeAllListeners();
    this.signaling.disconnect();
    this.signaling = new SignalingClient(
      this.config.signalingServer,
      newConfig.agentId,
    );
    this.setupSignalingHandlers();
    try {
      await this.signaling.connect();
    } catch (err) {
      console.error('Signaling reconnect after unlockPairing failed:', err);
      // Leave the SignalingClient object in place; its own reconnect loop
      // will keep trying.
    }

    this.emit('identity-rotated', { agentId: newConfig.agentId });
    return newConfig;
  }

  private handleVerifiedTombstone(oldPublicKey: string): void {
    // Idempotency guard: the push-channel event and the catch-up GET can race,
    // and both may fire before the first one has finished writing to disk. The
    // persisted `closed` flag is the canonical answer; once set, we ignore
    // further tombstone triggers until `unlockPairing()` clears it.
    if (this.getState() === 'closed') {
      return;
    }
    console.warn(
      `Tombstone verified for pinned peer ${oldPublicKey.slice(0, 12)}... — self-destructing pairing`,
    );
    // Best-effort unsubscribe from the relay push channel; the closed-state
    // gate in handleKeyExchange is the real line of defense.
    if (this.subscribedKeyHash) {
      this.signaling.unsubscribeTombstone(this.subscribedKeyHash);
      this.subscribedKeyHash = null;
    }
    this.stopTombstonePolling();
    // Tear down every active peer session first so no leftover DEK answers.
    for (const [address] of this.peers) {
      this.pubsub.unsubscribeAll(address);
      this.emit('disconnected', address);
    }
    this.peers.clear();
    this.savedPeerTopics.clear();
    try {
      clearPeerPWA();
    } catch (err) {
      console.error('clearPeerPWA failed during tombstone handling:', err);
    }
    this.emit('tombstoned', { oldPublicKey });
  }

  private startTombstonePolling(): void {
    if (this.tombstonePollTimer) return;
    this.tombstonePollTimer = setInterval(() => {
      // Errors and 'absent' are silent — treated as no-op, same as the existing
      // runTombstoneCheck behaviour. We only act on verified tombstones.
      void this.runTombstoneCheck();
    }, AgentConnection.TOMBSTONE_POLL_MS);
    // Don't block process shutdown on the polling timer.
    this.tombstonePollTimer.unref?.();
  }

  private stopTombstonePolling(): void {
    if (this.tombstonePollTimer) {
      clearInterval(this.tombstonePollTimer);
      this.tombstonePollTimer = null;
    }
  }

  private async handleDataMessage(data: string, from: string | null): Promise<void> {
    try {
      // Always check for key-exchange messages first
      // Always accept new key-exchange (PWA may have refreshed with new DEK)
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'key-exchange') {
          await this.handleKeyExchange(parsed, from);
          return;
        }
      } catch {
        // Not JSON - continue to encrypted message handling
      }

      // Look up peer by from address to get correct DEK
      if (!from) {
        console.error('Received encrypted message with no sender address');
        return;
      }

      const peer = this.peers.get(from);
      if (!peer) {
        console.error(`No peer session found for ${from}`);
        return;
      }

      // Post key-exchange: messages are encrypted, then the plaintext was compressed before encryption
      // Decrypt first, then decompress
      const decrypted = decryptWithSharedSecret(data, peer.sessionDEK);
      const buffer = Buffer.from(decrypted, 'base64');
      const decompressed = await gunzipAsync(buffer);
      const message = parseMessage(decompressed.toString('utf-8'));
      this.emit('message', message, from);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  }

  /**
   * Handle key exchange message
   */
  private async handleKeyExchange(message: KeyExchangeV2, from: string | null): Promise<void> {
    // Closed state gate: once we've self-destructed from a tombstone, refuse
    // any handshake until an operator runs `quicksave pair` (which calls
    // `unlockPairing()`). Sourced from the persisted `config.closed` flag.
    if (this.getState() === 'closed') {
      console.error('Agent is in closed state; refusing key exchange until `quicksave pair` is run');
      this.emit('error', new Error('Agent closed after tombstone; run `quicksave pair` to re-enable'));
      return;
    }

    // Verify timestamp for replay protection
    const age = Date.now() - message.timestamp;
    if (age > AgentConnection.KEY_EXCHANGE_MAX_AGE_MS) {
      console.error(`Key exchange expired (age: ${age}ms)`);
      this.emit('error', new Error('Key exchange expired'));
      return;
    }

    if (age < -5000) {
      // Allow 5 second clock skew into the future
      console.error(`Key exchange timestamp in future (age: ${age}ms)`);
      this.emit('error', new Error('Key exchange timestamp invalid'));
      return;
    }

    // Proof-of-possession: the PWA must sign the canonical key-exchange body
    // with the group's shared Ed25519 key. On the first successful handshake
    // we TOFU-pin that key; after that, sigPubkey must match the pinned one.
    if (!message.sigPubkey || !message.signature) {
      console.error('Key exchange missing sigPubkey/signature — rejecting pre-TOFU legacy peer');
      this.emit('error', new Error('Key exchange missing signature'));
      return;
    }
    const sigValid = verifyKeyExchangeV2Signature({
      agentId: this.config.agentId,
      encryptedDEK: message.encryptedDEK,
      timestamp: message.timestamp,
      sigPubkey: message.sigPubkey,
      signature: message.signature,
      decodeBase64,
    });
    if (!sigValid) {
      console.error('Key exchange signature verification failed');
      this.emit('error', new Error('Key exchange signature invalid'));
      return;
    }

    const config = loadConfig();
    if (config && isPaired(config)) {
      if (message.sigPubkey !== config.peerPWASignPublicKey) {
        this.sigPubkeyMismatchCount++;
        if (this.sigPubkeyMismatchCount >= AgentConnection.MISMATCH_AUTO_UNPAIR_THRESHOLD) {
          console.log(
            `SigPubkey mismatch ${this.sigPubkeyMismatchCount}x — PWA likely lost its keys. Auto-unpairing to allow re-TOFU.`,
          );
          this.sigPubkeyMismatchCount = 0;
          config.peerPWAPublicKey = null;
          config.peerPWASignPublicKey = null;
          saveConfig(config);
          // Fall through to the unpaired TOFU path below
        } else {
          console.error(
            `Key exchange sigPubkey does not match pinned peer — rejecting (${this.sigPubkeyMismatchCount}/${AgentConnection.MISMATCH_AUTO_UNPAIR_THRESHOLD})`,
          );
          this.emit(
            'error',
            new Error('Key exchange sigPubkey mismatch (peer not the pinned PWA group)'),
          );
          return;
        }
      } else {
        this.sigPubkeyMismatchCount = 0;
      }
    }

    if (config && !isPaired(config)) {
      // Unpaired: TOFU. Pin the claimed signing key (and the PWA's X25519
      // pubkey, derived from the routed address — `pwa:{publicKey}`) for
      // all future handshakes.
      const peerPWAPublicKey = (from ?? '').replace(/^pwa:/, '');
      if (peerPWAPublicKey && config) {
        try {
          pinPeerPWA(peerPWAPublicKey, message.sigPubkey);
          console.log(
            `TOFU: pinned peer PWA pubkey ${peerPWAPublicKey.slice(0, 12)}... ` +
              `sig ${message.sigPubkey.slice(0, 12)}...`,
          );
          // Now that we have a pinned mailbox, start listening for pushed
          // tombstones on it. Idempotent.
          this.resubscribeIfPaired();
        } catch (err) {
          console.error('TOFU pin failed:', err);
          this.emit(
            'error',
            err instanceof Error ? err : new Error('TOFU pin failed'),
          );
          return;
        }
      }
    }

    // Decrypt the session DEK
    try {
      const sessionDEK = decryptDEK(message.encryptedDEK, this.keyPair.secretKey);
      const peerAddress = from || 'unknown';
      const peerKey = peerAddress.replace('pwa:', '');
      console.log(`Key exchange complete with ${peerKey.slice(0, 12)}..., connection encrypted`);

      const isReconnect = this.peers.has(peerAddress);

      if (isReconnect) {
        // Peer reconnected with new DEK — clean up old session state first
        this.emit('disconnected', peerAddress);
      }

      // Create/update PeerSession for that address
      this.peers.set(peerAddress, {
        address: peerAddress,
        sessionDEK,
        connectedAt: Date.now(),
      });

      this.emit('connected', peerAddress);

      // Auto-subscribe new peers to broadcast topic
      this.pubsub.subscribe(peerAddress, BROADCAST_TOPIC);

      // Restore saved session topics from before relay disconnect
      const savedTopics = this.savedPeerTopics.get(peerAddress);
      if (savedTopics) {
        for (const topic of savedTopics) {
          if (topic !== BROADCAST_TOPIC) {
            this.pubsub.subscribe(peerAddress, topic);
          }
        }
        this.savedPeerTopics.delete(peerAddress);
        console.log(`[reconnect] restored ${savedTopics.size} topic(s) for ${peerAddress.slice(0, 12)}`);
      }

      // V2: Send acknowledgment
      const ack = JSON.stringify({
        type: 'key-exchange-ack',
        version: 2,
      });
      this.signaling.sendData(ack, peerAddress);
    } catch (error) {
      console.error('Failed to decrypt session DEK:', error);
      this.emit('error', new Error('Failed to decrypt session DEK'));
    }
  }

  // Per-peer send queue to guarantee message ordering.
  // gzipAsync is non-blocking — without serialization, fast consecutive
  // send() calls can compress out of order and arrive at the relay scrambled.
  private sendQueues: Map<string, Promise<void>> = new Map();

  send(message: Message, targetAddress: string): void {
    const peer = this.peers.get(targetAddress);
    if (!peer) {
      console.error(`No peer session for ${targetAddress}, cannot encrypt message`);
      return;
    }

    const serialized = serializeMessage(message);
    const prev = this.sendQueues.get(targetAddress) ?? Promise.resolve();
    const next = prev.then(async () => {
      // Re-check peer: may have disconnected while queued
      if (!this.peers.has(targetAddress)) return;
      const compressed = await gzipAsync(Buffer.from(serialized));
      const compressedBase64 = compressed.toString('base64');
      const encrypted = encryptWithSharedSecret(compressedBase64, peer.sessionDEK);
      this.signaling.sendData(encrypted, targetAddress);
    }).catch((error) => {
      console.error('Failed to send message:', error);
    });
    this.sendQueues.set(targetAddress, next);
  }

  private handlePeerDisconnected(peerAddress: string): void {
    if (this.peers.has(peerAddress)) {
      this.peers.delete(peerAddress);
      const removedTopics = this.pubsub.unsubscribeAll(peerAddress);
      if (removedTopics.size > 0) {
        console.log(`[disconnect] ${peerAddress.slice(0, 12)} removed from ${removedTopics.size} topics`);
      }
      this.emit('disconnected', peerAddress);
    }

    console.log('Peer disconnected, waiting for new connection...');
  }

  disconnect(): void {
    this.stopTombstonePolling();
    this.signaling.disconnect();
  }

  getPublicKey(): string {
    return this.config.keyPair.publicKey;
  }

  getAgentId(): string {
    return this.config.agentId;
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  hasPeers(): boolean {
    return this.peers.size > 0;
  }

  /** Debug snapshot of peers and pubsub state. */
  getDebugState(): { peers: Array<{ address: string; connectedAt: number; topics: string[] }>; subscriptions: Record<string, string[]> } {
    const peers = Array.from(this.peers.entries()).map(([addr, ps]) => ({
      address: addr.slice(0, 16),
      connectedAt: ps.connectedAt,
      topics: [...(this.pubsub.topicsOf(addr))],
    }));
    const { topics } = this.pubsub.getState();
    const subscriptions: Record<string, string[]> = {};
    for (const [topic, addrs] of Object.entries(topics)) {
      subscriptions[topic] = addrs.map(a => a.slice(0, 16));
    }
    return { peers, subscriptions };
  }

  /** Send a message to all connected peers via broadcast topic. */
  broadcast(message: Message): void {
    const subscribers = this.pubsub.subscribers(BROADCAST_TOPIC);
    if (subscribers.size > 0) {
      for (const address of subscribers) {
        if (this.peers.has(address)) {
          this.send(message, address);
        }
      }
    } else {
      // Fallback: peers connected but haven't subscribed yet
      for (const [address] of this.peers) {
        this.send(message, address);
      }
    }
  }

}

/**
 * Generate and encode a new key pair for the agent
 */
export function generateAgentKeyPair(): { publicKey: string; secretKey: string } {
  return encodeKeyPair(generateKeyPair());
}
