// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { createRelay, sendMessage } from '@sumicom/ws-relay';
import type { RelayInstance, Peer, PeerRegistryInterface } from '@sumicom/ws-relay';
import { WebSocket } from 'ws';
import type { IncomingMessage, ServerResponse } from 'http';
import { SyncStore } from './syncStore.js';
import { PushStore } from './pushStore.js';
import { PushService } from './pushService.js';
import { createPushRoutes, type PushRoutes } from './pushRoutes.js';
import {
  PairStore,
  PairStoreFullError,
  PairStoreTooLargeError,
} from './pairStore.js';
import { createSyncRouter, parseSyncUrl } from './syncRoutes.js';
import { TombstoneSubs } from './tombstoneSubs.js';
import {
  connectionBytesTotal,
  connectionMessagesTotal,
  devicesPerAgent,
  instrumentHttpRequest,
  messageSizeBytes,
  messagesByChannelTotal,
  pairMailboxOutcomesTotal,
  pairPostErrorsTotal,
  pushNotificationsTotal,
  pushVerifyFailuresTotal,
  rateLimitHitsTotal,
  reconnectsTotal,
  register,
  startMetricsServer,
  syncWritesTotal,
  wireGauges,
  wsConnectionDurationSeconds,
  wsConnectionsTotal,
  wsDisconnectionsTotal,
  type RouteLabel,
} from './metrics.js';
import { ActiveKeys } from './activeKeys.js';

// Injected by esbuild at build time from package.json
declare const VERSION: string;

const PORT = parseInt(process.env.PORT || '8080', 10);
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9090', 10);
const METRICS_HOST = process.env.METRICS_HOST || '127.0.0.1';

const ROLLUP_INTERVAL_MS = 60 * 60_000; // 1h
const RECONNECT_WINDOW_MS = 60_000;

const activeKeys = new ActiveKeys({ registry: register, rollupIntervalMs: ROLLUP_INTERVAL_MS });
activeKeys.start();

// Per-WS-session message counters, drained at disconnect into a histogram.
const connectionMessageCounts = new Map<string, number>();

// Address → most recent disconnect timestamp. A connect within
// RECONNECT_WINDOW_MS of a prior disconnect is counted as a reconnect.
const recentDisconnects = new Map<string, number>();

function trackFrame(from: Peer, raw: Buffer): void {
  const size = raw.length;
  connectionMessageCounts.set(
    from.address,
    (connectionMessageCounts.get(from.address) ?? 0) + 1,
  );
  activeKeys.recordTraffic(from.address, size);
  messageSizeBytes.observe({ channel: from.channel }, size);
  messagesByChannelTotal.inc({ channel: from.channel });
}

// Periodic prune so recentDisconnects doesn't accumulate stale addresses
// from peers that never reconnect.
setInterval(() => {
  const cutoff = Date.now() - RECONNECT_WINDOW_MS;
  for (const [addr, ts] of recentDisconnects) {
    if (ts < cutoff) recentDisconnects.delete(addr);
  }
}, RECONNECT_WINDOW_MS).unref?.();

const syncStore = new SyncStore();
const pairStore = new PairStore({
  onMailboxOutcome: (outcome) => {
    pairMailboxOutcomesTotal.inc({ outcome });
  },
});
pairStore.startGc();
const tombstoneSubs = new TombstoneSubs();
const syncRouter = createSyncRouter({
  store: syncStore,
  onTombstone: (keyHash, ciphertext) => tombstoneSubs.publish(keyHash, ciphertext),
  onWriteSuccess: ({ kind, bytes, sigPubkey }) => {
    syncWritesTotal.inc({ kind });
    activeKeys.recordTraffic(`sigPubkey:${sigPubkey}`, bytes);
  },
});

