// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import http from 'http';
import {
  classifyRoute,
  statusClass,
  normaliseMethod,
  instrumentHttpRequest,
  wireGauges,
  startMetricsServer,
  register,
  type StatsSources,
  type MetricsServer,
} from './metrics.js';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Helpers ────────────────────────────────────────────────────────────────

interface CounterValue {
  value: number;
  labels: Record<string, string>;
}

async function countersFor(name: string): Promise<CounterValue[]> {
  const metric = register.getSingleMetric(name);
  if (!metric) return [];
  const data = (await metric.get()) as { values?: CounterValue[] };
  return data.values ?? [];
}

function makeReqRes(
  url: string,
  method: string,
  statusCode: number,
): { req: IncomingMessage; res: ServerResponse } {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { url: string }).url = url;
  (req as unknown as { method: string }).method = method;

  const res = new EventEmitter() as unknown as ServerResponse;
  (res as unknown as { statusCode: number }).statusCode = statusCode;
  // instrumentHttpRequest uses res.once / res.removeListener — EventEmitter
  // already provides both, so no extra wiring is needed.
  return { req, res };
}

// Minimal Node-based HTTP fetch that keeps us off the undici keep-alive pool.
interface MiniResponse {
  status: number;
  headers: Map<string, string>;
  body: Buffer;
}

function miniFetch(
  url: string,
  init: { method?: string } = {},
): Promise<MiniResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        headers: { Connection: 'close' },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const headers = new Map<string, string>();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers.set(k.toLowerCase(), v);
            else if (Array.isArray(v))
              headers.set(k.toLowerCase(), v.join(', '));
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── classifyRoute ──────────────────────────────────────────────────────────

describe('classifyRoute', () => {
  it.each([
    ['/health', 'health'],
    ['/stats', 'stats'],
    ['/metrics', 'metrics'],
    ['/sync/abcd1234', 'sync_blob'],
    ['/sync/abcd1234/tombstone', 'sync_tombstone'],
    ['/sync/abcd1234/lock', 'sync_lock'],
    ['/pair-requests/something', 'pair'],
    ['/pair-requests/something/subscribe', 'pair_subscribe'],
    ['/push/key/register', 'push_register'],
    ['/push/key/unregister', 'push_unregister'],
    ['/push/key/notify', 'push_notify'],
  ])('classifies %s as %s', (url, expected) => {
    expect(classifyRoute(url)).toBe(expected);
  });

  it('strips query strings before matching', () => {
    expect(classifyRoute('/sync/foo?bar=1')).toBe('sync_blob');
    expect(classifyRoute('/health?token=x')).toBe('health');
  });

  it('returns "other" for unknown URLs', () => {
    expect(classifyRoute('/totally-unknown')).toBe('other');
    expect(classifyRoute('/sync')).toBe('other');
    expect(classifyRoute('/pair-requests')).toBe('other');
  });

  it('returns "other" for undefined input', () => {
    expect(classifyRoute(undefined)).toBe('other');
  });
});

// ── statusClass ────────────────────────────────────────────────────────────

describe('statusClass', () => {
  it('maps 2xx codes', () => {
    expect(statusClass(200)).toBe('2xx');
  });
  it('maps 3xx codes', () => {
    expect(statusClass(301)).toBe('3xx');
  });
  it('maps 4xx codes', () => {
    expect(statusClass(404)).toBe('4xx');
  });
  it('maps 5xx codes', () => {
    expect(statusClass(500)).toBe('5xx');
  });
  it('maps 1xx codes', () => {
    expect(statusClass(100)).toBe('1xx');
  });
});

// ── normaliseMethod ────────────────────────────────────────────────────────

describe('normaliseMethod', () => {
  it('uppercases known methods', () => {
    expect(normaliseMethod('get')).toBe('GET');
    expect(normaliseMethod('Post')).toBe('POST');
    expect(normaliseMethod('PUT')).toBe('PUT');
    expect(normaliseMethod('delete')).toBe('DELETE');
    expect(normaliseMethod('options')).toBe('OPTIONS');
    expect(normaliseMethod('head')).toBe('HEAD');
    expect(normaliseMethod('patch')).toBe('PATCH');
  });

  it('returns "OTHER" for unknown methods', () => {
    expect(normaliseMethod('CONNECT')).toBe('OTHER');
    expect(normaliseMethod('weird')).toBe('OTHER');
  });

  it('returns "OTHER" for undefined', () => {
    expect(normaliseMethod(undefined)).toBe('OTHER');
  });
});

