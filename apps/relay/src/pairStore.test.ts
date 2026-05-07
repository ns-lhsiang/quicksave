// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PairStore,
  PairStoreFullError,
  PairStoreTooLargeError,
  type PairSlot,
} from './pairStore.js';

// A controllable clock so tests can advance time deterministically without
// involving real timers.
function makeClock(initial = 1_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe('PairStore', () => {
  describe('postSlot', () => {
    it('returns {id, mailboxExpiresAt} and makes the slot retrievable via getSlots', () => {
      const clock = makeClock();
      const store = new PairStore({ now: clock.now, ttlMs: 60_000 });

      const result = store.postSlot('addr-one', { data: 'hello' });

      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.mailboxExpiresAt).toBe(clock.now() + 60_000);

      const slots = store.getSlots('addr-one');
      expect(slots).toHaveLength(1);
      expect(slots[0].id).toBe(result.id);
      expect(slots[0].data).toBe('hello');
      expect(slots[0].createdAt).toBe(clock.now());
    });

    it('preserves kind when provided', () => {
      const store = new PairStore();
      store.postSlot('addr', { data: 'd1', kind: 'offer' });
      const slots = store.getSlots('addr');
      expect(slots[0].kind).toBe('offer');
    });

    it('leaves kind undefined when omitted', () => {
      const store = new PairStore();
      store.postSlot('addr', { data: 'd1' });
      const slots = store.getSlots('addr');
      expect(slots[0].kind).toBeUndefined();
    });

    it('throws PairStoreTooLargeError when data exceeds maxDataSize', () => {
      const store = new PairStore({ maxDataSize: 10 });
      expect(() =>
        store.postSlot('addr', { data: 'x'.repeat(11) }),
      ).toThrow(PairStoreTooLargeError);
    });

    it('accepts data exactly at maxDataSize limit', () => {
      const store = new PairStore({ maxDataSize: 10 });
      expect(() =>
        store.postSlot('addr', { data: 'x'.repeat(10) }),
      ).not.toThrow();
    });

    it('throws PairStoreFullError when slots reach maxSlots', () => {
      const store = new PairStore({ maxSlots: 2 });
      store.postSlot('addr', { data: 'a' });
      store.postSlot('addr', { data: 'b' });
      expect(() => store.postSlot('addr', { data: 'c' })).toThrow(
        PairStoreFullError,
      );
    });

    it('fires subscriber callbacks in the order they were registered', () => {
      const store = new PairStore();
      const order: string[] = [];
      store.subscribe('addr', () => order.push('first'));
      store.subscribe('addr', () => order.push('second'));
      store.subscribe('addr', () => order.push('third'));

      store.postSlot('addr', { data: 'd' });

      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('extends mailboxExpiresAt on activity', () => {
      const clock = makeClock(1_000_000);
      const store = new PairStore({ now: clock.now, ttlMs: 10_000 });

      const first = store.postSlot('addr', { data: 'a' });
      expect(first.mailboxExpiresAt).toBe(1_010_000);

      clock.advance(5_000); // 1_005_000
      const second = store.postSlot('addr', { data: 'b' });
      // Second post at t=1_005_000 with ttl=10_000 pushes expiry to 1_015_000
      expect(second.mailboxExpiresAt).toBe(1_015_000);
      expect(second.mailboxExpiresAt).toBeGreaterThan(first.mailboxExpiresAt);
    });

    it('generates distinct ids for multiple slots', () => {
      const store = new PairStore();
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const { id } = store.postSlot('addr', { data: `d${i}` });
        ids.add(id);
      }
      expect(ids.size).toBe(10);
    });
  });

  describe('getSlots', () => {
    it('returns an empty array for an unknown addr', () => {
      const store = new PairStore();
      expect(store.getSlots('never-seen')).toEqual([]);
    });

    it('returns an empty array AND removes mailbox when expired', () => {
      const clock = makeClock(1_000_000);
      const store = new PairStore({ now: clock.now, ttlMs: 10_000 });
      store.postSlot('addr', { data: 'a' });
      expect(store.stats.mailboxes).toBe(1);

      // Jump past expiry
      clock.advance(20_000);
      expect(store.getSlots('addr')).toEqual([]);
      expect(store.stats.mailboxes).toBe(0);
    });

    it('returns a copy (mutating result does not affect store)', () => {
      const store = new PairStore();
      store.postSlot('addr', { data: 'a' });
      const slots = store.getSlots('addr');
      slots.push({ id: 'injected', data: 'hacked', createdAt: 0 });
      expect(store.getSlots('addr')).toHaveLength(1);
    });

    it('returns slots in post order', () => {
      const store = new PairStore();
      store.postSlot('addr', { data: 'first' });
      store.postSlot('addr', { data: 'second' });
      store.postSlot('addr', { data: 'third' });
      const datas = store.getSlots('addr').map((s) => s.data);
      expect(datas).toEqual(['first', 'second', 'third']);
    });
  });

  describe('deleteMailbox', () => {
    it('removes slots so subsequent getSlots returns []', () => {
      const store = new PairStore();
      store.postSlot('addr', { data: 'a' });
      store.deleteMailbox('addr');
      expect(store.getSlots('addr')).toEqual([]);
    });

    it('is a no-op for unknown addr', () => {
      const store = new PairStore();
      expect(() => store.deleteMailbox('never-seen')).not.toThrow();
    });

    it('removes listeners so a subscriber registered BEFORE delete does not fire for subsequent posts', () => {
      const store = new PairStore();
      const calls: PairSlot[] = [];
      store.subscribe('addr', (slot) => calls.push(slot));

      store.postSlot('addr', { data: 'pre-delete' });
      expect(calls).toHaveLength(1);

      store.deleteMailbox('addr');

      store.postSlot('addr', { data: 'post-delete' });
      expect(calls).toHaveLength(1); // still just the pre-delete event
    });

    it('clears subscriber/mailbox counts from stats', () => {
      const store = new PairStore();
      store.subscribe('addr', () => {});
      store.postSlot('addr', { data: 'a' });
      expect(store.stats.mailboxes).toBe(1);

      store.deleteMailbox('addr');

      expect(store.stats.mailboxes).toBe(0);
      expect(store.stats.slots).toBe(0);
      expect(store.stats.subscribers).toBe(0);
    });
  });

  describe('subscribe', () => {
    it('returns an unsubscribe fn that removes the listener', () => {
      const store = new PairStore();
      const calls: PairSlot[] = [];
      const unsub = store.subscribe('addr', (slot) => calls.push(slot));

      store.postSlot('addr', { data: 'a' });
      expect(calls).toHaveLength(1);

      unsub();
      store.postSlot('addr', { data: 'b' });
      expect(calls).toHaveLength(1);
    });

    it('unsubscribe is safe to call twice', () => {
      const store = new PairStore();
      const unsub = store.subscribe('addr', () => {});
      unsub();
      expect(() => unsub()).not.toThrow();
    });

    it('listener fires exactly once per postSlot', () => {
      const store = new PairStore();
      const fn = vi.fn();
      store.subscribe('addr', fn);
      store.postSlot('addr', { data: 'a' });
      store.postSlot('addr', { data: 'b' });
      store.postSlot('addr', { data: 'c' });
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('multiple subscribers on the same addr all fire', () => {
      const store = new PairStore();
      const a = vi.fn();
      const b = vi.fn();
      const c = vi.fn();
      store.subscribe('addr', a);
      store.subscribe('addr', b);
      store.subscribe('addr', c);

      store.postSlot('addr', { data: 'd' });

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);
    });

    it('a throwing listener does not break other listeners or postSlot', () => {
      const store = new PairStore();
      const after = vi.fn();
      store.subscribe('addr', () => {
        throw new Error('boom');
      });
      store.subscribe('addr', after);

      expect(() =>
        store.postSlot('addr', { data: 'd' }),
      ).not.toThrow();
      expect(after).toHaveBeenCalledTimes(1);
    });

    it('subscribing only to an addr (no posts yet) does not produce slots', () => {
      const store = new PairStore();
      store.subscribe('addr', () => {});
      expect(store.getSlots('addr')).toEqual([]);
    });

    it('listener receives the slot object that was appended', () => {
      const store = new PairStore();
      let received: PairSlot | null = null;
      store.subscribe('addr', (slot) => {
        received = slot;
      });
      const { id } = store.postSlot('addr', { data: 'hi', kind: 'offer' });
      expect(received).not.toBeNull();
      expect(received!.id).toBe(id);
      expect(received!.data).toBe('hi');
      expect(received!.kind).toBe('offer');
    });
  });

  describe('gc', () => {
    it('removes mailboxes whose expiry has passed', () => {
      const clock = makeClock(1_000_000);
      const store = new PairStore({ now: clock.now, ttlMs: 10_000 });

      store.postSlot('a', { data: '1' });
      store.postSlot('b', { data: '2' });
      expect(store.stats.mailboxes).toBe(2);

      clock.advance(20_000);
      store.gc();
      expect(store.stats.mailboxes).toBe(0);
    });

    it('keeps mailboxes whose expiry has not passed', () => {
      const clock = makeClock(1_000_000);
      const store = new PairStore({ now: clock.now, ttlMs: 10_000 });

      store.postSlot('a', { data: '1' });
      clock.advance(5_000);
      store.gc();
      expect(store.stats.mailboxes).toBe(1);
    });

    it('only evicts the expired mailboxes, not the fresh ones', () => {
      const clock = makeClock(1_000_000);
      const store = new PairStore({ now: clock.now, ttlMs: 10_000 });

      store.postSlot('old', { data: '1' });
      clock.advance(9_000);
      store.postSlot('fresh', { data: '2' });
      // old: expires at 1_010_000; fresh: expires at 1_019_000
      clock.advance(2_000); // now at 1_011_000 — old is expired, fresh is not
      store.gc();
      expect(store.stats.mailboxes).toBe(1);
      expect(store.getSlots('old')).toEqual([]);
      expect(store.getSlots('fresh')).toHaveLength(1);
    });
  });

  describe('startGc / stopGc', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('is idempotent (calling startGc twice does not double-schedule)', () => {
      const store = new PairStore();
      const spy = vi.spyOn(store, 'gc');

      store.startGc(100);
      store.startGc(100); // second call should be a no-op

      vi.advanceTimersByTime(350);

      // Exactly 3 ticks should have fired if only one interval is active.
      expect(spy).toHaveBeenCalledTimes(3);

      store.stopGc();
    });

    it('stopGc clears the timer so no more gc calls happen', () => {
      const store = new PairStore();
      const spy = vi.spyOn(store, 'gc');

      store.startGc(100);
      vi.advanceTimersByTime(150); // 1 tick
      expect(spy).toHaveBeenCalledTimes(1);

      store.stopGc();
      vi.advanceTimersByTime(1_000);
      expect(spy).toHaveBeenCalledTimes(1); // no additional ticks
    });

    it('stopGc is safe to call when startGc was never called', () => {
      const store = new PairStore();
      expect(() => store.stopGc()).not.toThrow();
    });
  });

  describe('stats', () => {
    it('reports zeros for an empty store', () => {
      const store = new PairStore();
      expect(store.stats).toEqual({ mailboxes: 0, slots: 0, subscribers: 0 });
    });

    it('counts mailboxes, slots, and subscribers accurately', () => {
      const store = new PairStore();
      store.postSlot('a', { data: 'd1' });
      store.postSlot('a', { data: 'd2' });
      store.postSlot('b', { data: 'd3' });
      store.subscribe('a', () => {});
      store.subscribe('a', () => {});
      store.subscribe('b', () => {});
      // subscribe('c', ...) creates a third mailbox with 1 subscriber + 0 slots
      store.subscribe('c', () => {});

      expect(store.stats).toEqual({
        mailboxes: 3,
        slots: 3,
        subscribers: 4,
      });
    });

    it('updates after unsubscribe', () => {
      const store = new PairStore();
      const unsub = store.subscribe('a', () => {});
      store.subscribe('a', () => {});
      expect(store.stats.subscribers).toBe(2);
      unsub();
      expect(store.stats.subscribers).toBe(1);
    });
  });

  describe('onMailboxOutcome', () => {
    it('fires "deleted" when deleteMailbox is called on an existing mailbox', () => {
      const outcomes: string[] = [];
      const store = new PairStore({
        onMailboxOutcome: (o) => outcomes.push(o),
      });
      store.postSlot('addr', { data: 'x' });
      store.deleteMailbox('addr');
      expect(outcomes).toEqual(['deleted']);
    });

    it('does not fire on deleteMailbox for an unknown mailbox', () => {
      const outcomes: string[] = [];
      const store = new PairStore({
        onMailboxOutcome: (o) => outcomes.push(o),
      });
      store.deleteMailbox('never-existed');
      expect(outcomes).toEqual([]);
    });

    it('fires "expired_with_slots" via gc() when slots were posted', () => {
      const clock = makeClock();
      const outcomes: string[] = [];
      const store = new PairStore({
        now: clock.now,
        ttlMs: 100,
        onMailboxOutcome: (o) => outcomes.push(o),
      });
      store.postSlot('addr', { data: 'x' });
      clock.advance(200);
      store.gc();
      expect(outcomes).toEqual(['expired_with_slots']);
    });

    it('fires "expired_empty" via gc() when subscribe created an empty mailbox', () => {
      const clock = makeClock();
      const outcomes: string[] = [];
      const store = new PairStore({
        now: clock.now,
        ttlMs: 100,
        onMailboxOutcome: (o) => outcomes.push(o),
      });
      // subscribe creates an empty mailbox (initiator opens but no joiner posts)
      store.subscribe('addr', () => {});
      clock.advance(200);
      store.gc();
      expect(outcomes).toEqual(['expired_empty']);
    });

    it('fires the right outcome when getSlots lazy-expires a mailbox', () => {
      const clock = makeClock();
      const outcomes: string[] = [];
      const store = new PairStore({
        now: clock.now,
        ttlMs: 100,
        onMailboxOutcome: (o) => outcomes.push(o),
      });
      store.postSlot('addr', { data: 'x' });
      clock.advance(200);
      // getSlots should trip the inline expiry path.
      const slots = store.getSlots('addr');
      expect(slots).toEqual([]);
      expect(outcomes).toEqual(['expired_with_slots']);
    });

    it('does not double-fire when an already-expired mailbox is gc()d', () => {
      const clock = makeClock();
      const outcomes: string[] = [];
      const store = new PairStore({
        now: clock.now,
        ttlMs: 100,
        onMailboxOutcome: (o) => outcomes.push(o),
      });
      store.postSlot('addr', { data: 'x' });
      clock.advance(200);
      store.getSlots('addr'); // lazy-expires
      store.gc(); // should be a no-op
      expect(outcomes).toEqual(['expired_with_slots']);
    });
  });
});
