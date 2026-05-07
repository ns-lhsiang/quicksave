// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from 'prom-client';
import { ActiveKeys } from './activeKeys.js';

interface BucketSample {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
  exemplar?: unknown;
}

async function gaugeValueFor(
  registry: Registry,
  name: string,
  labelMatch: Record<string, string>,
): Promise<number | undefined> {
  const metric = registry.getSingleMetric(name);
  if (!metric) return undefined;
  const data = (await metric.get()) as { values?: BucketSample[] };
  for (const v of data.values ?? []) {
    let match = true;
    for (const [k, val] of Object.entries(labelMatch)) {
      if (v.labels[k] !== val) {
        match = false;
        break;
      }
    }
    if (match) return v.value;
  }
  return undefined;
}

async function histogramObservationsFor(
  registry: Registry,
  name: string,
): Promise<{ count: number; sum: number; buckets: { le: string; value: number }[] }> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`metric not found: ${name}`);
  const data = (await metric.get()) as { values?: BucketSample[] };
  let count = 0;
  let sum = 0;
  const buckets: { le: string; value: number }[] = [];
  for (const v of data.values ?? []) {
    if (v.metricName === `${name}_count`) count = v.value;
    else if (v.metricName === `${name}_sum`) sum = v.value;
    else if (v.metricName === `${name}_bucket` && v.labels.le)
      buckets.push({ le: v.labels.le, value: v.value });
  }
  return { count, sum, buckets };
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe('ActiveKeys', () => {
  let registry: Registry;
  let now: number;
  let tracker: ActiveKeys;

  beforeEach(() => {
    registry = new Registry();
    now = 1_700_000_000_000; // arbitrary fixed start
    tracker = new ActiveKeys({
      registry,
      rollupIntervalMs: 0, // disable internal timer; tests drive flush() directly
      now: () => now,
    });
  });

  describe('markActive', () => {
    it('creates a record with zero counters', () => {
      tracker.markActive('pwa:abc');
      expect(tracker.size).toBe(1);
    });

    it('updates lastSeen on a known key without bumping counters', async () => {
      tracker.markActive('pwa:abc');
      now += 5_000;
      tracker.markActive('pwa:abc');
      tracker.flush();
      // No traffic recorded → no histogram samples.
      const msgs = await histogramObservationsFor(registry, 'relay_key_messages');
      expect(msgs.count).toBe(0);
    });

    it('treats empty key as a no-op', () => {
      tracker.markActive('');
      expect(tracker.size).toBe(0);
    });
  });

  describe('recordTraffic', () => {
    it('creates a record and bumps counters', async () => {
      tracker.recordTraffic('pwa:abc', 1024);
      tracker.recordTraffic('pwa:abc', 512);
      tracker.flush();
      const bytes = await histogramObservationsFor(registry, 'relay_key_bandwidth_bytes');
      const msgs = await histogramObservationsFor(registry, 'relay_key_messages');
      expect(bytes.count).toBe(1);
      expect(bytes.sum).toBe(1536);
      expect(msgs.count).toBe(1);
      expect(msgs.sum).toBe(2);
    });

    it('clamps negative byte counts to zero', async () => {
      tracker.recordTraffic('pwa:abc', -100);
      tracker.flush();
      const bytes = await histogramObservationsFor(registry, 'relay_key_bandwidth_bytes');
      expect(bytes.sum).toBe(0);
      expect(bytes.count).toBe(1);
    });

    it('treats empty key as a no-op', () => {
      tracker.recordTraffic('', 100);
      expect(tracker.size).toBe(0);
    });
  });

  describe('flush', () => {
    it('emits one sample per key with traffic in the window', async () => {
      tracker.recordTraffic('a', 100);
      tracker.recordTraffic('b', 200);
      tracker.recordTraffic('c', 300);
      tracker.flush();
      const bytes = await histogramObservationsFor(registry, 'relay_key_bandwidth_bytes');
      expect(bytes.count).toBe(3);
      expect(bytes.sum).toBe(600);
    });

    it('does not emit for keys that only had markActive (no traffic)', async () => {
      tracker.markActive('a');
      tracker.markActive('b');
      tracker.flush();
      const bytes = await histogramObservationsFor(registry, 'relay_key_bandwidth_bytes');
      expect(bytes.count).toBe(0);
    });

    it('resets window counters so a second flush without new traffic emits nothing', async () => {
      tracker.recordTraffic('a', 100);
      tracker.flush();
      tracker.flush();
      const bytes = await histogramObservationsFor(registry, 'relay_key_bandwidth_bytes');
      expect(bytes.count).toBe(1);
      expect(bytes.sum).toBe(100);
    });

    it('emits a fresh sample for the same key on the next window', async () => {
      tracker.recordTraffic('a', 100);
      tracker.flush();
      now += HOUR;
      tracker.recordTraffic('a', 50);
      tracker.flush();
      const bytes = await histogramObservationsFor(registry, 'relay_key_bandwidth_bytes');
      expect(bytes.count).toBe(2);
      expect(bytes.sum).toBe(150);
    });

    it('prunes records older than the 30d window at flush time', () => {
      tracker.recordTraffic('old', 1);
      tracker.recordTraffic('new', 1);
      tracker.flush();
      now += 31 * DAY;
      tracker.recordTraffic('new', 1);
      tracker.flush();
      // 'old' should have been pruned; 'new' remains.
      expect(tracker.size).toBe(1);
    });
  });

  describe('relay_active_keys gauge', () => {
    it('counts keys whose lastSeen falls within each window', async () => {
      // Spread three keys across three timestamps.
      tracker.markActive('recent');
      now += 2 * DAY;
      tracker.markActive('mid'); // ~2d-old "recent" + this fresh "mid"
      now += 5 * DAY;
      tracker.markActive('older'); // ~7d-old "recent", ~5d-old "mid", fresh "older"
      // Now: "recent" lastSeen = now - 7d, "mid" = now - 5d, "older" = now.

      const c24h = await gaugeValueFor(registry, 'relay_active_keys', { window: '24h' });
      const c7d = await gaugeValueFor(registry, 'relay_active_keys', { window: '7d' });
      const c30d = await gaugeValueFor(registry, 'relay_active_keys', { window: '30d' });

      expect(c24h).toBe(1); // only 'older'
      expect(c7d).toBe(3); // boundary inclusive
      expect(c30d).toBe(3);
    });

    it('drops keys from the 24h window once they age out', async () => {
      tracker.markActive('a');
      now += 25 * 60 * 60 * 1000;
      tracker.markActive('b');
      const c24h = await gaugeValueFor(registry, 'relay_active_keys', { window: '24h' });
      const c7d = await gaugeValueFor(registry, 'relay_active_keys', { window: '7d' });
      expect(c24h).toBe(1); // 'a' aged out, only 'b' counts
      expect(c7d).toBe(2);
    });

    it('counts a key once even after many traffic events', async () => {
      for (let i = 0; i < 100; i++) tracker.recordTraffic('a', 1);
      const c = await gaugeValueFor(registry, 'relay_active_keys', { window: '24h' });
      expect(c).toBe(1);
    });
  });

  describe('start/stop timer', () => {
    it('does not start a timer when rollupIntervalMs is 0', () => {
      // Construction already used rollupIntervalMs=0; calling start is a no-op.
      tracker.start();
      tracker.stop(); // should not throw
    });
  });
});