// ── instrumentHttpRequest ──────────────────────────────────────────────────

describe('instrumentHttpRequest', () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it('records on res "finish" with the right route/method/status_class labels', async () => {
    const { req, res } = makeReqRes('/sync/abcd1234', 'POST', 201);
    instrumentHttpRequest(req, res);
    res.emit('finish');

    const counters = await countersFor('relay_http_requests_total');
    expect(counters).toHaveLength(1);
    expect(counters[0].labels).toEqual({
      route: 'sync_blob',
      method: 'POST',
      status_class: '2xx',
    });
    expect(counters[0].value).toBe(1);

    // One observation on the duration histogram.
    const histMetric = register.getSingleMetric(
      'relay_http_request_duration_seconds',
    );
    expect(histMetric).toBeDefined();
    const hist = (await histMetric!.get()) as {
      values: { metricName?: string; labels: Record<string, string>; value: number }[];
    };
    const countSamples = hist.values.filter((v) =>
      v.metricName?.endsWith('_count'),
    );
    // Exactly one bucket "_count" series with value 1 for our labels.
    const matching = countSamples.find(
      (v) =>
        v.labels.route === 'sync_blob' &&
        v.labels.status_class === '2xx',
    );
    expect(matching).toBeDefined();
    expect(matching!.value).toBe(1);
  });

  it('records on res "close" when finish never fires', async () => {
    const { req, res } = makeReqRes('/health', 'GET', 200);
    instrumentHttpRequest(req, res);
    res.emit('close');

    const counters = await countersFor('relay_http_requests_total');
    expect(counters).toHaveLength(1);
    expect(counters[0].labels).toEqual({
      route: 'health',
      method: 'GET',
      status_class: '2xx',
    });
    expect(counters[0].value).toBe(1);
  });

  it('does not double-record when both finish and close fire', async () => {
    const { req, res } = makeReqRes('/metrics', 'GET', 200);
    instrumentHttpRequest(req, res);
    res.emit('finish');
    res.emit('close');

    const counters = await countersFor('relay_http_requests_total');
    expect(counters).toHaveLength(1);
    expect(counters[0].value).toBe(1);
  });

  it('uses normalised method (unknown → OTHER) and status class for unknown codes', async () => {
    const { req, res } = makeReqRes('/totally-unknown', 'CONNECT', 599);
    instrumentHttpRequest(req, res);
    res.emit('finish');

    const counters = await countersFor('relay_http_requests_total');
    expect(counters).toHaveLength(1);
    expect(counters[0].labels).toEqual({
      route: 'other',
      method: 'OTHER',
      status_class: '5xx',
    });
  });
});

// ── wireGauges ─────────────────────────────────────────────────────────────
//
// `wireGauges` registers metrics on the module-level `register` and these
// cannot be re-registered. We therefore call it ONCE for this file, with
// `pushStoreStats` deliberately omitted (so we can assert those gauges are
// absent), and mutate the closed-over source state from each test.

interface MutableSourceState {
  uptime: number;
  totalConnections: number;
  messagesRelayed: number;
  channels: Record<string, { active: number; peak: number }>;
  syncBlobs: number;
  syncTombstones: number;
  syncLocks: number;
  syncBytes: number;
  pairMailboxes: number;
  pairSlots: number;
  pairSubscribers: number;
  tombstoneKeys: number;
  tombstoneSubs: number;
}

const sourceState: MutableSourceState = {
  uptime: 0,
  totalConnections: 0,
  messagesRelayed: 0,
  channels: {},
  syncBlobs: 0,
  syncTombstones: 0,
  syncLocks: 0,
  syncBytes: 0,
  pairMailboxes: 0,
  pairSlots: 0,
  pairSubscribers: 0,
  tombstoneKeys: 0,
  tombstoneSubs: 0,
};

