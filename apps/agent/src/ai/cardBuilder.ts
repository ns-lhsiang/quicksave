// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type {
  Attachment,
  AttachmentMetadata,
  Card,
  CardId,
  CardEvent,
  CardAddEvent,
  CardUpdateEvent,
  CardAppendTextEvent,
  CardRemoveEvent,
  CardHistoryResponse,
  ToolCallCard,
  SubagentCard,
  PendingInputAttachment,
} from '@sumicom/quicksave-shared';
import { readFile, readdir, writeFile, mkdir, stat, open } from 'fs/promises';
import { join } from 'path';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { getCardHistoryDir } from '../service/singleton.js';
import { listSessionAttachments, readTurnManifest, type PersistedMeta } from './attachmentStore.js';

/** Decoded byte length of a base64 string, accounting for `=` padding. */
function decodedBase64Bytes(base64: unknown): number {
  if (typeof base64 !== 'string') return 0;
  const len = base64.length;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/** Pool that lets us look up a persisted attachment by `(kind, size)` —
 *  optionally name-tiebroken — and remove it so duplicates match correctly.
 *  Used to recover the original upload UUIDs for attachments rebuilt from
 *  JSONL (which doesn't carry our ids). */
function makeAttachmentResolver(metas: readonly PersistedMeta[]) {
  const pool = new Map<string, PersistedMeta[]>();
  for (const m of metas) {
    const key = `${m.kind}:${m.size}`;
    const list = pool.get(key) ?? [];
    list.push(m);
    pool.set(key, list);
  }
  return function consume(kind: AttachmentMetadata['kind'], size: number, name?: string): PersistedMeta | null {
    const list = pool.get(`${kind}:${size}`);
    if (!list || list.length === 0) return null;
    let idx = 0;
    if (name !== undefined) {
      const named = list.findIndex((m) => m.name === name);
      if (named >= 0) idx = named;
    }
    const [matched] = list.splice(idx, 1);
    if (list.length === 0) pool.delete(`${kind}:${size}`);
    return matched;
  };
}

const TOOL_RESULT_TRUNCATE_LENGTH = 500;

// ── Card history persistence (for memory-mode providers like Codex) ──

function cardHistoryPath(sessionId: string): string {
  return join(getCardHistoryDir(), `${sessionId}.json`);
}

/**
 * Load persisted card history for a memory-mode session.
 * Returns cards in insertion order, or empty array if none exist.
 */
export async function loadPersistedCards(sessionId: string): Promise<Card[]> {
  const p = cardHistoryPath(sessionId);
  if (!existsSync(p)) return [];
  try {
    const raw = await readFile(p, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ── Direct JSONL file reading (replaces SDK getSessionMessages/listSubagents) ──

function encodeCwdPath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwdPath(cwd));
}

function jsonlPath(sessionId: string, cwd: string): string {
  return join(claudeProjectDir(cwd), sessionId + '.jsonl');
}

function parseJSONLContent(content: string): any[] {
  const msgs: any[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.type === 'user' || m.type === 'assistant' || m.type === 'system') msgs.push(m);
    } catch { /* skip malformed lines */ }
  }
  return msgs;
}

/** Count valid non-sidechain messages by streaming the file (constant memory). */
async function countMessagesInJSONL(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line || line[0] !== '{') return;
      try {
        const m = JSON.parse(line);
        if ((m.type === 'user' || m.type === 'assistant' || m.type === 'system') && !m.isSidechain) count++;
      } catch { /* skip */ }
    });
    rl.on('close', () => resolve(count));
    rl.on('error', reject);
  });
}

/** Read the tail of a file, dropping the first partial line at the cut boundary. */
async function readTailContent(filePath: string, bytes: number): Promise<string> {
  const { size } = await stat(filePath);
  if (size <= bytes) return await readFile(filePath, 'utf-8');

  const fh = await open(filePath, 'r');
  try {
    const start = size - bytes;
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, start);
    let content = buf.toString('utf-8', 0, bytesRead);
    // Drop leading partial line (may also be mid-UTF-8)
    const firstNl = content.indexOf('\n');
    if (firstNl >= 0) content = content.slice(firstNl + 1);
    return content;
  } finally {
    await fh.close();
  }
}

/**
 * Read messages from a session JSONL file.
 *
 * Modes:
 *  - `headBytes` — read only the first N bytes (for active-turn cutoff).
 *  - `tailBytes` — read only the last N bytes (for large-file pagination).
 *  - neither      — read the entire file.
 */
