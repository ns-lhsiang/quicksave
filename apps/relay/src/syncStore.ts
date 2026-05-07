// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
interface SyncEntry {
  data: string;
  isTombstone: boolean;
  updatedAt: number;
}

interface SyncStoreConfig {
  maxBlobSize: number; // bytes
  lockTtlMs?: number;
  now?: () => number;
}

export interface MailboxLock {
  sigPubkey: string;
  acquiredAt: number;
  expiresAt: number;
}

export class SyncStore {
  private entries = new Map<string, SyncEntry>();
  private locks = new Map<string, MailboxLock>();
  private config: Required<Omit<SyncStoreConfig, 'now'>> & { now: () => number };

  constructor(config: SyncStoreConfig = { maxBlobSize: 8192 }) {
    this.config = {
      maxBlobSize: config.maxBlobSize,
      lockTtlMs: config.lockTtlMs ?? 10_000,
      now: config.now ?? Date.now,
    };
  }

  /**
   * Attempt to acquire the per-mailbox write lock. Returns `{ ok: true }` on
   * success, `{ ok: false, heldBy }` if another key holds it. Re-acquisition
   * by the same `sigPubkey` is idempotent and refreshes the TTL.
   */
  tryAcquireLock(
    keyHash: string,
    sigPubkey: string,
  ): { ok: true; expiresAt: number } | { ok: false; heldBy: MailboxLock } {
    const now = this.config.now();
    const existing = this.locks.get(keyHash);
    if (existing && existing.expiresAt > now && existing.sigPubkey !== sigPubkey) {
      return { ok: false, heldBy: existing };
    }
    const expiresAt = now + this.config.lockTtlMs;
    this.locks.set(keyHash, { sigPubkey, acquiredAt: now, expiresAt });
    return { ok: true, expiresAt };
  }

  /**
   * Release the lock if (and only if) held by `sigPubkey`. Returns true if
   * a lock was released, false otherwise. Expired locks count as released.
   */
  releaseLock(keyHash: string, sigPubkey: string): boolean {
    const existing = this.locks.get(keyHash);
    if (!existing) return false;
    if (existing.expiresAt <= this.config.now()) {
      this.locks.delete(keyHash);
      return true;
    }
    if (existing.sigPubkey !== sigPubkey) return false;
    this.locks.delete(keyHash);
    return true;
  }

  /** For debug/stats only. */
  peekLock(keyHash: string): MailboxLock | null {
    const existing = this.locks.get(keyHash);
    if (!existing) return null;
    if (existing.expiresAt <= this.config.now()) {
      this.locks.delete(keyHash);
      return null;
    }
    return existing;
  }

  get(keyHash: string): { type: 'blob' | 'tombstone'; data: string } | null {
    const entry = this.entries.get(keyHash);
    if (!entry) return null;
    return {
      type: entry.isTombstone ? 'tombstone' : 'blob',
      data: entry.data,
    };
  }

  put(keyHash: string, data: string): void {
    const existing = this.entries.get(keyHash);
    if (existing?.isTombstone) {
      throw new Error('Cannot write to key with tombstone');
    }
    if (data.length > this.config.maxBlobSize) {
      throw new Error(`Blob exceeds max size (${this.config.maxBlobSize} bytes)`);
    }
    this.entries.set(keyHash, {
      data,
      isTombstone: false,
      updatedAt: Date.now(),
    });
  }

  putTombstone(keyHash: string, data: string): void {
    const existing = this.entries.get(keyHash);
    if (existing?.isTombstone) {
      throw new Error('Tombstone already exists for this key');
    }
    this.entries.set(keyHash, {
      data,
      isTombstone: true,
      updatedAt: Date.now(),
    });
  }

  get stats() {
    let blobs = 0;
    let tombstones = 0;
    let bytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.isTombstone) tombstones++;
      else blobs++;
      bytes += entry.data.length;
    }
    const now = this.config.now();
    let activeLocks = 0;
    for (const lock of this.locks.values()) {
      if (lock.expiresAt > now) activeLocks++;
    }
    return {
      blobs,
      tombstones,
      total: this.entries.size,
      locks: activeLocks,
      bytes,
    };
  }
}
