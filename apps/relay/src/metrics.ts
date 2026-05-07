// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Prometheus instrumentation for the relay.
 *
 * The metrics are served on a SEPARATE admin HTTP server bound by default to
 * the loopback interface — never expose them on the same public port as the
 * WebSocket / sync routes. Scrape via Tailscale / VPC / SSH tunnel.
 *
 * Cardinality discipline: NEVER add labels for per-user identifiers
 * (`keyHash`, `addr`, `signPubKey`, public keys, IPs). All labels here are
 * drawn from a small fixed enum.
 */

export const register = new Registry();

collectDefaultMetrics({ register, prefix: 'relay_' });

/* ---------- WebSocket connection metrics ---------- */

export const wsConnectionsTotal = new Counter({
  name: 'relay_ws_connections_total',
  help: 'WebSocket peers that successfully connected, by channel.',
  labelNames: ['channel'] as const,
  registers: [register],
});

export const wsDisconnectionsTotal = new Counter({
  name: 'relay_ws_disconnections_total',
  help: 'WebSocket peers that disconnected, by channel.',
  labelNames: ['channel'] as const,
  registers: [register],
});

export const wsConnectionDurationSeconds = new Histogram({
  name: 'relay_ws_connection_duration_seconds',
  help: 'How long WebSocket peers stayed connected, observed at disconnect.',
  labelNames: ['channel'] as const,
  buckets: [1, 10, 60, 300, 900, 3600, 21600, 86400],
  registers: [register],
});

/* ---------- HTTP route metrics ---------- */

export type RouteLabel =
  | 'health'
  | 'stats'
  | 'metrics'
  | 'sync_blob'
  | 'sync_tombstone'
  | 'sync_lock'
  | 'pair'
  | 'pair_subscribe'
  | 'push_register'
  | 'push_unregister'
  | 'push_notify'
  | 'other';