async function readMessagesFromJSONL(
  sessionId: string,
  cwd: string,
  opts?: { headBytes?: number; tailBytes?: number },
): Promise<any[]> {
  const p = jsonlPath(sessionId, cwd);
  if (!existsSync(p)) return [];

  if (opts?.headBytes != null) {
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(opts.headBytes);
      const { bytesRead } = await fh.read(buf, 0, opts.headBytes, 0);
      let raw = buf.toString('utf-8', 0, bytesRead);
      const lastNewline = raw.lastIndexOf('\n');
      if (lastNewline >= 0 && lastNewline < raw.length - 1) {
        raw = raw.slice(0, lastNewline + 1);
      }
      return parseJSONLContent(raw);
    } finally {
      await fh.close();
    }
  }

  if (opts?.tailBytes != null) {
    const content = await readTailContent(p, opts.tailBytes);
    return parseJSONLContent(content);
  }

  const content = await readFile(p, 'utf-8');
  return parseJSONLContent(content);
}

async function listSubagentIdsFromDisk(sessionId: string, cwd: string): Promise<string[]> {
  const d = join(claudeProjectDir(cwd), sessionId, 'subagents');
  if (!existsSync(d)) return [];
  try {
    return (await readdir(d)).filter(f => f.endsWith('.meta.json')).map(f => f.replace('.meta.json', ''));
  } catch { return []; }
}

/**
 * Normalize an AskUserQuestion answers map from the CLI's persisted
 * `toolUseResult.answers`. Handles two shapes:
 *
 * 1. Correct: one key per question, each value is the user's answer for
 *    that question. Pass through untouched.
 * 2. Legacy broken shape (pre-fix sessions): all per-question answers
 *    crammed into questions[0]'s key, joined by `\n`. Detect by `\n` in
 *    the single value and split back across the input's questions array.
 *
 * Returns undefined if there's nothing usable.
 */
function reconcileAskUserAnswers(
  answers: Record<string, string> | undefined,
  questions: Array<{ question?: string }> | undefined,
): Record<string, string> | undefined {
  if (!answers || typeof answers !== 'object') return undefined;
  const keys = Object.keys(answers);
  if (keys.length === 0) return undefined;

  // Legacy shape: one key, value contains newlines, and we have multiple questions.
  if (keys.length === 1 && questions && questions.length > 1) {
    const onlyValue = answers[keys[0]];
    if (typeof onlyValue === 'string' && onlyValue.includes('\n')) {
      const parts = onlyValue.split('\n');
      const unscrambled: Record<string, string> = {};
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]?.question;
        if (!q) continue;
        unscrambled[q] = parts[i] ?? '';
      }
      return unscrambled;
    }
  }
  return answers;
}

/** Extract readable text from tool_result content (string or array of blocks). */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join('\n');
  }
  return JSON.stringify(content);
}

// ============================================================================
// StreamCardBuilder — streaming session, emits CardEvents
// ============================================================================

export class StreamCardBuilder {
  private sessionId: string;
  private cwd: string;
  private seq = 0;
  private cards = new Map<CardId, Card>();
  /** tool_use_id → CardId, for pairing tool_result to ToolCallCard */
  private toolUseIdToCardId = new Map<string, CardId>();
  /** agentId (task_id) → CardId, for matching subagent updates */
  private agentIdToCardId = new Map<string, CardId>();
  /** Cards created for subagent permissions — removed after resolution. */
  private ephemeralCards = new Set<CardId>();
  /** Current streaming assistant_text card (for append_text events) */
  private currentTextCardId: CardId | null = null;
  /** JSONL file byte offset at the start of the current turn — history reads stop here. */
  private _jsonlCutoff: number | null = null;
  /** Token identifying an in-flight deferred clear. A later call (new turn, cancel)
   * replaces this token, causing the pending polling task to bail out. */
  private _pendingClearToken: symbol | null = null;