const sources: StatsSources = {
  registryStats: () => ({
    totalConnections: sourceState.totalConnections,
    messagesRelayed: sourceState.messagesRelayed,
    uptime: sourceState.uptime,
    channels: sourceState.channels,
  }),
  syncStoreStats: () => ({
    blobs: sourceState.syncBlobs,
    tombstones: sourceState.syncTombstones,
    locks: sourceState.syncLocks,
    bytes: sourceState.syncBytes,
  }),
  pairStoreStats: () => ({
    mailboxes: sourceState.pairMailboxes,
    slots: sourceState.pairSlots,
    subscribers: sourceState.pairSubscribers,
  }),
  tombstoneSubsStats: () => ({
    keys: sourceState.tombstoneKeys,
    subscribers: sourceState.tombstoneSubs,
  }),
  // pushStoreStats intentionally omitted.
};

let gaugesWired = false;
function ensureGaugesWired(): void {
  if (gaugesWired) return;
  wireGauges(sources);
  gaugesWired = true;
}

function metricLineValue(text: string, name: string): number | undefined {
  // Match e.g. "relay_uptime_seconds 42" — ignore # HELP / # TYPE comments.
  const re = new RegExp(`^${name}(?:\\s|\\{)([^\\n]*)`, 'm');
  const m = text.match(re);
  if (!m) return undefined;
  // m[1] is the rest of the line after the metric name (may include labels).
  // The numeric value is the last whitespace-separated token.
  const fullLine = m[0];
  const tokens = fullLine.trim().split(/\s+/);
  const value = Number(tokens[tokens.length - 1]);
  return Number.isNaN(value) ? undefined : value;
}