export const httpRequestsTotal = new Counter({
  name: 'relay_http_requests_total',
  help: 'HTTP requests handled, labelled by normalised route, method, and status class.',
  labelNames: ['route', 'method', 'status_class'] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'relay_http_request_duration_seconds',
  help: 'HTTP request duration, by normalised route and status class.',
  labelNames: ['route', 'status_class'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const rateLimitHitsTotal = new Counter({
  name: 'relay_rate_limit_hits_total',
  help: 'HTTP requests rejected by the per-IP rate limiter, by route.',
  labelNames: ['route'] as const,
  registers: [register],
});

/* ---------- Push notification metrics ---------- */

export const pushVerifyFailuresTotal = new Counter({
  name: 'relay_push_verify_failures_total',
  help: 'Signature verification failures on /push/* routes, by reason.',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const pushNotificationsTotal = new Counter({
  name: 'relay_push_notifications_total',
  help: 'Web Push send results from /push/{key}/notify.',
  labelNames: ['outcome'] as const, // 'sent' | 'pruned' | 'failed'
  registers: [register],
});

/* ---------- Pair-store error counters ---------- */

export const pairPostErrorsTotal = new Counter({
  name: 'relay_pair_post_errors_total',
  help: 'Pair-mailbox POSTs rejected by the store.',
  labelNames: ['reason'] as const, // 'full' | 'too_large'
  registers: [register],
});

export const pairMailboxOutcomesTotal = new Counter({
  name: 'relay_pair_mailbox_outcomes_total',
  help: 'Pair mailbox lifecycle outcomes, observed at deletion or TTL expiry.',
  labelNames: ['outcome'] as const, // 'deleted' | 'expired_with_slots' | 'expired_empty'
  registers: [register],
});

/* ---------- Per-message size + per-channel breakdown ---------- */

export const messageSizeBytes = new Histogram({
  name: 'relay_message_size_bytes',
  help: 'Size of frames forwarded between peers, by source channel.',
  labelNames: ['channel'] as const,
  buckets: [64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304],
  registers: [register],
});

export const messagesByChannelTotal = new Counter({
  name: 'relay_messages_by_channel_total',
  help: 'Frames forwarded between peers, broken down by source channel. Sum across labels matches relay_messages_relayed_total.',
  labelNames: ['channel'] as const,
  registers: [register],
});

/* ---------- Per-connection (= per-WS-session) summaries ---------- */

export const connectionMessagesTotal = new Histogram({
  name: 'relay_connection_messages',
  help: 'Total frames a peer sent during one WS session, observed at disconnect.',
  labelNames: ['channel'] as const,
  buckets: [1, 10, 100, 1000, 10_000, 100_000, 1_000_000],
  registers: [register],
});

export const connectionBytesTotal = new Histogram({
  name: 'relay_connection_bytes',
  help: 'Total bytes a peer sent+received during one WS session, observed at disconnect.',
  labelNames: ['channel'] as const,
  buckets: [1024, 10_240, 102_400, 1_048_576, 10_485_760, 104_857_600, 1_073_741_824],
  registers: [register],
});

/* ---------- Reconnect detection ---------- */

export const reconnectsTotal = new Counter({
  name: 'relay_reconnects_total',
  help: 'WS connects whose peer ID was seen disconnecting within the last 60s. Signals flaky networks or unstable agents.',
  labelNames: ['channel'] as const,
  registers: [register],
});

/* ---------- Sync write breakdown ---------- */

export const syncWritesTotal = new Counter({
  name: 'relay_sync_writes_total',
  help: 'Successful writes to the sync store, by kind.',
  labelNames: ['kind'] as const, // 'blob' | 'tombstone'
  registers: [register],
});

/* ---------- Stats-derived gauges ---------- */
/*
 * These wrap the existing in-memory `.stats` getters. We use `collect()` so
 * the values are pulled on every scrape — zero overhead between scrapes and
 * always in sync with the underlying store.
 */

export interface StatsSources {
  registryStats: () => {
    totalConnections: number;
    messagesRelayed: number;
    uptime: number;
    channels: Record<string, { active: number; peak: number }>;
  };
  syncStoreStats: () => { blobs: number; tombstones: number; locks: number; bytes: number };
  pairStoreStats: () => { mailboxes: number; slots: number; subscribers: number };
  tombstoneSubsStats: () => { keys: number; subscribers: number };
  pushStoreStats?: () => { agents: number; subscriptions: number };
}

/**
 * Distribution of "devices per agent" — the size of `agentWatchers[agentId]`
 * sets. Observed at the same rollup tick as ActiveKeys, one sample per
 * agent that has at least one watcher.
 */
export const devicesPerAgent = new Histogram({
  name: 'relay_devices_per_agent',
  help: 'Distinct PWA peers actively watching one agent. One sample per agent per rollup tick.',
  buckets: [1, 2, 3, 5, 10, 20, 50],
  registers: [register],
});

export function wireGauges(sources: StatsSources): void {
  new Gauge({
    name: 'relay_uptime_seconds',
    help: 'Seconds since the relay started.',
    registers: [register],
    collect() {
      this.set(sources.registryStats().uptime);
    },
  });

  new Gauge({
    name: 'relay_ws_connections_active',
    help: 'Currently connected WebSocket peers, by channel.',
    labelNames: ['channel'] as const,
    registers: [register],
    collect() {
      const { channels } = sources.registryStats();
      for (const [name, info] of Object.entries(channels)) {
        this.set({ channel: name }, info.active);
      }
    },
  });

  // messagesRelayed in ws-relay is monotonically increasing. We reflect it as
  // a Counter via per-scrape diff, so PromQL `rate()` behaves correctly.
  let lastMessagesRelayed = 0;
  const messagesRelayedTotal = new Counter({
    name: 'relay_messages_relayed_total',
    help: 'Frames forwarded between peers (cumulative).',
    registers: [register],
    collect() {
      const current = sources.registryStats().messagesRelayed;
      const diff = current - lastMessagesRelayed;
      if (diff > 0) {
        messagesRelayedTotal.inc(diff);
        lastMessagesRelayed = current;
      } else if (diff < 0) {
        // Process restart inside same scrape window — reset baseline.
        lastMessagesRelayed = current;
      }
    },
  });

  new Gauge({
    name: 'relay_sync_blobs',
    help: 'Live (non-tombstone) entries in the sync store.',
    registers: [register],
    collect() {
      this.set(sources.syncStoreStats().blobs);
    },
  });

  new Gauge({
    name: 'relay_sync_tombstones',
    help: 'Tombstone entries in the sync store.',
    registers: [register],
    collect() {
      this.set(sources.syncStoreStats().tombstones);
    },
  });

  new Gauge({
    name: 'relay_sync_store_bytes',
    help: 'Total bytes of ciphertext stored in the sync store (live entries + tombstones).',
    registers: [register],
    collect() {
      this.set(sources.syncStoreStats().bytes);
    },
  });

  new Gauge({
    name: 'relay_sync_locks_active',
    help: 'Active per-mailbox write locks.',
    registers: [register],
    collect() {
      this.set(sources.syncStoreStats().locks);
    },
  });

  new Gauge({
    name: 'relay_pair_mailboxes',
    help: 'Active pairing mailboxes.',
    registers: [register],
    collect() {
      this.set(sources.pairStoreStats().mailboxes);
    },
  });

  new Gauge({
    name: 'relay_pair_slots',
    help: 'Total slots across all pairing mailboxes.',
    registers: [register],
    collect() {
      this.set(sources.pairStoreStats().slots);
    },
  });

  new Gauge({
    name: 'relay_pair_subscribers',
    help: 'Active SSE subscribers across all pairing mailboxes.',
    registers: [register],
    collect() {
      this.set(sources.pairStoreStats().subscribers);
    },
  });

  new Gauge({
    name: 'relay_tombstone_subscribed_keys',
    help: 'Distinct keyHashes with at least one tombstone subscriber.',
    registers: [register],
    collect() {
      this.set(sources.tombstoneSubsStats().keys);
    },
  });

  new Gauge({
    name: 'relay_tombstone_subscribers',
    help: 'Total tombstone subscribers across all keys.',
    registers: [register],
    collect() {
      this.set(sources.tombstoneSubsStats().subscribers);
    },
  });

  if (sources.pushStoreStats) {
    new Gauge({
      name: 'relay_push_agents',
      help: 'Distinct agent keys with at least one Web Push subscription.',
      registers: [register],
      collect() {
        this.set(sources.pushStoreStats!().agents);
      },
    });

    new Gauge({
      name: 'relay_push_subscriptions',
      help: 'Total Web Push subscriptions across all agents.',
      registers: [register],
      collect() {
        this.set(sources.pushStoreStats!().subscriptions);
      },
    });
  }
}

/* ---------- HTTP labelling helpers ---------- */

/**
 * Map an incoming URL onto a fixed-cardinality route label. Unknown URLs
 * fall back to 'other' to keep series count bounded.
 */
export function classifyRoute(url: string | undefined): RouteLabel {
  if (!url) return 'other';
  // Strip query string; we only label the path.
  const path = url.split('?', 1)[0];

  if (path === '/health') return 'health';
  if (path === '/stats') return 'stats';
  if (path === '/metrics') return 'metrics';

  const sync = path.match(/^\/sync\/[^/]+(\/(tombstone|lock))?$/);
  if (sync) {
    if (sync[2] === 'tombstone') return 'sync_tombstone';
    if (sync[2] === 'lock') return 'sync_lock';
    return 'sync_blob';
  }

  const pair = path.match(/^\/pair-requests\/[^/]+(\/subscribe)?$/);
  if (pair) return pair[1] ? 'pair_subscribe' : 'pair';

  const push = path.match(/^\/push\/[^/]+\/(register|unregister|notify)$/);
  if (push) {
    if (push[1] === 'register') return 'push_register';
    if (push[1] === 'unregister') return 'push_unregister';
    return 'push_notify';
  }

  return 'other';
}

export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH']);
export function normaliseMethod(method: string | undefined): string {
  if (!method) return 'OTHER';
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : 'OTHER';
}

/**
 * Wrap an HTTP request lifecycle so we record `relay_http_requests_total` and
 * `relay_http_request_duration_seconds` exactly once on response completion.
 *
 * Call BEFORE handing the request off to your routing logic.
 */
export function instrumentHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routeOverride?: RouteLabel,
): void {
  const start = process.hrtime.bigint();
  const method = normaliseMethod(req.method);

  const finish = () => {
    res.removeListener('finish', finish);
    res.removeListener('close', finish);
    const route = routeOverride ?? classifyRoute(req.url);
    const sc = statusClass(res.statusCode);
    const elapsedSec =
      Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc({ route, method, status_class: sc });
    httpRequestDurationSeconds.observe({ route, status_class: sc }, elapsedSec);
  };
  res.once('finish', finish);
  res.once('close', finish);
}

/* ---------- Admin HTTP server ---------- */

export interface MetricsServerOptions {
  /** Default 9090. Set 0 to disable. */
  port?: number;
  /** Default '127.0.0.1' — keep on loopback, scrape via Tailscale / VPC. */
  host?: string;
  registry?: Registry;
}

export interface MetricsServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

/**
 * Start a minimal HTTP server that serves Prometheus exposition on `/metrics`.
 * Returns the live server so callers can close it on shutdown. Resolves once
 * the server is actually listening.
 */
export function startMetricsServer(
  opts: MetricsServerOptions = {},
): Promise<MetricsServer> {
  const port = opts.port ?? 9090;
  const host = opts.host ?? '127.0.0.1';
  const reg = opts.registry ?? register;

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }
    const path = req.url.split('?', 1)[0];
    if (path === '/metrics' && (req.method === 'GET' || req.method === 'HEAD')) {
      reg
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': reg.contentType });
          if (req.method === 'HEAD') res.end();
          else res.end(body);
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`metrics error: ${(err as Error).message}`);
        });
      return;
    }
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const actualPort =
        typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actualPort,
        host,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