  constructor(sessionId: string, cwd: string) {
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  updateSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** Start a new turn: reset per-turn state, keep accumulated cards. */
  startNewTurn(): void {
    this.currentTextCardId = null;
  }

  /** Clear all accumulated cards. Call after a turn completes and JSONL is flushed. */
  clearCards(): void {
    this.cards.clear();
    this.toolUseIdToCardId.clear();
    this.agentIdToCardId.clear();
    this.ephemeralCards.clear();
    this.currentTextCardId = null;
  }

  /**
   * Append current in-memory cards to the persisted card history file.
   * Used by memory-mode providers (Codex) to survive reconnects.
   * Call before clearCards() at the end of each turn.
   */
  async persistCards(): Promise<void> {
    const cards = this.getCards();
    if (cards.length === 0) return;

    // Strip transient fields before persisting
    const cleaned = cards.map(c => {
      const { pendingInput, ...rest } = c;
      if (rest.type === 'assistant_text') {
        return { ...rest, streaming: false };
      }
      return rest;
    });

    const dir = getCardHistoryDir();
    const p = cardHistoryPath(this.sessionId);

    // Append to existing history
    let existing: Card[] = [];
    try {
      if (existsSync(p)) {
        const raw = await readFile(p, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existing = parsed;
      }
    } catch { /* start fresh */ }

    const merged = [...existing, ...cleaned];
    await mkdir(dir, { recursive: true });
    await writeFile(p, JSON.stringify(merged) + '\n');
  }

  /** Snapshot current JSONL byte size so history reads stop before the active turn. */
  async snapshotCutoff(): Promise<void> {
    const p = jsonlPath(this.sessionId, this.cwd);
    try {
      const { size } = await stat(p);
      this._jsonlCutoff = size;
    } catch {
      this._jsonlCutoff = null;
    }
  }

  /**
   * Wait for the JSONL file size to stop growing, then atomically clear in-memory
   * cards and re-snapshot the cutoff to the final size.
   *
   * Why: when the `result` message arrives from the CLI on stdout, the CLI may
   * not yet have flushed the turn's assistant messages to the session JSONL.
   * Clearing `streamingCards` immediately and pointing getCards at the (still
   * incomplete) JSONL produces a race window where getCards returns a snapshot
   * that's missing the last turn's messages.
   *
   * By deferring the clear until the file has stopped changing, getCards always
   * sees a consistent view: either JSONL (after flush) or in-memory cards (before).
   *
   * Cancel by calling `cancelDeferredClear()` — e.g. on hot resume when a new
   * turn starts before the file has stabilized.
   */
  async scheduleDeferredClear(opts?: { maxWaitMs?: number; stableMs?: number; pollMs?: number }): Promise<void> {
    const maxWaitMs = opts?.maxWaitMs ?? 3000;
    const stableMs = opts?.stableMs ?? 300;
    const pollMs = opts?.pollMs ?? 50;

    const token = Symbol('deferred-clear');
    this._pendingClearToken = token;
    const p = jsonlPath(this.sessionId, this.cwd);

    const getSize = async (): Promise<number> => {
      try { return (await stat(p)).size; } catch { return -1; }
    };

    let lastSize = await getSize();
    if (this._pendingClearToken !== token) return;

    let stableFor = 0;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs && stableFor < stableMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (this._pendingClearToken !== token) return;
      const size = await getSize();
      if (this._pendingClearToken !== token) return;
      if (size >= 0 && size === lastSize) {
        stableFor += pollMs;
      } else {
        stableFor = 0;
        lastSize = size;
      }
    }
    if (this._pendingClearToken !== token) return;
    this._pendingClearToken = null;
    this._jsonlCutoff = lastSize >= 0 ? lastSize : null;
    this.cards.clear();
    this.toolUseIdToCardId.clear();
    this.agentIdToCardId.clear();
    this.ephemeralCards.clear();
    this.currentTextCardId = null;
  }

  /** Cancel any pending deferred clear. Called on hot resume so the queued clear
   * doesn't wipe the next turn's cards once it completes. */
  cancelDeferredClear(): void {
    this._pendingClearToken = null;
  }

  get jsonlCutoff(): number | null {
    return this._jsonlCutoff;
  }

  set jsonlCutoff(value: number | null) {
    this._jsonlCutoff = value;
  }

  private nextId(): CardId {
    return `${this.sessionId}:${++this.seq}`;
  }

  private addEvent(card: Card, afterCardId?: CardId): CardAddEvent {
    this.cards.set(card.id, card);
    return { type: 'add', sessionId: this.sessionId, card, afterCardId };
  }

  private updateEvent(cardId: CardId, patch: Record<string, unknown>): CardUpdateEvent {
    const existing = this.cards.get(cardId);
    if (existing) {
      // Wire convention: `null` in a patch means "delete this key". JSON
      // strips `undefined`, so it can't survive the bus transport as a clear
      // signal — we use `null` as the sentinel and delete the key locally to
      // keep the server-side card shape consistent with what peers see.
      const bag = existing as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete bag[key];
        else bag[key] = value;
      }
    }
    return { type: 'update', sessionId: this.sessionId, cardId, patch };
  }

  private appendTextEvent(cardId: CardId, text: string): CardAppendTextEvent {
    const existing = this.cards.get(cardId);
    if (existing && 'text' in existing) {
      (existing as any).text += text;
    }
    return { type: 'append_text', sessionId: this.sessionId, cardId, text };
  }

  private removeEvent(cardId: CardId): CardRemoveEvent {
    this.cards.delete(cardId);
    return { type: 'remove', sessionId: this.sessionId, cardId };
  }

  // ── Public: produce CardEvents from SDK data ────────────────────────────

  userMessage(text: string, attachments?: readonly Attachment[]): CardEvent {
    this.currentTextCardId = null;
    // UserCard.attachments only carries metadata — bytes are fetched on
    // demand via `attachment:fetch`, not piped through every snapshot.
    const metadata: AttachmentMetadata[] | undefined = attachments && attachments.length > 0
      ? attachments.map((a) => ({
          id: a.id,
          kind: a.kind,
          mimeType: a.mimeType,
          name: a.name,
          size: a.size,
        }))
      : undefined;
    const card: Card = {
      type: 'user',
      id: this.nextId(),
      timestamp: Date.now(),
      text,
      ...(metadata ? { attachments: metadata } : {}),
    };
    return this.addEvent(card);
  }

