// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setQuicksaveDir, getAttachmentsDir } from '../service/singleton.js';
import {
  persistAttachments,
  loadAttachment,
  hasPersistedAttachment,
  removeSessionAttachments,
  listSessionAttachments,
  readTurnManifest,
} from './attachmentStore.js';
import type { Attachment } from '@sumicom/quicksave-shared';

function makeAttachment(id: string, body: string): Attachment {
  return {
    id,
    kind: 'text',
    mimeType: 'text/plain',
    name: `${id}.txt`,
    size: Buffer.byteLength(body, 'utf8'),
    data: Buffer.from(body, 'utf8').toString('base64'),
  };
}

describe('attachmentStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `qs-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    setQuicksaveDir(dir);
  });

  afterEach(async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('persists and reloads an attachment by sessionId+id', async () => {
    const a = makeAttachment('a1', 'hello world');
    await persistAttachments('s1', [a]);

    expect(await hasPersistedAttachment('s1', 'a1')).toBe(true);
    const loaded = await loadAttachment('s1', 'a1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('a1');
    expect(loaded!.kind).toBe('text');
    expect(Buffer.from(loaded!.data, 'base64').toString('utf8')).toBe('hello world');
  });

  it('isolates attachments by sessionId', async () => {
    await persistAttachments('s1', [makeAttachment('shared', 'A')]);
    await persistAttachments('s2', [makeAttachment('shared', 'B')]);

    const aFromS1 = await loadAttachment('s1', 'shared');
    const aFromS2 = await loadAttachment('s2', 'shared');
    expect(Buffer.from(aFromS1!.data, 'base64').toString('utf8')).toBe('A');
    expect(Buffer.from(aFromS2!.data, 'base64').toString('utf8')).toBe('B');
  });

  it('returns null for unknown ids', async () => {
    expect(await loadAttachment('nonexistent', 'nope')).toBeNull();
    await persistAttachments('s1', [makeAttachment('one', 'x')]);
    expect(await loadAttachment('s1', 'two')).toBeNull();
  });

  it('removeSessionAttachments wipes the directory', async () => {
    await persistAttachments('s1', [makeAttachment('a', 'x'), makeAttachment('b', 'y')]);
    expect((await listSessionAttachments('s1')).length).toBe(2);
    await removeSessionAttachments('s1');
    expect((await listSessionAttachments('s1')).length).toBe(0);
    expect(await loadAttachment('s1', 'a')).toBeNull();
  });

  it('overwrites bytes when the same id is re-persisted', async () => {
    await persistAttachments('s1', [makeAttachment('a', 'first')]);
    await persistAttachments('s1', [makeAttachment('a', 'second')]);
    const loaded = await loadAttachment('s1', 'a');
    expect(Buffer.from(loaded!.data, 'base64').toString('utf8')).toBe('second');
  });

  it('attachments dir lives under the configured quicksave dir', () => {
    expect(getAttachmentsDir()).toBe(join(dir, 'state', 'attachments'));
  });

  it('appends a turn-manifest line per persistAttachments call, in send order', async () => {
    await persistAttachments('s1', [makeAttachment('a', 'A'), makeAttachment('b', 'B')]);
    await persistAttachments('s1', [makeAttachment('c', 'C')]);
    await persistAttachments('s1', [makeAttachment('d', 'D'), makeAttachment('e', 'E'), makeAttachment('f', 'F')]);

    const manifest = await readTurnManifest('s1');
    expect(manifest).toEqual([
      { ids: ['a', 'b'] },
      { ids: ['c'] },
      { ids: ['d', 'e', 'f'] },
    ]);
  });

  it('readTurnManifest returns [] when no manifest exists', async () => {
    expect(await readTurnManifest('never-persisted')).toEqual([]);
  });

  it('persistAttachments with empty array does not create a manifest line', async () => {
    await persistAttachments('s1', []);
    expect(await readTurnManifest('s1')).toEqual([]);

    await persistAttachments('s1', [makeAttachment('a', 'x')]);
    await persistAttachments('s1', []); // no-op
    await persistAttachments('s1', [makeAttachment('b', 'y')]);
    expect(await readTurnManifest('s1')).toEqual([
      { ids: ['a'] },
      { ids: ['b'] },
    ]);
  });

  it('removeSessionAttachments also drops the turn manifest', async () => {
    await persistAttachments('s1', [makeAttachment('a', 'x')]);
    expect((await readTurnManifest('s1')).length).toBe(1);
    await removeSessionAttachments('s1');
    expect(await readTurnManifest('s1')).toEqual([]);
  });

  it('readTurnManifest skips malformed lines without throwing', async () => {
    await persistAttachments('s1', [makeAttachment('a', 'x')]);
    // corrupt the manifest with a bad line and a valid line
    const { appendFile } = await import('fs/promises');
    const path = join(getAttachmentsDir(), 's1', 'turn-manifest.jsonl');
    await appendFile(path, 'not-json\n');
    await appendFile(path, JSON.stringify({ ids: ['b'] }) + '\n');
    await appendFile(path, JSON.stringify({ ids: 'not-an-array' }) + '\n');

    const manifest = await readTurnManifest('s1');
    expect(manifest).toEqual([
      { ids: ['a'] },
      { ids: ['b'] },
    ]);
  });
});
