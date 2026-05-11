// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import type { SignalingMessage } from '@sumicom/quicksave-shared';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface SignalingEvents {
  'peer-connected': () => void;
  'peer-disconnected': () => void;
  data: (data: string, from: string | null) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  'tombstone-event': (keyHash: string, data: string) => void;
}

export class SignalingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private agentId: string;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 90000;
  private isConnected = false;
  /** Active tombstone subscriptions keyed by `keyHash`. Replayed on reconnect. */
  private tombstoneSubscriptions = new Set<string>();

  constructor(signalingServer: string, agentId: string) {
    super();
    this.url = `${signalingServer}/agent/${agentId}`;
    this.agentId = agentId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url, {
          rejectUnauthorized: false,
        });

        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          // Replay active tombstone subscriptions so reconnects don't leave the
          // agent silently unsubscribed after a relay restart or network blip.
          for (const keyHash of this.tombstoneSubscriptions) {
            this.sendRaw({
              type: 'tombstone-subscribe',
              payload: { keyHash },
            });
          }
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', async (data) => {
          try {
            const parsed = JSON.parse(data.toString());
            // Handle compressed signaling messages (z = zipped)
            if (parsed.z) {
              const message: SignalingMessage = JSON.parse(await this.decompress(parsed.z));
              this.handleMessage(message);
              return;
            }
            // Handle signaling messages (only specific types from signaling server)
            const signalingTypes = [
              'peer-connected',
              'peer-offline',
              'data',
              'bye',
              'error',
              'pwa-bye',
              'sync-updated',
              'tombstone-event',
            ];
            if (parsed.type && signalingTypes.includes(parsed.type)) {
              this.handleMessage(parsed as SignalingMessage);
              return;
            }
            // Check for routed message envelope (from key-based PWA connections)
            if (parsed.from && parsed.to && 'payload' in parsed) {
              this.emit('data', parsed.payload, parsed.from);
              return;
            }
            // Other JSON messages (like key-exchange) are data messages
            this.emit('data', data.toString(), null);
          } catch {
            // Not JSON, treat as raw data message
            this.emit('data', data.toString(), null);
          }
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          this.clearHeartbeat();
          this.emit('disconnected');
          this.attemptReconnect();
        });

        this.ws.on('error', (error) => {
          this.emit('error', error);
          if (!this.isConnected) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(message: SignalingMessage): void {
    switch (message.type) {
      case 'peer-connected':
        this.emit('peer-connected');
        break;
      case 'peer-offline':
        this.emit('peer-disconnected');
        break;
      case 'data':
        if (typeof message.payload === 'string') {
          this.emit('data', message.payload, null);
        }
        break;
      case 'bye':
        this.emit('peer-disconnected');
        break;
      case 'pwa-bye': {
        const payload = message.payload as { pwaAddress?: string } | undefined;
        if (payload?.pwaAddress) {
          this.emit('pwa-bye', payload.pwaAddress);
        }
        break;
      }
      case 'error': {
        // Surface relay-side errors (most importantly RATE_LIMITED) so they
        // don't disappear silently. Without this, hitting the relay's per-
        // peer message rate limit during an interactive terminal session
        // manifests as "PWA stops receiving updates" with zero indication
        // that the relay is the one dropping them.
        const payload = message.payload as { code?: string; message?: string } | undefined;
        const code = payload?.code ?? 'UNKNOWN';
        const text = payload?.message ?? '';
        console.warn(`[relay] error from signaling server: ${code} ${text}`);
        break;
      }
      case 'tombstone-event': {
        const payload = message.payload as
          | { keyHash?: string; data?: string }
          | undefined;
        if (
          payload &&
          typeof payload.keyHash === 'string' &&
          typeof payload.data === 'string'
        ) {
          this.emit('tombstone-event', payload.keyHash, payload.data);
        }
        break;
      }
    }
  }

  sendBye(): void {
    this.send({ type: 'bye' });
  }

  sendData(data: string, targetAddress: string | null): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (targetAddress) {
        // Wrap in routing envelope for key-based PWA connections
        const envelope = JSON.stringify({
          from: `agent:${this.agentId}`,
          to: targetAddress,
          payload: data,
        });
        this.ws.send(envelope);
      } else {
        // Legacy: send raw data to peer through signaling server
        this.ws.send(data);
      }
    }
  }

  // Gzip compression helpers
  private async compress(data: string): Promise<string> {
    const buffer = await gzipAsync(Buffer.from(data));
    return buffer.toString('base64');
  }

  private async decompress(base64: string): Promise<string> {
    const buffer = Buffer.from(base64, 'base64');
    const decompressed = await gunzipAsync(buffer);
    return decompressed.toString('utf-8');
  }

  private send(message: SignalingMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send compressed
      this.compress(JSON.stringify(message)).then((compressed) => {
        this.ws?.send(JSON.stringify({ z: compressed }));
      }).catch((error) => {
        console.error('Failed to send signaling message:', error);
      });
    }
  }

  /**
   * Send a plain-JSON signaling message without gzip wrapping. The relay's
   * `onMessage` hook parses the envelope directly, so control messages like
   * `tombstone-subscribe` must skip the `{z:...}` compression envelope.
   */
  private sendRaw(message: { type: string; payload?: unknown }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Ask the relay to push `tombstone-event` for `keyHash`. Idempotent: the
   * relay de-dupes per socket, and we track subscriptions locally so reconnects
   * replay them automatically.
   */
  subscribeTombstone(keyHash: string): void {
    this.tombstoneSubscriptions.add(keyHash);
    this.sendRaw({
      type: 'tombstone-subscribe',
      payload: { keyHash },
    });
  }

  /**
   * Stop receiving push for `keyHash`. Best-effort — if the socket is down the
   * relay will drop the subscription on disconnect anyway.
   */
  unsubscribeTombstone(keyHash: string): void {
    this.tombstoneSubscriptions.delete(keyHash);
    this.sendRaw({
      type: 'tombstone-unsubscribe',
      payload: { keyHash },
    });
  }

  private attemptReconnect(): void {
    if (this.intentionalDisconnect) return;
    this.reconnectAttempts++;
    const jitter = Math.floor(Math.random() * 5000);
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1) + jitter,
      this.maxReconnectDelay,
    );

    console.log(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((error) => {
        console.error('Reconnect failed:', error);
      });
    }, delay);
  }

  private intentionalDisconnect = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.ws?.on('pong', () => {
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
    });

    this.heartbeatInterval = setInterval(() => {
      this.ws?.ping();
      this.pongTimeout = setTimeout(() => {
        this.ws?.terminate();
      }, 15000);
    }, 60000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true; // Prevent reconnection
    this.clearHeartbeat();
    if (this.ws) {
      this.sendBye();
      this.ws.close();
      this.ws = null;
    }
  }

  getAgentId(): string {
    return this.agentId;
  }

  getConnectionUrl(): string {
    return this.url;
  }
}