  thinkingBlock(text: string): CardEvent {
    this.currentTextCardId = null;
    const card: Card = { type: 'thinking', id: this.nextId(), timestamp: Date.now(), text };
    return this.addEvent(card);
  }

  /**
   * Append text to current assistant_text card, or create a new one.
   * Returns append_text event (hot path) or add event (new card).
   */
  assistantText(text: string): CardEvent {
    if (this.currentTextCardId) {
      return this.appendTextEvent(this.currentTextCardId, text);
    }
    const id = this.nextId();
    const card: Card = { type: 'assistant_text', id, timestamp: Date.now(), text, streaming: true };
    this.currentTextCardId = id;
    return this.addEvent(card);
  }

  /** Mark the current assistant_text card as done streaming. */
  finalizeAssistantText(): CardEvent | null {
    if (!this.currentTextCardId) return null;
    const id = this.currentTextCardId;
    this.currentTextCardId = null;
    return this.updateEvent(id, { streaming: false });
  }

  /**
   * Handle tool_use block from SDK stream.
   * If the card was already pre-created via `toolCallFromPermission()`, confirm it.
   * Otherwise create a new ToolCallCard.
   */
  toolUse(toolName: string, toolInput: Record<string, unknown>, toolUseId: string): CardEvent {
    this.currentTextCardId = null;

    // Check if card was pre-created from canUseTool
    const existingCardId = this.toolUseIdToCardId.get(toolUseId);
    if (existingCardId) {
      // Confirm with real data (input may differ if updatedInput was returned)
      return this.updateEvent(existingCardId, { toolInput });
    }

    const id = this.nextId();
    const card: ToolCallCard = {
      type: 'tool_call', id, timestamp: Date.now(),
      toolName, toolInput, toolUseId,
    };
    this.toolUseIdToCardId.set(toolUseId, id);
    return this.addEvent(card);
  }

  /**
   * Pre-create a ToolCallCard from canUseTool (fires before tool_use stream event).
   * This eliminates the synthetic message hack.
   */
  toolCallFromPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    pendingInput: PendingInputAttachment,
    /** Ephemeral cards are removed after permission is resolved (subagent permissions). */
    ephemeral = false,
  ): CardEvent {
    this.currentTextCardId = null;

    // If the card was already created by the assistant message's tool_use block
    // (which arrives in the stream BEFORE canUseTool fires), update it with pendingInput.
    const existingCardId = this.toolUseIdToCardId.get(toolUseId);
    if (existingCardId) {
      if (ephemeral) this.ephemeralCards.add(existingCardId);
      return this.updateEvent(existingCardId, { pendingInput });
    }

    const id = this.nextId();
    const card: ToolCallCard = {
      type: 'tool_call', id, timestamp: Date.now(),
      toolName, toolInput, toolUseId, pendingInput,
    };
    this.toolUseIdToCardId.set(toolUseId, id);
    if (ephemeral) this.ephemeralCards.add(id);
    return this.addEvent(card);
  }

  /** Attach a pending input to a subagent card (subagent permission). */
  attachPendingToSubagent(agentId: string, pendingInput: PendingInputAttachment): CardEvent | null {
    const cardId = this.agentIdToCardId.get(agentId);
    if (!cardId) return null;
    return this.updateEvent(cardId, { pendingInput });
  }

  /** Clear pending input from a card. Ephemeral cards are removed entirely. */
  clearPendingInput(requestId: string): CardEvent | null {
    for (const [, card] of this.cards) {
      if (card.pendingInput?.requestId === requestId) {
        if (this.ephemeralCards.has(card.id)) {
          this.ephemeralCards.delete(card.id);
          return this.removeEvent(card.id);
        }
        // `null` signals "clear" — JSON drops `undefined` so it can't cross
        // the bus. See updateEvent() for the wire convention.
        return this.updateEvent(card.id, { pendingInput: null });
      }
    }
    return null;
  }

  /** Find the card ID for a given requestId. */
  findCardByRequestId(requestId: string): CardId | undefined {
    for (const [, card] of this.cards) {
      if (card.pendingInput?.requestId === requestId) return card.id;
    }
    return undefined;
  }

  /** Check if a tool card already exists for the given tool_use_id. */
  hasToolCard(toolUseId: string): boolean {
    return this.toolUseIdToCardId.has(toolUseId);
  }

  /** Return all live cards (insertion order). Cards carry pendingInput if set. */
  getCards(): Card[] {
    return Array.from(this.cards.values());
  }

  toolResult(toolUseId: string, content: string, isError: boolean): CardEvent | null {
    const cardId = this.toolUseIdToCardId.get(toolUseId);
    if (!cardId) return null;
    const truncated = content.length > TOOL_RESULT_TRUNCATE_LENGTH;
    const resultContent = truncated
      ? content.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]'
      : content;
    return this.updateEvent(cardId, {
      result: { content: resultContent, isError, truncated },
    });
  }

  /** Attach AskUserQuestion answers to the matching ToolCallCard. */
  setToolAnswers(toolUseId: string, answers: Record<string, string>): CardEvent | null {
    const cardId = this.toolUseIdToCardId.get(toolUseId);
    if (!cardId) return null;
    return this.updateEvent(cardId, { answers });
  }

  subagentStart(description: string, agentId: string, toolUseId?: string): CardEvent {
    this.currentTextCardId = null;
    const id = this.nextId();
    const card: SubagentCard = {
      type: 'subagent', id, timestamp: Date.now(),
      description,
      toolUseId: toolUseId ?? agentId,
      agentId,
      status: 'running',
      toolUseCount: 0,
    };
    this.agentIdToCardId.set(agentId, id);
    // Position after the parent ToolCallCard if we have the toolUseId
    const afterCardId = toolUseId ? this.toolUseIdToCardId.get(toolUseId) : undefined;
    return this.addEvent(card, afterCardId);
  }

  subagentProgress(agentId: string, toolUseId: string | undefined, toolUseCount?: number, lastToolName?: string): CardEvent | null {
    const cardId = this.agentIdToCardId.get(agentId)
      ?? (toolUseId ? this.agentIdToCardId.get(toolUseId) : undefined);
    if (!cardId) return null;
    const patch: Record<string, unknown> = {};
    if (toolUseCount !== undefined) patch.toolUseCount = toolUseCount;
    if (lastToolName !== undefined) patch.lastToolName = lastToolName;
    return this.updateEvent(cardId, patch);
  }

  subagentEnd(
    agentId: string,
    toolUseId: string | undefined,
    status: 'completed' | 'failed' | 'stopped',
    summary?: string,
  ): CardEvent | null {
    const cardId = this.agentIdToCardId.get(agentId)
      ?? (toolUseId ? this.agentIdToCardId.get(toolUseId) : undefined);
    if (!cardId) return null;
    return this.updateEvent(cardId, { status, summary });
  }

  systemMessage(text: string, subtype?: 'compacted' | 'cost' | 'error' | 'info' | 'warning'): CardEvent {
    const card: Card = { type: 'system', id: this.nextId(), timestamp: Date.now(), text, subtype };
    return this.addEvent(card);
  }

  recoverySuggested(reason: string, action: 'compact', label: string): CardEvent {
    const card: Card = {
      type: 'recovery_suggested',
      id: this.nextId(),
      timestamp: Date.now(),
      reason,
      action,
      label,
    };
    return this.addEvent(card);
  }

  errorMessage(text: string): CardEvent {
    return this.systemMessage(`Error: ${text}`, 'error');
  }
}

