// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { IncomingMessage, ServerResponse } from 'http';
import {
  hashCiphertext,
  isSignedSyncEnvelope,
  type SignedSyncEnvelope,
  type SyncEnvelopeAction,
} from '@sumicom/quicksave-shared';
import type { SyncStore } from './syncStore.js';
import { TtlNonceCache, verifySignedRequest } from './sigVerify.js';

export type SyncSubpath = 'blob' | 'tombstone' | 'lock';

export interface SyncRouter {
  /** Handle a /sync/* HTTP request. Caller has already parsed the URL. */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    keyHash: string,
    subpath: SyncSubpath,
  ): void;
  /** Exposed for `/stats`. */
  readonly nonceCache: TtlNonceCache;
}

export interface CreateSyncRouterOptions {
  store: SyncStore;
  /** Shared with the rest of the relay so nonces from one action are not
   * reusable on another. Defaults to a fresh cache if omitted. */
  nonceCache?: TtlNonceCache;
  /**
   * Fired after a tombstone is successfully persisted. Used by the WS layer to
   * fan out `tombstone-event` pushes to subscribed agents so they can rotate
   * identity without waiting for the periodic catch-up GET.
   */
  onTombstone?: (keyHash: string, ciphertext: string) => void;
  /**
   * Fired after any successful sync write. Used by metrics + ActiveKeys to
   * attribute traffic to the signing identity (`sigPubkey`).
   */
  onWriteSuccess?: (info: {
    kind: 'blob' | 'tombstone';
    bytes: number;
    sigPubkey: string;
  }) => void;
}

/**
 * Parse `/sync/{hash}[/tombstone|/lock]`. Returns `null` if the URL doesn't
 * match the shape, so the caller can fall through to other routes.
 */
export function parseSyncUrl(
  url: string | undefined,
): { keyHash: string; subpath: SyncSubpath } | null {
  if (!url) return null;
  const m = url.match(/^\/sync\/([a-zA-Z0-9_-]{8,64})(\/tombstone|\/lock)?$/);
  if (!m) return null;
  const suffix = m[2];
  const subpath: SyncSubpath =
    suffix === '/tombstone' ? 'tombstone' : suffix === '/lock' ? 'lock' : 'blob';
  return { keyHash: m[1], subpath };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parseEnvelope(raw: string): SignedSyncEnvelope | null {
  try {
    const parsed = JSON.parse(raw);
    return isSignedSyncEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createSyncRouter(opts: CreateSyncRouterOptions): SyncRouter {
  const { store, onTombstone, onWriteSuccess } = opts;
  const nonceCache = opts.nonceCache ?? new TtlNonceCache();

  function handle(
    req: IncomingMessage,
    res: ServerResponse,
    keyHash: string,
    subpath: SyncSubpath,
  ): void {
    // GET is unauthenticated and only valid on the bare mailbox route.
    if (req.method === 'GET') {
      if (subpath !== 'blob') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }
      const entry = store.get(keyHash);
      if (!entry) {
        writeJson(res, 404, { error: 'Not found' });
        return;
      }
      if (entry.type === 'tombstone') {
        writeJson(res, 410, { type: 'tombstone', data: entry.data });
        return;
      }
      writeJson(res, 200, { type: 'blob', data: entry.data });
      return;
    }

    const expectWrite =
      (req.method === 'PUT' && (subpath === 'blob' || subpath === 'tombstone')) ||
      (req.method === 'DELETE' && subpath === 'lock');

    if (!expectWrite) {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    readBody(req)
      .then((raw) => {
        const envelope = parseEnvelope(raw);
        if (!envelope) {
          writeJson(res, 400, { error: 'invalid envelope' });
          return;
        }

        const expectedAction: SyncEnvelopeAction =
          subpath === 'blob'
            ? 'sync-write'
            : subpath === 'tombstone'
              ? 'sync-tombstone'
              : 'sync-lock-release';
        if (envelope.action !== expectedAction) {
          writeJson(res, 400, { error: 'action mismatch' });
          return;
        }

        if (subpath === 'lock') {
          if (envelope.ciphertext !== undefined && envelope.ciphertext !== '') {
            writeJson(res, 400, { error: 'lock-release must not carry ciphertext' });
            return;
          }
        } else {
          if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length === 0) {
            writeJson(res, 400, { error: 'ciphertext required' });
            return;
          }
        }

        const ciphertextHash =
          subpath === 'lock' ? '' : hashCiphertext(envelope.ciphertext!);

        const verified = verifySignedRequest({
          action: envelope.action,
          signPubKey: envelope.sigPubkey,
          ts: envelope.ts,
          nonce: envelope.nonce,
          sig: envelope.sig,
          extra: [keyHash, ciphertextHash],
          cache: nonceCache,
        });
        if (!verified.ok) {
          writeJson(res, 401, {
            error: 'signature verification failed',
            reason: verified.reason,
            serverTime: verified.serverTime,
          });
          return;
        }

        if (subpath === 'lock') {
          const released = store.releaseLock(keyHash, envelope.sigPubkey);
          writeJson(res, 200, { released });
          return;
        }

        const lockResult = store.tryAcquireLock(keyHash, envelope.sigPubkey);
        if (!lockResult.ok) {
          const remaining = Math.max(0, lockResult.heldBy.expiresAt - Date.now());
          res.setHeader('Retry-After', Math.ceil(remaining / 1000).toString());
          writeJson(res, 409, {
            error: 'mailbox locked',
            heldBy: lockResult.heldBy.sigPubkey,
            retryAfterMs: remaining,
          });
          return;
        }

        try {
          if (subpath === 'tombstone') {
            try {
              store.putTombstone(keyHash, envelope.ciphertext!);
              onTombstone?.(keyHash, envelope.ciphertext!);
              onWriteSuccess?.({
                kind: 'tombstone',
                bytes: envelope.ciphertext!.length,
                sigPubkey: envelope.sigPubkey,
              });
              writeJson(res, 200, { ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              if (message.includes('already exists')) {
                writeJson(res, 409, { error: 'Tombstone already exists' });
              } else {
                writeJson(res, 500, { error: message });
              }
            }
          } else {
            try {
              store.put(keyHash, envelope.ciphertext!);
              onWriteSuccess?.({
                kind: 'blob',
                bytes: envelope.ciphertext!.length,
                sigPubkey: envelope.sigPubkey,
              });
              writeJson(res, 200, { ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              if (message.includes('tombstone')) {
                const entry = store.get(keyHash);
                writeJson(res, 410, {
                  error: 'Tombstone exists',
                  type: 'tombstone',
                  data: entry?.data,
                });
              } else if (message.includes('exceeds max size')) {
                writeJson(res, 413, { error: message });
              } else {
                writeJson(res, 500, { error: message });
              }
            }
          }
        } finally {
          store.releaseLock(keyHash, envelope.sigPubkey);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Unknown error';
        writeJson(res, 500, { error: message });
      });
  }

  return { handle, nonceCache };
}