// Simple per-IP sliding-window rate limiter for pair + sync routes.
// 60 requests per 60s per IP is plenty for legitimate pairing flow but blunts
// mailbox-flooding abuse. Keys get evicted lazily.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const rateLimitHits = new Map<string, number[]>();
function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  let hits = rateLimitHits.get(ip);
  if (!hits) {
    hits = [];
    rateLimitHits.set(ip, hits);
  }
  // Drop entries outside the window.
  while (hits.length && hits[0] < now - RATE_LIMIT_WINDOW_MS) hits.shift();
  if (hits.length >= RATE_LIMIT_MAX) return false;
  hits.push(now);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, hits] of rateLimitHits) {
    while (hits.length && hits[0] < cutoff) hits.shift();
    if (hits.length === 0) rateLimitHits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref?.();

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function handlePairRequest(
  req: IncomingMessage,
  res: ServerResponse,
  addr: string,
  subscribe: boolean,
): void {
  if (!rateLimitOk(clientIp(req))) {
    rateLimitHitsTotal.inc({ route: subscribe ? 'pair_subscribe' : 'pair' });
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limit exceeded' }));
    return;
  }

  if (subscribe) {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    // Server-Sent Events: stream each newly-appended slot as a single event.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush any existing slots so late subscribers still see the state.
    for (const slot of pairStore.getSlots(addr)) {
      res.write(`event: slot\ndata: ${JSON.stringify(slot)}\n\n`);
    }
    const unsub = pairStore.subscribe(addr, (slot) => {
      res.write(`event: slot\ndata: ${JSON.stringify(slot)}\n\n`);
    });
    // Periodic comment keeps proxies from idling the stream closed.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const teardown = () => {
      clearInterval(ping);
      unsub();
      try {
        res.end();
      } catch {
        // ignore
      }
    };
    req.on('close', teardown);
    req.on('error', teardown);
    return;
  }

  if (req.method === 'GET') {
    const slots = pairStore.getSlots(addr);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ slots }));
    return;
  }

  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        let parsed: { data?: unknown; kind?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON body' }));
          return;
        }
        if (typeof parsed.data !== 'string' || parsed.data.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'data field required (string)' }));
          return;
        }
        const kind =
          typeof parsed.kind === 'string' && parsed.kind.length > 0
            ? parsed.kind
            : undefined;
        const { id, mailboxExpiresAt } = pairStore.postSlot(addr, {
          data: parsed.data,
          kind,
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, mailboxExpiresAt }));
      } catch (err) {
        if (err instanceof PairStoreFullError) {
          pairPostErrorsTotal.inc({ reason: 'full' });
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mailbox full' }));
          return;
        }
        if (err instanceof PairStoreTooLargeError) {
          pairPostErrorsTotal.inc({ reason: 'too_large' });
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        const message = err instanceof Error ? err.message : 'unknown error';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
    return;
  }

  if (req.method === 'DELETE') {
    pairStore.deleteMailbox(addr);
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

// Push notifications are optional: only initialised when VAPID keys are set.
let pushRoutes: PushRoutes | null = null;
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
let pushStoreRef: PushStore | null = null;
if (vapidPublicKey && vapidPrivateKey) {
  const pushStore = new PushStore({ path: process.env.PUSH_STORE_PATH });
  pushStoreRef = pushStore;
  const pushService = new PushService({
    vapidPublicKey,
    vapidPrivateKey,
    vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@quicksave.dev',
  });
  pushRoutes = createPushRoutes({
    store: pushStore,
    service: pushService,
    metrics: {
      onVerifyFailure(reason) {
        pushVerifyFailuresTotal.inc({ reason });
      },
      onNotifyOutcome(outcome, count) {
        pushNotificationsTotal.inc({ outcome }, count);
      },
    },
  });
  console.log('[push] web-push enabled');
} else {
  console.log('[push] web-push disabled (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set)');
}

// Quicksave-specific agent watcher tracking
// agentId → Set of pwa peer addresses ('pwa:{pwaKey}') watching that agent
const agentWatchers = new Map<string, Set<string>>();

// Hourly: emit one sample per agent that has at least one watcher into the
// devices-per-agent histogram. No labels, so cardinality is bounded.
setInterval(() => {
  for (const watchers of agentWatchers.values()) {
    if (watchers.size > 0) devicesPerAgent.observe(watchers.size);
  }
}, ROLLUP_INTERVAL_MS).unref?.();

// relay is set before any requests arrive (server listens after createRelay returns)
let relay!: RelayInstance;

relay = createRelay({
  port: PORT,
  keyStore: false, // Open access — Quicksave handles its own crypto-based authentication
  blobStore: false, // Sync store is handled via onHttpRequest hook
  // ws-relay default is 100 messages / 60s per peer, which silently drops
  // any message past the limit (only the SENDER gets RATE_LIMITED back).
  // Interactive terminals can easily exceed this: every keystroke triggers
  // an input cmd + result + multiple PTY echo chunks + occasional resize
  // cmds, so a few seconds of fast typing can blow the quota and the
  // resulting drop manifests as "PWA stops receiving terminal output".
  // Bump to 5000/60s — generous enough that bursty terminal + bus traffic
  // never trips it, while still catching genuinely abusive clients.
  rateLimitMaxMessages: 5000,
  rateLimitWindow: 60_000,

  channels: [
    {
      name: 'agent',
      onDuplicate: 'reject',
    },
    {
      // Key-based PWA: connects at /pwa/{encodedPublicKey}
      // Public keys are URL-encoded Base64 so we decode them in parseId
      name: 'pwa',
      onDuplicate: 'replace',
      parseId: (raw) => {
        try {
          const decoded = decodeURIComponent(raw);
          return decoded.length >= 8 ? decoded : null;
        } catch {
          return null;
        }
      },
    },
  ],

  hooks: {
    onPeerConnect(peer: Peer, registry: PeerRegistryInterface) {
      wsConnectionsTotal.inc({ channel: peer.channel });
      // If this address disconnected within the last minute, count as a reconnect.
      const lastDisc = recentDisconnects.get(peer.address);
      if (lastDisc !== undefined) {
        if (Date.now() - lastDisc <= RECONNECT_WINDOW_MS) {
          reconnectsTotal.inc({ channel: peer.channel });
        }
        recentDisconnects.delete(peer.address);
      }
      activeKeys.markActive(peer.address);
      console.log(`[CONNECT] ${peer.address} from ${peer.ip}`);
      if (peer.channel === 'agent') {
        // Notify key-based PWAs watching this agent that it came online
        const watchers = agentWatchers.get(peer.id) ?? new Set<string>();
        for (const pwaAddr of watchers) {
          const pwaPeer = registry.getByAddress(pwaAddr);
          if (pwaPeer && pwaPeer.ws.readyState === WebSocket.OPEN) {
            sendMessage(pwaPeer.ws, { type: 'agent-status', payload: { agentId: peer.id, online: true } });
          }
        }
      }
    },

    onPeerDisconnect(peer: Peer, registry: PeerRegistryInterface) {
      wsDisconnectionsTotal.inc({ channel: peer.channel });
      const durationSec = Math.max(0, (Date.now() - peer.connectedAt) / 1000);
      wsConnectionDurationSeconds.observe({ channel: peer.channel }, durationSec);
      const msgs = connectionMessageCounts.get(peer.address) ?? 0;
      connectionMessageCounts.delete(peer.address);
      connectionMessagesTotal.observe({ channel: peer.channel }, msgs);
      connectionBytesTotal.observe(
        { channel: peer.channel },
        (peer.bytesIn ?? 0) + (peer.bytesOut ?? 0),
      );
      recentDisconnects.set(peer.address, Date.now());
      console.log(`[DISCONNECT] ${peer.address}`);
      tombstoneSubs.unsubscribeAll(peer.ws);
      if (peer.channel === 'agent') {
        // Notify watchers that agent went offline
        const watchers = agentWatchers.get(peer.id) ?? new Set<string>();
        for (const pwaAddr of watchers) {
          const pwaPeer = registry.getByAddress(pwaAddr);
          if (pwaPeer && pwaPeer.ws.readyState === WebSocket.OPEN) {
            sendMessage(pwaPeer.ws, { type: 'agent-status', payload: { agentId: peer.id, online: false } });
          }
        }
      }
      if (peer.channel === 'pwa') {
        // Notify agents this PWA was watching, then clean up
        for (const [agentId, watchers] of agentWatchers) {
          if (watchers.has(peer.address)) {
            watchers.delete(peer.address);
            if (watchers.size === 0) agentWatchers.delete(agentId);
            const agentPeer = registry.get('agent', agentId);
            if (agentPeer && agentPeer.ws.readyState === WebSocket.OPEN) {
              sendMessage(agentPeer.ws, { type: 'pwa-bye', payload: { pwaAddress: peer.address } });
            }
          }
        }
      }
    },

    onMessage(peer: Peer, msg: unknown, raw: Buffer, registry: PeerRegistryInterface) {
      trackFrame(peer, raw);
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as Record<string, unknown>;

      // Handle watch-agent subscription from key-based PWA
      if (m.type === 'watch-agent' && typeof m.agentId === 'string' && peer.channel === 'pwa') {
        const agentId = m.agentId;
        let watchers = agentWatchers.get(agentId);
        if (!watchers) {
          watchers = new Set();
          agentWatchers.set(agentId, watchers);
        }
        watchers.add(peer.address);
        const agentPeer = registry.get('agent', agentId);
        sendMessage(peer.ws, { type: 'agent-status', payload: { agentId, online: !!agentPeer } });
        return true;
      }

      // Agents subscribe to tombstone push so group-reset reaches them
      // without waiting on the periodic catch-up GET. We push any already-
      // present tombstone immediately so late subscribers don't miss it.
      if (m.type === 'tombstone-subscribe' && peer.channel === 'agent') {
        const payload = m.payload as { keyHash?: unknown } | undefined;
        const keyHash = payload?.keyHash;
        if (typeof keyHash !== 'string' || keyHash.length < 8) return true;
        tombstoneSubs.subscribe(keyHash, peer.ws);
        const existing = syncStore.get(keyHash);
        if (existing && existing.type === 'tombstone') {
          sendMessage(peer.ws, {
            type: 'tombstone-event',
            payload: { keyHash, data: existing.data },
          });
        }
        return true;
      }

      if (m.type === 'tombstone-unsubscribe' && peer.channel === 'agent') {
        const payload = m.payload as { keyHash?: unknown } | undefined;
        const keyHash = payload?.keyHash;
        if (typeof keyHash !== 'string' || keyHash.length < 8) return true;
        tombstoneSubs.unsubscribe(keyHash, peer.ws);
        return true;
      }
    },

    onRoutedMessage(from: Peer, _to: Peer, _msg: unknown, raw: Buffer) {
      trackFrame(from, raw);
    },

    onHttpRequest(req: IncomingMessage, res: ServerResponse, next: () => void) {
      instrumentHttpRequest(req, res);
      // Override /health to report app version instead of ws-relay package version
      if (req.url === '/health') {
        const appVersion = typeof VERSION !== 'undefined' ? VERSION : 'dev';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: appVersion }));
        return;
      }

      // Override /stats to include syncStore + push stats
      if (req.url === '/stats') {
        const stats = relay.registry.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ...stats,
          syncStore: syncStore.stats,
          pairStore: pairStore.stats,
          tombstoneSubs: tombstoneSubs.stats,
          push: pushRoutes?.stats() ?? null,
        }));
        return;
      }

      // Handle /sync/* routes
      const sync = parseSyncUrl(req.url);
      if (sync) {
        if (!rateLimitOk(clientIp(req))) {
          const route: RouteLabel =
            sync.subpath === 'tombstone'
              ? 'sync_tombstone'
              : sync.subpath === 'lock'
                ? 'sync_lock'
                : 'sync_blob';
          rateLimitHitsTotal.inc({ route });
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'rate limit exceeded' }));
          return;
        }
        syncRouter.handle(req, res, sync.keyHash, sync.subpath);
        return;
      }

      // Handle /pair-requests/* routes
      const pairMatch = req.url?.match(
        /^\/pair-requests\/([A-Za-z0-9_-]{8,128})(\/subscribe)?(?:\?.*)?$/,
      );
      if (pairMatch) {
        handlePairRequest(req, res, pairMatch[1], !!pairMatch[2]);
        return;
      }

      // Handle /push/:signPubKey/:action routes
      if (pushRoutes && req.url) {
        const pushMatch = req.url.match(/^\/push\/([A-Za-z0-9_-]{10,120})\/(register|unregister|notify)$/);
        if (pushMatch && pushRoutes.handle(req, res, pushMatch[1], pushMatch[2])) {
          return;
        }
      }

      next();
    },
  },
});

