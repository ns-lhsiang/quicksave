// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Persistent attachment store on the agent.
//
// Once `attachmentStaging.consume(...)` materializes an `Attachment[]` for a
// `claude:start` / `claude:resume`, the messageHandler also writes each
// attachment to disk under
//
//   <state>/attachments/<sessionId>/<attachmentId>.bin    (base64-decoded bytes)
//   <state>/attachments/<sessionId>/<attachmentId>.meta.json
//
// The PWA fetches bytes on demand via `attachment:fetch { sessionId, id }`,
// caches them in `attachmentCache` (L1/L2), and renders chip thumbnails
// without dragging the data through every card-history snapshot.
//
// Cleanup happens on session end-task: `removeSessionAttachments(sessionId)`
// nukes the directory.
// ============================================================================

import { mkdir, readFile, writeFile, appendFile, rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { Attachment, AttachmentMetadata } from '@sumicom/quicksave-shared';
import { getAttachmentsDir } from '../service/singleton.js';

export interface PersistedMeta {
  id: string;
  kind: AttachmentMetadata['kind'];
  mimeType: string;
  name: string;
  size: number;
  storedAt: number;
}

function dirFor(sessionId: string): string {
  return join(getAttachmentsDir(), sessionId);
}

function binPathFor(sessionId: string, attachmentId: string): string {
  return join(dirFor(sessionId), `${attachmentId}.bin`);
}

function metaPathFor(sessionId: string, attachmentId: string): string {
  return join(dirFor(sessionId), `${attachmentId}.meta.json`);
}

function turnManifestPathFor(sessionId: string): string {
  return join(dirFor(sessionId), 'turn-manifest.jsonl');
}

/**
 * Persist a batch of resolved attachments under one session id. Idempotent
 * per id — re-writing the same id overwrites both files.
 */
export async function persistAttachments(
  sessionId: string,
  attachments: readonly Attachment[],
): Promise<void> {
  if (attachments.length === 0) return;
  await mkdir(dirFor(sessionId), { recursive: true });
  await Promise.all(attachments.map(async (a) => {
    const bytes = Buffer.from(a.data, 'base64');
    await writeFile(binPathFor(sessionId, a.id), bytes);
    const meta: PersistedMeta = {
      id: a.id,
      kind: a.kind,
      mimeType: a.mimeType,
      name: a.name,
      size: a.size,
      storedAt: Date.now(),
    };
    await writeFile(metaPathFor(sessionId, a.id), JSON.stringify(meta));
  }));
  // Append a turn-manifest line so the cardBuilder can rebind on JSONL replay
  // by exact UUID instead of falling back to fuzzy (kind+size+name) match.
  // One line per attachment-bearing user turn, in send order.
  const line = JSON.stringify({ ids: attachments.map((a) => a.id) }) + '\n';
  await appendFile(turnManifestPathFor(sessionId), line);
}

export interface TurnManifestEntry {
  ids: string[];
}

/**
 * Read the per-session attachment turn manifest in send order. Returns an
 * empty array if no manifest exists yet (e.g. a session whose attachments
 * predate this code), letting callers fall back to fuzzy rebind.
 */
export async function readTurnManifest(sessionId: string): Promise<TurnManifestEntry[]> {
  let raw: string;
  try {
    raw = await readFile(turnManifestPathFor(sessionId), 'utf8');
  } catch {
    return [];
  }
  const out: TurnManifestEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && Array.isArray(parsed.ids) && parsed.ids.every((x: unknown) => typeof x === 'string')) {
        out.push({ ids: parsed.ids as string[] });
      }
    } catch {
      // skip malformed line — don't break the whole replay
    }
  }
  return out;
}

/**
 * Read one attachment's bytes back, returning the wire `Attachment` shape
 * (metadata + base64 data). Returns `null` if the attachment isn't on disk
 * — e.g. session was end-tasked, or the JSONL had an attachment we didn't
 * persist (cold-start session before this code shipped).
 */
export async function loadAttachment(
  sessionId: string,
  attachmentId: string,
): Promise<Attachment | null> {
  let metaRaw: string;
  let bytes: Buffer;
  try {
    [metaRaw, bytes] = await Promise.all([
      readFile(metaPathFor(sessionId, attachmentId), 'utf8'),
      readFile(binPathFor(sessionId, attachmentId)),
    ]);
  } catch {
    return null;
  }
  let meta: PersistedMeta;
  try {
    meta = JSON.parse(metaRaw) as PersistedMeta;
  } catch {
    return null;
  }
  return {
    id: meta.id,
    kind: meta.kind,
    mimeType: meta.mimeType,
    name: meta.name,
    size: meta.size,
    data: bytes.toString('base64'),
  };
}

/** Drop every persisted attachment for one session (called on end-task). */
export async function removeSessionAttachments(sessionId: string): Promise<void> {
  try {
    await rm(dirFor(sessionId), { recursive: true, force: true });
  } catch {
    // best effort — orphaned files are tolerable, they're local-only
  }
}

/**
 * List metadata for every attachment persisted under a session id. Mainly
 * for diagnostics / tests.
 */
export async function listSessionAttachments(sessionId: string): Promise<PersistedMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(dirFor(sessionId));
  } catch {
    return [];
  }
  const metas: PersistedMeta[] = [];
  for (const name of entries) {
    if (!name.endsWith('.meta.json')) continue;
    try {
      const raw = await readFile(join(dirFor(sessionId), name), 'utf8');
      metas.push(JSON.parse(raw) as PersistedMeta);
    } catch {
      // skip unreadable metas
    }
  }
  return metas;
}

/** True if the meta+bin pair exist on disk — without reading the bytes. */
export async function hasPersistedAttachment(
  sessionId: string,
  attachmentId: string,
): Promise<boolean> {
  try {
    await Promise.all([
      stat(metaPathFor(sessionId, attachmentId)),
      stat(binPathFor(sessionId, attachmentId)),
    ]);
    return true;
  } catch {
    return false;
  }
}