// ============================================================================
// buildCardsFromHistory — convert JSONL history into Card[]
// ============================================================================

export async function buildCardsFromHistory(
  sessionId: string,
  cwd: string,
  offset = 0,
  limit = 50,
  cutoffBytes?: number,
): Promise<CardHistoryResponse> {
  const p = jsonlPath(sessionId, cwd);
  if (!existsSync(p)) return { cards: [], total: 0, hasMore: false };

  let allMessages: any[];
  let total: number;

  if (cutoffBytes != null) {
    // Active turn: read head of file up to the snapshot byte offset.
    allMessages = (await readMessagesFromJSONL(sessionId, cwd, { headBytes: cutoffBytes }))
      .filter((m: any) => !m.isSidechain);
    total = allMessages.length;
  } else {
    const { size: fileSize } = await stat(p);
    // Estimate: (offset + limit) messages × 3 margin × ~4 KB each
    const tailBytes = (offset + limit) * 3 * 4096;

    if (tailBytes < fileSize) {
      // Large file: streaming count for stable total + tail read for cards
      const [counted, tailMsgs] = await Promise.all([
        countMessagesInJSONL(p),
        readMessagesFromJSONL(sessionId, cwd, { tailBytes }),
      ]);
      const filtered = tailMsgs.filter((m: any) => !m.isSidechain);
      total = counted;

      if (filtered.length >= offset + limit) {
        allMessages = filtered;
      } else {
        // Tail wasn't enough — fall back to full read
        allMessages = (await readMessagesFromJSONL(sessionId, cwd))
          .filter((m: any) => !m.isSidechain);
        total = allMessages.length;
      }
    } else {
      // Small file: read whole thing
      allMessages = (await readMessagesFromJSONL(sessionId, cwd))
        .filter((m: any) => !m.isSidechain);
      total = allMessages.length;
    }
  }

  // allMessages may be a tail subset — map page positions to local indices.
  // Page wants global positions [total-offset-limit, total-offset].
  // allMessages holds the last `allMessages.length` messages of the file.
  const pageStart = Math.max(0, allMessages.length - offset - limit);
  const pageEnd = Math.max(0, allMessages.length - offset);
  const sliced = allMessages.slice(pageStart, pageEnd);

  // ── Pass 1: Build indexes from ALL messages ────────────────────────────

  // toolUseId → toolName (for tool_result lookup across pages)
  const agentToolUseIds = new Set<string>();
  // toolUseId → tool_result data (for pairing)
  const toolResults = new Map<string, { content: string; isError: boolean }>();
  // toolUseId → AskUserQuestion structured result (questions + answers).
  // The Claude CLI stores this as `toolUseResult` at the message envelope
  // level, separate from the human-readable tool_result.content string.
  const askUserResults = new Map<string, { questions?: any[]; answers?: Record<string, string> }>();

  for (const msg of allMessages) {
    const rawMsg = (msg as any).message as any;
    const toolUseResult = (msg as any).toolUseResult;
    if (!Array.isArray(rawMsg?.content)) continue;
    for (const block of rawMsg.content) {
      if (block.type === 'tool_use' && block.name === 'Agent' && block.id) {
        agentToolUseIds.add(block.id);
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        const text = extractToolResultText(block.content);
        toolResults.set(block.tool_use_id, { content: text, isError: !!block.is_error });
        if (toolUseResult && typeof toolUseResult === 'object' && 'answers' in toolUseResult) {
          askUserResults.set(block.tool_use_id, {
            questions: Array.isArray(toolUseResult.questions) ? toolUseResult.questions : undefined,
            answers: typeof toolUseResult.answers === 'object' ? toolUseResult.answers : undefined,
          });
        }
      }
    }
  }

  // ── Get real agentIds from SDK listSubagents ───────────────────────────
  // System messages (task_started) are NOT reliably present in the JSONL.
  // Instead, read subagent meta.json files and match by description to the
  // Agent tool_use input.description.

  // Build description → toolUseId map from Agent tool_use blocks
  const descToToolUseId = new Map<string, string>();
  for (const msg of allMessages) {
    const rawMsg = (msg as any).message as any;
    if (!Array.isArray(rawMsg?.content)) continue;
    for (const block of rawMsg.content) {
      if (block.type === 'tool_use' && block.name === 'Agent' && block.id) {
        const desc = (block.input as any)?.description ?? '';
        if (desc) descToToolUseId.set(desc, block.id);
      }
    }
  }

  const toolUseIdToAgentId = new Map<string, string>();
  try {
    const agentIds = await listSubagentIdsFromDisk(sessionId, cwd);
    const subagentsDir = join(claudeProjectDir(cwd), sessionId, 'subagents');

    for (const agentId of agentIds) {
      try {
        const meta = JSON.parse(await readFile(join(subagentsDir, `${agentId}.meta.json`), 'utf-8'));
        if (meta?.description && descToToolUseId.has(meta.description)) {
          toolUseIdToAgentId.set(descToToolUseId.get(meta.description)!, agentId);
        }
      } catch { /* skip this agent */ }
    }
    // Fallback for any unmatched Agent tool_use IDs
    for (const toolUseId of agentToolUseIds) {
      if (!toolUseIdToAgentId.has(toolUseId)) {
        toolUseIdToAgentId.set(toolUseId, toolUseId);
      }
    }
  } catch {
    // No subagents or SDK error — fallback: agentId = toolUseId
    for (const toolUseId of agentToolUseIds) {
      toolUseIdToAgentId.set(toolUseId, toolUseId);
    }
  }

  // ── Load persisted attachment metas + turn manifest so we can rebind
  //    synthetic `replay:N` ids in user blocks back to the real upload UUIDs
  //    the PWA needs for `attachment:fetch`. Manifest gives an exact-UUID
  //    match per turn (preferred); the fuzzy `(kind, size, name)` resolver is
  //    the fallback for sessions whose attachments predate the manifest.
  const [persistedMetas, turnManifest] = await Promise.all([
    listSessionAttachments(sessionId).catch(() => [] as PersistedMeta[]),
    readTurnManifest(sessionId).catch(() => [] as { ids: string[] }[]),
  ]);
  const metaById = new Map<string, PersistedMeta>();
  for (const m of persistedMetas) metaById.set(m.id, m);
  const resolveAttachment = makeAttachmentResolver(persistedMetas);
  let attachmentTurnCursor = 0;

  // ── Pass 2: Build Cards from sliced messages ───────────────────────────

  let seq = Math.max(0, total - offset - limit);
  const nextId = () => `${sessionId}:h:${++seq}`;
  const cards: Card[] = [];

  for (const msg of sliced) {
    // ── System messages ──
    if (msg.type === 'system') {
      const subtype = (msg as any).subtype;
      // Skip subagent lifecycle events (handled via subagentCards below)
      if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification') continue;
      // Skip init and status messages (not useful in history)
      if (subtype === 'init' || subtype === 'status' || subtype === 'session_state_changed') continue;

      if (subtype === 'compact_boundary') {
        cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: 'Context compacted', subtype: 'compacted' });
      } else {
        // Unknown system subtype — show as info
        cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: subtype ?? 'System event', subtype: 'info' });
      }
      continue;
    }

    const rawMessage = (msg as any).message as any;
    if (!rawMessage?.content) {
      // Empty message — skip
      continue;
    }

    // ── User messages ──
    if (msg.type === 'user') {
      if (typeof rawMessage.content === 'string') {
        cards.push({ type: 'user', id: nextId(), timestamp: Date.now(), text: rawMessage.content });
        continue;
      }
      if (Array.isArray(rawMessage.content)) {
        // A user turn that came in with attachments is one logical card with
        // image/document/text blocks in some order. We collapse all text
        // blocks into a single `text` field and reconstruct AttachmentMetadata
        // records from image/document blocks (no bytes — those live in the
        // attachmentStore on disk and are fetched on demand). Pure text-only
        // turns still produce one card per text block (back-compat).
        //
        // Replayed attachment ids do NOT round-trip through JSONL. We
        // recover the original upload UUIDs by matching each block against
        // the persisted-meta pool by `(kind, decoded byte size [, name])`;
        // an unmatched block falls back to a synthetic `replay:<n>` id and
        // its chip will render as "Unavailable" (bytes lost or not yet
        // persistent).
        const attachments: AttachmentMetadata[] = [];
        const textParts: string[] = [];
        let hasNonTextBlock = false;

        // Pre-scan the block array for attachment blocks so we know whether
        // to consume a manifest entry for this turn (an attachment-bearing
        // user turn contributes exactly one manifest line, in send order).
        const turnHasAttachment = rawMessage.content.some((b: any) =>
          (b?.type === 'image' && b.source?.type === 'base64') ||
          (b?.type === 'document' && b.source?.type === 'base64' && b.source.media_type === 'application/pdf'),
        );
        const turnEntry = turnHasAttachment ? turnManifest[attachmentTurnCursor] : undefined;
        if (turnHasAttachment) attachmentTurnCursor++;
        let manifestIdx = 0;

        for (const block of rawMessage.content) {
          if (block?.type === 'image' && block.source?.type === 'base64') {
            hasNonTextBlock = true;
            const size = decodedBase64Bytes(block.source.data);
            const mimeType = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png';
            const manifestId = turnEntry?.ids[manifestIdx++];
            const exact = manifestId ? metaById.get(manifestId) : undefined;
            const matched = exact && exact.kind === 'image' && exact.size === size
              ? exact
              : resolveAttachment('image', size);
            attachments.push(matched
              ? { id: matched.id, kind: matched.kind, mimeType: matched.mimeType, name: matched.name, size: matched.size }
              : { id: `replay:${nextId()}`, kind: 'image', mimeType, name: 'attachment', size });
          } else if (block?.type === 'document' && block.source?.type === 'base64' && block.source.media_type === 'application/pdf') {
            hasNonTextBlock = true;
            const size = decodedBase64Bytes(block.source.data);
            const name = typeof block.title === 'string' && block.title.length > 0 ? block.title : 'document.pdf';
            const manifestId = turnEntry?.ids[manifestIdx++];
            const exact = manifestId ? metaById.get(manifestId) : undefined;
            const matched = exact && exact.kind === 'pdf' && exact.size === size
              ? exact
              : resolveAttachment('pdf', size, name);
            attachments.push(matched
              ? { id: matched.id, kind: matched.kind, mimeType: matched.mimeType, name: matched.name, size: matched.size }
              : { id: `replay:${nextId()}`, kind: 'pdf', mimeType: 'application/pdf', name, size });
          } else if (block?.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
          // tool_result blocks are paired into ToolCallCard.result (handled below)
          // Skip them here — they don't need separate cards.
        }

        if (hasNonTextBlock) {
          const card: Card = {
            type: 'user',
            id: nextId(),
            timestamp: Date.now(),
            text: textParts.join('\n'),
            ...(attachments.length > 0 ? { attachments } : {}),
          };
          cards.push(card);
        } else {
          // No image/pdf — fall back to one card per text block, preserving
          // the older multi-card behavior for plain user turns (e.g. when a
          // tool_result block is present alongside a text block, and only
          // the text block makes a user card).
          for (const block of rawMessage.content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              cards.push({ type: 'user', id: nextId(), timestamp: Date.now(), text: block.text });
            }
          }
        }
        continue;
      }
      continue;
    }

    // ── Assistant messages ──
    if (msg.type === 'assistant') {
      const blocks = rawMessage.content;
      if (!Array.isArray(blocks)) continue;

      for (const block of blocks) {
        switch (block.type) {
          case 'text':
            if (block.text) {
              cards.push({ type: 'assistant_text', id: nextId(), timestamp: Date.now(), text: block.text });
            }
            break;

          case 'thinking':
            if (block.thinking) {
              cards.push({ type: 'thinking', id: nextId(), timestamp: Date.now(), text: block.thinking });
            }
            break;

          case 'redacted_thinking':
            cards.push({ type: 'thinking', id: nextId(), timestamp: Date.now(), text: '[Redacted thinking]' });
            break;

          case 'tool_use': {
            if (agentToolUseIds.has(block.id)) {
              // Agent tool_use → create a ToolCallCard as anchor, then SubagentCard
              const agentId = toolUseIdToAgentId.get(block.id) ?? block.id;
              const result = toolResults.get(block.id);
              const description = (block.input as any)?.description ?? '';
              const summary = result ? result.content.slice(0, 200) : undefined;

              // Insert SubagentCard
              const subagentCard: SubagentCard = {
                type: 'subagent',
                id: nextId(),
                timestamp: Date.now(),
                description,
                toolUseId: block.id,
                agentId,
                status: result ? 'completed' : 'running',
                summary,
                toolUseCount: 0,
              };
              cards.push(subagentCard);
            } else {
              // Normal tool call
              const toolInput = typeof block.input === 'object' && block.input !== null
                ? block.input
                : {};
              const result = toolResults.get(block.id);
              let pairedResult: ToolCallCard['result'] | undefined;
              if (result) {
                const truncated = result.content.length > TOOL_RESULT_TRUNCATE_LENGTH;
                pairedResult = {
                  content: truncated
                    ? result.content.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]'
                    : result.content,
                  isError: result.isError,
                  truncated,
                };
              }
              let answers: Record<string, string> | undefined;
              if (block.name === 'AskUserQuestion') {
                const rec = askUserResults.get(block.id);
                const inputQuestions = Array.isArray((block.input as any)?.questions)
                  ? (block.input as any).questions
                  : undefined;
                answers = reconcileAskUserAnswers(rec?.answers, inputQuestions ?? rec?.questions);
              }
              cards.push({
                type: 'tool_call',
                id: nextId(),
                timestamp: Date.now(),
                toolName: block.name,
                toolInput,
                toolUseId: block.id,
                result: pairedResult,
                ...(answers ? { answers } : {}),
              });
            }
            break;
          }

          // Server tool blocks — show as generic tool calls
          case 'server_tool_use':
          case 'mcp_tool_use': {
            const toolInput = typeof block.input === 'object' && block.input !== null
              ? block.input
              : {};
            const result = block.id ? toolResults.get(block.id) : undefined;
            let pairedResult: ToolCallCard['result'] | undefined;
            if (result) {
              const truncated = result.content.length > TOOL_RESULT_TRUNCATE_LENGTH;
              pairedResult = {
                content: truncated
                  ? result.content.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]'
                  : result.content,
                isError: result.isError,
                truncated,
              };
            }
            cards.push({
              type: 'tool_call',
              id: nextId(),
              timestamp: Date.now(),
              toolName: block.name ?? block.type,
              toolInput,
              toolUseId: block.id ?? nextId(),
              result: pairedResult,
            });
            break;
          }

          // Server/MCP tool results — show as system info
          case 'web_search_tool_result':
          case 'web_fetch_tool_result':
          case 'mcp_tool_result':
          case 'code_execution_tool_result':
          case 'bash_code_execution_tool_result':
          case 'text_editor_code_execution_tool_result':
          case 'tool_search_tool_result': {
            const resultText = extractToolResultText(block.content ?? block.text ?? '');
            const parentToolUseId = block.tool_use_id;
            // Try to pair with a previously emitted tool_call card
            if (parentToolUseId) {
              const parentCard = cards.find(
                (c): c is ToolCallCard => c.type === 'tool_call' && (c as ToolCallCard).toolUseId === parentToolUseId
              );
              if (parentCard && !parentCard.result) {
                const truncated = resultText.length > TOOL_RESULT_TRUNCATE_LENGTH;
                parentCard.result = {
                  content: truncated ? resultText.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]' : resultText,
                  isError: !!block.is_error,
                  truncated,
                };
                break;
              }
            }
            // Fallback: show as system info
            if (resultText) {
              cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: `${block.type}: ${resultText.slice(0, 200)}`, subtype: 'info' });
            }
            break;
          }

          case 'container_upload':
            cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: 'Container upload', subtype: 'info' });
            break;

          // Unknown block types — surface as info card so they're visible
          default: {
            const preview = block.text ?? block.content ?? '';
            const previewStr = typeof preview === 'string' ? preview.slice(0, 200) : JSON.stringify(preview).slice(0, 200);
            if (block.type && previewStr) {
              cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: `[${block.type}] ${previewStr}`, subtype: 'info' });
            }
            break;
          }
        }
      }
    }
  }

  return {
    cards,
    total,
    hasMore: total - offset - limit > 0,
  };
}
