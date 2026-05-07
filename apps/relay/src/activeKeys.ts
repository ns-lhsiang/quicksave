// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { Gauge, Histogram, type Registry } from 'prom-client';

/**
 * Sliding-window active-key tracking + per-key bytes/messages distributions.
 *
 * `recordActivity` is called on every WS frame relay / signed HTTP write that
 * is attributable to a stable identity (PWA pubkey or agentId). The tracker
 * keeps a single in-memory record per key with last-seen + per-window
 * accumulators, and exposes:
 *
 *   - relay_active_keys{window=24h|7d|30d}    Gauges, computed on /metrics scrape
 *   - relay_key_bandwidth_bytes               Histogram, observed at hourly tick
 *   - relay_key_messages                      Histogram, observed at hourly tick
 *
 * The histograms intentionally have NO per-key labels — we observe one sample
 * per active key per rollup, so the distribution is recoverable but cardinality
 * stays bounded. This matches the file-level cardinality discipline noted in
 * `metrics.ts`.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const WINDOW_MS = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
} as const;

interface KeyRecord {
  lastSeen: number;
  bytesInWindow: number;
  messagesInWindow: number;
}

export interface ActiveKeysOptions {
  registry: Registry;
  /** Hourly by default. Set to 0 to disable the timer (tests drive `flush()` manually). */
  rollupIntervalMs?: number;
  now?: () => number;
}

export class ActiveKeys {
  private readonly records = new Map<string, KeyRecord>();
  private readonly now: () => number;
  private readonly rollupIntervalMs: number;
  private rollupTimer: ReturnType<typeof setInterval> | null = null;

  private readonly bandwidthHist: Histogram<string>;
  private readonly messagesHist: Histogram<string>;

  constructor(opts: ActiveKeysOptions) {
    this.now = opts.now ?? Date.now;
    this.rollupIntervalMs = opts.rollupIntervalMs ?? HOUR_MS;

    this.bandwidthHist = new Histogram({
      name: 'relay_key_bandwidth_bytes',
      help: 'Bytes attributed to a single key over one rollup window. One sample per active key per hour.',
      buckets: [1024, 10_240, 102_400, 1_048_576, 10_485_760, 104_857_600, 1_073_741_824],
      registers: [opts.registry],
    });
    this.messagesHist = new Histogram({
      name: 'relay_key_messages',
      help: 'Messages attributed to a single key over one rollup window. One sample per active key per hour.',
      buckets: [1, 10, 100, 1_000, 10_000, 100_000],
      registers: [opts.registry],
    });

    // Capture references the Gauge's `collect` callback can read. prom-client
    // invokes `collect` with `this` bound to the Gauge instance, so we close
    // over the tracker state explicitly.
    const records = this.records;
    const nowFn = this.now;
    new Gauge({
      name: 'relay_active_keys',
      help: 'Distinct keys with at least one recorded activity in the trailing window.',
      labelNames: ['window'] as const,
      registers: [opts.registry],
      collect() {
        const t = nowFn();
        let c24 = 0;
        let c7 = 0;
        let c30 = 0;
        for (const rec of records.values()) {
          const age = t - rec.lastSeen;
          if (age <= WINDOW_MS['24h']) c24++;
          if (age <= WINDOW_MS['7d']) c7++;
          if (age <= WINDOW_MS['30d']) c30++;
        }
        this.set({ window: '24h' }, c24);
        this.set({ window: '7d' }, c7);
        this.set({ window: '30d' }, c30);
      },
    });
  }

  /**
   * Touch the key's last-seen without counting it as traffic. Use this for
   * activity that doesn't carry a payload (e.g. a fresh WS connect) so it
   * still counts toward the active-keys gauges but doesn't skew the per-key
   * bytes/messages distributions.
   */
  markActive(key: string): void {
    if (!key) return;
    const t = this.now();
    let rec = this.records.get(key);
    if (!rec) {
      rec = { lastSeen: t, bytesInWindow: 0, messagesInWindow: 0 };
      this.records.set(key, rec);
      return;
    }
    rec.lastSeen = t;
  }

  /**
   * Attribute one frame of `bytes` to `key`. Increments the per-window message
   * counter by 1 and the per-window byte counter by `bytes`, and touches
   * last-seen.
   */
  recordTraffic(key: string, bytes: number): void {
    if (!key) return;
    const t = this.now();
    let rec = this.records.get(key);
    if (!rec) {
      rec = { lastSeen: t, bytesInWindow: 0, messagesInWindow: 0 };
      this.records.set(key, rec);
    }
    rec.lastSeen = t;
    rec.bytesInWindow += Math.max(0, bytes);
    rec.messagesInWindow += 1;
  }

  /**
   * Roll up the current window: emit one histogram sample per key that had
   * activity, then reset the running counters. Also prunes records that are
   * older than the largest window (30d).
   */
  flush(): void {
    const t = this.now();
    const cutoff = t - WINDOW_MS['30d'];
    for (const [key, rec] of this.records) {
      if (rec.lastSeen < cutoff) {
        this.records.delete(key);
        continue;
      }
      if (rec.messagesInWindow > 0) {
        this.bandwidthHist.observe(rec.bytesInWindow);
        this.messagesHist.observe(rec.messagesInWindow);
        rec.bytesInWindow = 0;
        rec.messagesInWindow = 0;
      }
    }
  }

  start(): void {
    if (this.rollupTimer || this.rollupIntervalMs <= 0) return;
    this.rollupTimer = setInterval(() => this.flush(), this.rollupIntervalMs);
    this.rollupTimer.unref?.();
  }

  stop(): void {
    if (this.rollupTimer) {
      clearInterval(this.rollupTimer);
      this.rollupTimer = null;
    }
  }

  /** For tests / debug only. */
  get size(): number {
    return this.records.size;
  }
}