describe('wireGauges', () => {
  beforeAll(() => {
    ensureGaugesWired();
  });

  beforeEach(() => {
    // Clear values (counters such as relay_messages_relayed_total). The
    // metrics themselves remain registered with their collect() callbacks.
    register.resetMetrics();
    // Reset source state to deterministic baseline.
    sourceState.uptime = 0;
    sourceState.totalConnections = 0;
    sourceState.messagesRelayed = 0;
    sourceState.channels = {};
    sourceState.syncBlobs = 0;
    sourceState.syncTombstones = 0;
    sourceState.syncLocks = 0;
    sourceState.pairMailboxes = 0;
    sourceState.pairSlots = 0;
    sourceState.pairSubscribers = 0;
    sourceState.tombstoneKeys = 0;
    sourceState.tombstoneSubs = 0;
    sourceState.syncBytes = 0;
  });

  it('emits relay_uptime_seconds and relay_sync_blobs from the source', async () => {
    sourceState.uptime = 42;
    sourceState.syncBlobs = 7;

    const text = await register.metrics();
    expect(text).toContain('relay_uptime_seconds 42');
    expect(text).toContain('relay_sync_blobs 7');
  });

  it('emits relay_sync_store_bytes from the source', async () => {
    sourceState.syncBytes = 12_345;
    const text = await register.metrics();
    expect(metricLineValue(text, 'relay_sync_store_bytes')).toBe(12345);

    sourceState.syncBytes = 67_890;
    const text2 = await register.metrics();
    expect(metricLineValue(text2, 'relay_sync_store_bytes')).toBe(67890);
  });

  it('updates gauge values when source state changes between scrapes', async () => {
    sourceState.uptime = 1;
    sourceState.syncBlobs = 2;
    sourceState.syncTombstones = 3;
    sourceState.syncLocks = 4;
    sourceState.pairMailboxes = 5;
    sourceState.pairSlots = 6;
    sourceState.pairSubscribers = 7;
    sourceState.tombstoneKeys = 8;
    sourceState.tombstoneSubs = 9;

    let text = await register.metrics();
    expect(metricLineValue(text, 'relay_uptime_seconds')).toBe(1);
    expect(metricLineValue(text, 'relay_sync_blobs')).toBe(2);
    expect(metricLineValue(text, 'relay_sync_tombstones')).toBe(3);
    expect(metricLineValue(text, 'relay_sync_locks_active')).toBe(4);
    expect(metricLineValue(text, 'relay_pair_mailboxes')).toBe(5);
    expect(metricLineValue(text, 'relay_pair_slots')).toBe(6);
    expect(metricLineValue(text, 'relay_pair_subscribers')).toBe(7);
    expect(metricLineValue(text, 'relay_tombstone_subscribed_keys')).toBe(8);
    expect(metricLineValue(text, 'relay_tombstone_subscribers')).toBe(9);

    sourceState.uptime = 100;
    sourceState.syncBlobs = 200;

    text = await register.metrics();
    expect(metricLineValue(text, 'relay_uptime_seconds')).toBe(100);
    expect(metricLineValue(text, 'relay_sync_blobs')).toBe(200);
  });

  // The two messages-relayed tests below intentionally run as a single test
  // case. The `lastMessagesRelayed` baseline lives in a closure inside
  // wireGauges (called once for this file) and survives `resetMetrics()` —
  // splitting these scenarios across separate tests would make them depend
  // on the surviving closure value from the previous test, which is fragile.
  it('relay_messages_relayed_total tracks forward diffs and clamps on backwards jumps', async () => {
    // Scrape once at 0 to absorb any baseline carried over from earlier
    // tests in this file. After this scrape, the closure's
    // `lastMessagesRelayed` is in sync with the source (which is 0 because
    // beforeEach reset sourceState).
    await register.metrics();

    // Forward diff: 0 -> 5 -> 7 should produce a counter showing 7.
    sourceState.messagesRelayed = 5;
    let text = await register.metrics();
    expect(metricLineValue(text, 'relay_messages_relayed_total')).toBe(5);

    sourceState.messagesRelayed = 7;
    text = await register.metrics();
    // Should equal the source value, not 5 + 7 = 12.
    expect(metricLineValue(text, 'relay_messages_relayed_total')).toBe(7);

    // Backwards jump: source restart drops to 2. Counter must not decrease;
    // baseline silently resets to 2 and the exposed value sticks at 7.
    sourceState.messagesRelayed = 2;
    text = await register.metrics();
    expect(metricLineValue(text, 'relay_messages_relayed_total')).toBe(7);

    // Forward progress from the new baseline accumulates: 2 -> 5 adds 3.
    sourceState.messagesRelayed = 5;
    text = await register.metrics();
    expect(metricLineValue(text, 'relay_messages_relayed_total')).toBe(10);
  });

  it('emits relay_ws_connections_active labelled per channel from the source', async () => {
    sourceState.channels = {
      agent: { active: 3, peak: 5 },
      pwa: { active: 2, peak: 4 },
    };

    const text = await register.metrics();
    expect(text).toMatch(
      /relay_ws_connections_active\{channel="agent"\}\s+3/,
    );
    expect(text).toMatch(
      /relay_ws_connections_active\{channel="pwa"\}\s+2/,
    );
  });

  it('does not register relay_push_agents / relay_push_subscriptions when pushStoreStats is omitted', async () => {
    const text = await register.metrics();
    expect(text).not.toMatch(/^relay_push_agents\b/m);
    expect(text).not.toMatch(/^relay_push_subscriptions\b/m);
    expect(register.getSingleMetric('relay_push_agents')).toBeUndefined();
    expect(
      register.getSingleMetric('relay_push_subscriptions'),
    ).toBeUndefined();
  });
});

// ── startMetricsServer ─────────────────────────────────────────────────────

describe('startMetricsServer', () => {
  let server: MetricsServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await startMetricsServer({ port: 0, host: '127.0.0.1' });
    expect(server.port).toBeGreaterThan(0);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /metrics returns 200 with text/plain body containing relay_ metrics', async () => {
    const res = await miniFetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct.startsWith('text/plain')).toBe(true);
    const body = res.body.toString('utf-8');
    expect(body).toMatch(/relay_/);
  });

  it('HEAD /metrics returns 200 with empty body', async () => {
    const res = await miniFetch(`${baseUrl}/metrics`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });

  it('GET /health returns 200 with {"status":"ok"}', async () => {
    const res = await miniFetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.toString('utf-8'));
    expect(parsed).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown paths', async () => {
    const res = await miniFetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('close() resolves', async () => {
    // Spin up an extra throw-away server purely to verify close() resolves.
    const extra = await startMetricsServer({ port: 0, host: '127.0.0.1' });
    await expect(extra.close()).resolves.toBeUndefined();
  });
});
