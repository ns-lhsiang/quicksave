// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
export interface PairSlot {
  id: string;
  data: string;
  kind?: string;
  createdAt: number;
}

interface PairMailbox {
  slots: PairSlot[];
  expiresAt: number;
  listeners: Set<(slot: PairSlot) => void>;
}

export type PairMailboxOutcome = 'deleted' | 'expired_with_slots' | 'expired_empty';

export interface PairStoreConfig {
  ttlMs?: number;
  maxSlots?: number;
  maxDataSize?: number;
  now?: () => number;
  /**
   * Fired when a mailbox leaves the store via explicit delete or TTL expiry.
   * Used by metrics to count pair-flow outcomes; safe to omit.
   */
  onMailboxOutcome?: (outcome: PairMailboxOutcome) => void;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_SLOTS = 64;
const DEFAULT_MAX_DATA_SIZE = 8192;

export class PairStoreFullError extends Error {
  constructor() {
    super('mailbox full');
    this.name = 'PairStoreFullError';
  }
}

export class PairStoreTooLargeError extends Error {
  constructor(limit: number) {
    super(`slot data exceeds max size (${limit} bytes)`);
    this.name = 'PairStoreTooLargeError';
  }
}

/**
 * Append-only multi-slot mailbox keyed by a pair address (base64url of an
 * ephemeral pubkey). Each mailbox holds up to `maxSlots` opaque ciphertext
 * blobs and is garbage-collected once its TTL elapses.
 *
 * The store is process-local; for HA we'd back it with Redis, but for the
 * single-relay deployment this is sufficient.
 */
export class PairStore {
  private mailboxes = new Map<string, PairMailbox>();
  private readonly ttlMs: number;
  private readonly maxSlots: number;
  private readonly maxDataSize: number;
  private readonly now: () => number;
  private readonly onMailboxOutcome?: (outcome: PairMailboxOutcome) => void;
  private nextId = 1;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: PairStoreConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSlots = config.maxSlots ?? DEFAULT_MAX_SLOTS;
    this.maxDataSize = config.maxDataSize ?? DEFAULT_MAX_DATA_SIZE;
    this.now = config.now ?? Date.now;
    this.onMailboxOutcome = config.onMailboxOutcome;
  }

  startGc(intervalMs = 30_000): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gc(), intervalMs);
    // Allow Node process to exit even if GC timer is active.
    this.gcTimer.unref?.();
  }

  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  gc(): void {
    const t = this.now();
    for (const [addr, mb] of this.mailboxes) {
      if (mb.expiresAt <= t) {
        const outcome: PairMailboxOutcome =
          mb.slots.length > 0 ? 'expired_with_slots' : 'expired_empty';
        mb.listeners.clear();
        this.mailboxes.delete(addr);
        this.onMailboxOutcome?.(outcome);
      }
    }
  }

  postSlot(
    addr: string,
    input: { data: string; kind?: string },
  ): { id: string; mailboxExpiresAt: number } {
    if (input.data.length > this.maxDataSize) {
      throw new PairStoreTooLargeError(this.maxDataSize);
    }
    const t = this.now();
    const mb = this.ensureMailbox(addr, t + this.ttlMs);
    // Extend TTL on activity so in-flight pairings don't expire mid-flow.
    if (mb.expiresAt < t + this.ttlMs) mb.expiresAt = t + this.ttlMs;
    if (mb.slots.length >= this.maxSlots) {
      throw new PairStoreFullError();
    }
    const id = `s-${this.nextId++}-${t}`;
    const slot: PairSlot = {
      id,
      data: input.data,
      kind: input.kind,
      createdAt: t,
    };
    mb.slots.push(slot);
    for (const fn of mb.listeners) {
      try {
        fn(slot);
      } catch {
        // listener errors are isolated
      }
    }
    return { id, mailboxExpiresAt: mb.expiresAt };
  }

  getSlots(addr: string): PairSlot[] {
    const mb = this.mailboxes.get(addr);
    if (!mb) return [];
    if (mb.expiresAt <= this.now()) {
      const outcome: PairMailboxOutcome =
        mb.slots.length > 0 ? 'expired_with_slots' : 'expired_empty';
      mb.listeners.clear();
      this.mailboxes.delete(addr);
      this.onMailboxOutcome?.(outcome);
      return [];
    }
    return mb.slots.slice();
  }

  deleteMailbox(addr: string): void {
    const mb = this.mailboxes.get(addr);
    if (mb) {
      mb.listeners.clear();
      mb.slots = [];
      this.mailboxes.delete(addr);
      this.onMailboxOutcome?.('deleted');
    }
  }

  subscribe(
    addr: string,
    onSlot: (slot: PairSlot) => void,
  ): () => void {
    const mb = this.ensureMailbox(addr, this.now() + this.ttlMs);
    mb.listeners.add(onSlot);
    return () => {
      const current = this.mailboxes.get(addr);
      if (current) current.listeners.delete(onSlot);
    };
  }

  get stats() {
    let totalSlots = 0;
    let totalListeners = 0;
    for (const mb of this.mailboxes.values()) {
      totalSlots += mb.slots.length;
      totalListeners += mb.listeners.size;
    }
    return {
      mailboxes: this.mailboxes.size,
      slots: totalSlots,
      subscribers: totalListeners,
    };
  }

  private ensureMailbox(addr: string, expiresAt: number): PairMailbox {
    let mb = this.mailboxes.get(addr);
    if (!mb) {
      mb = { slots: [], expiresAt, listeners: new Set() };
      this.mailboxes.set(addr, mb);
    }
    return mb;
  }
}
