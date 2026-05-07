// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { SyncStore } from './syncStore.js';

describe('SyncStore', () => {
  let store: SyncStore;

  beforeEach(() => {
    store = new SyncStore({ maxBlobSize: 8192 });
  });

  it('should store and retrieve a blob', () => {
    store.put('abc123', 'encrypted-data');
    expect(store.get('abc123')).toEqual({ type: 'blob', data: 'encrypted-data' });
  });

  it('should return null for missing key', () => {
    expect(store.get('missing')).toBeNull();
  });

  it('should overwrite existing blob', () => {
    store.put('abc123', 'old-data');
    store.put('abc123', 'new-data');
    expect(store.get('abc123')).toEqual({ type: 'blob', data: 'new-data' });
  });

  it('should reject blobs exceeding max size', () => {
    const largeBlob = 'x'.repeat(8193);
    expect(() => store.put('abc123', largeBlob)).toThrow('exceeds max size');
  });

  it('should store a tombstone and block future writes', () => {
    store.putTombstone('abc123', '{"type":"rotated","oldPublicKey":"pk","signature":"sig"}');
    expect(store.get('abc123')).toEqual({
      type: 'tombstone',
      data: '{"type":"rotated","oldPublicKey":"pk","signature":"sig"}',
    });
    expect(() => store.put('abc123', 'new-data')).toThrow('tombstone');
  });

  it('should reject tombstone overwrite', () => {
    store.putTombstone('abc123', 'tombstone1');
    expect(() => store.putTombstone('abc123', 'tombstone2')).toThrow('Tombstone already exists');
  });

  it('should track stats correctly', () => {
    expect(store.stats).toEqual({ blobs: 0, tombstones: 0, total: 0, locks: 0, bytes: 0 });

    store.put('key1', 'data1');
    store.put('key2', 'data2');
    expect(store.stats).toEqual({
      blobs: 2,
      tombstones: 0,
      total: 2,
      locks: 0,
      bytes: 'data1'.length + 'data2'.length,
    });

    store.putTombstone('key3', 'tombstone-data');
    expect(store.stats).toEqual({
      blobs: 2,
      tombstones: 1,
      total: 3,
      locks: 0,
      bytes: 'data1'.length + 'data2'.length + 'tombstone-data'.length,
    });
  });
});