console.log(`Quicksave Signaling Server v${typeof VERSION !== 'undefined' ? VERSION : 'dev'}`);
console.log(`  Agent: ws://localhost:${PORT}/agent/{agentId}`);
console.log(`  PWA:   ws://localhost:${PORT}/pwa/{encodedPublicKey}`);
console.log(`  Sync:  http://localhost:${PORT}/sync/{keyHash}`);
console.log(`  Pair:  http://localhost:${PORT}/pair-requests/{addr}`);
if (pushRoutes) console.log(`  Push:  http://localhost:${PORT}/push/{signPubKey}/{register|unregister|notify}`);

wireGauges({
  registryStats: () => relay.registry.getStats(),
  syncStoreStats: () => syncStore.stats,
  pairStoreStats: () => pairStore.stats,
  tombstoneSubsStats: () => tombstoneSubs.stats,
  pushStoreStats: pushStoreRef ? () => pushStoreRef!.stats : undefined,
});

let metricsServerHandle: { close(): Promise<void> } | null = null;
if (METRICS_PORT > 0) {
  startMetricsServer({ port: METRICS_PORT, host: METRICS_HOST })
    .then((server) => {
      metricsServerHandle = server;
      console.log(
        `  Metrics: http://${server.host}:${server.port}/metrics (admin — bind keeps it off the public port)`,
      );
    })
    .catch((err) => {
      console.error('[metrics] failed to start admin server:', err);
    });
} else {
  console.log('  Metrics: disabled (METRICS_PORT=0)');
}

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down...`);
  if (metricsServerHandle) {
    try {
      await metricsServerHandle.close();
    } catch {
      // ignore
    }
  }
  activeKeys.stop();
  pairStore.stopGc();
  relay.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
