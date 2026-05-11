// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { realpathSync } from 'fs';
import { basename } from 'path';
import type {
  TerminalSummary,
  TerminalOutputChunk,
  TerminalsUpdate,
} from '@sumicom/quicksave-shared';
import {
  TerminalManager,
  getTerminalManager,
  _resetTerminalManagerForTest,
} from './terminalManager.js';

const SHELL = '/bin/sh';
const TEST_TIMEOUT = 10_000;
const REAL_TMPDIR = realpathSync(tmpdir());

// node-pty's posix_spawnp can fail in sandboxed/temp worktree environments
// (e.g. pre-push hook clean worktree). Detect early and skip PTY-dependent tests.
let ptyAvailable = true;
try {
  const pty = await import('node-pty');
  const probe = pty.spawn(SHELL, ['-c', 'true'], { cols: 10, rows: 10, cwd: REAL_TMPDIR });
  probe.kill();
} catch {
  ptyAvailable = false;
}
const itPty = ptyAvailable ? it : it.skip;

/**
 * Wait until the manager has emitted an output chunk whose `chunk` matches the
 * given predicate for `terminalId`. Resolves with the chunk. Rejects after
 * `timeoutMs` with the chunks observed so far (for easier debugging).
 */
function waitForOutput(
  mgr: TerminalManager,
  terminalId: string,
  predicate: (chunk: TerminalOutputChunk) => boolean,
  timeoutMs = 8_000,
): Promise<TerminalOutputChunk> {
  return new Promise((resolve, reject) => {
    const seen: TerminalOutputChunk[] = [];
    const handler = (chunk: TerminalOutputChunk) => {
      if (chunk.terminalId !== terminalId) return;
      seen.push(chunk);
      if (predicate(chunk)) {
        mgr.off('output', handler);
        clearTimeout(timer);
        resolve(chunk);
      }
    };
    const timer = setTimeout(() => {
      mgr.off('output', handler);
      reject(
        new Error(
          `waitForOutput timed out after ${timeoutMs}ms; saw ${seen.length} chunks: ` +
            JSON.stringify(seen.map((c) => c.chunk)),
        ),
      );
    }, timeoutMs);
    mgr.on('output', handler);
  });
}

describe('TerminalManager', () => {
  let mgr: TerminalManager;

  beforeEach(() => {
    _resetTerminalManagerForTest();
    mgr = getTerminalManager();
  });

  afterEach(() => {
    // Clean up any terminals the test created — prevents PTY leaks across tests.
    try {
      mgr.shutdown();
    } catch {
      /* best effort */
    }
    _resetTerminalManagerForTest();
  });

  itPty(
    'create() returns a summary with requested cwd/cols/rows and defaults title to basename(shell)',
    async () => {
      const summary = await mgr.create({
        cwd: tmpdir(),
        shell: SHELL,
        cols: 100,
        rows: 30,
      });

      expect(summary.terminalId).toMatch(/^term_[0-9a-f]+$/);
      expect(summary.cwd).toBe(tmpdir());
      expect(summary.shell).toBe(SHELL);
      expect(summary.cols).toBe(100);
      expect(summary.rows).toBe(30);
      expect(summary.title).toBe(basename(SHELL));
      expect(summary.exited).toBe(false);
      expect(summary.exitCode).toBeNull();
      expect(typeof summary.createdAt).toBe('number');
      expect(typeof summary.lastActivityAt).toBe('number');
    },
    TEST_TIMEOUT,
  );

  itPty(
    'listSummaries() includes created terminal and emits terminals-updated upsert',
    async () => {
      const events: TerminalsUpdate[] = [];
      mgr.on('terminals-updated', (u: TerminalsUpdate) => events.push(u));

      const summary = await mgr.create({ cwd: tmpdir(), shell: SHELL });

      const list = mgr.listSummaries();
      expect(list.map((s) => s.terminalId)).toContain(summary.terminalId);

      // An upsert for this terminal must have been emitted during create().
      const upsertForThis = events.find(
        (e): e is Extract<TerminalsUpdate, { kind: 'upsert' }> =>
          e.kind === 'upsert' && e.terminal.terminalId === summary.terminalId,
      );
      expect(upsertForThis).toBeDefined();
      expect(upsertForThis!.terminal.shell).toBe(SHELL);
    },
    TEST_TIMEOUT,
  );

  itPty(
    'write() delivers input and surfaces output via event + snapshot; seq is monotonically increasing',
    async () => {
      const summary = await mgr.create({
        cwd: tmpdir(),
        shell: SHELL,
        cols: 80,
        rows: 24,
      });

      const chunks: TerminalOutputChunk[] = [];
      mgr.on('output', (c: TerminalOutputChunk) => {
        if (c.terminalId === summary.terminalId) chunks.push(c);
      });

      const gotHello = waitForOutput(mgr, summary.terminalId, (c) =>
        c.chunk.includes('hello'),
      );

      mgr.write(summary.terminalId, 'echo hello\n');

      const matched = await gotHello;
      expect(matched.chunk).toContain('hello');

      // Snapshot contains hello somewhere in the buffer.
      const snap = mgr.outputSnapshot(summary.terminalId);
      expect(snap).not.toBeNull();
      expect(snap!.buffer).toContain('hello');
      expect(snap!.seq).toBeGreaterThanOrEqual(matched.seq);
      expect(snap!.cols).toBe(80);
      expect(snap!.rows).toBe(24);
      expect(snap!.exited).toBe(false);

      // Sequence numbers are strictly non-decreasing and at least one
      // strictly-increasing step exists (the impl advances by chunk length).
      expect(chunks.length).toBeGreaterThan(0);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].seq).toBeGreaterThan(chunks[i - 1].seq);
      }
    },
    TEST_TIMEOUT,
  );

  itPty(
    'resize() updates cols/rows on the summary and emits terminal-updated',
    async () => {
      const summary = await mgr.create({
        cwd: tmpdir(),
        shell: SHELL,
        cols: 80,
        rows: 24,
      });

      const updates: TerminalSummary[] = [];
      mgr.on('terminal-updated', (s: TerminalSummary) => {
        if (s.terminalId === summary.terminalId) updates.push(s);
      });

      const out = mgr.resize(summary.terminalId, 120, 40);
      expect(out.cols).toBe(120);
      expect(out.rows).toBe(40);

      // Snapshot agrees.
      const snap = mgr.outputSnapshot(summary.terminalId);
      expect(snap?.cols).toBe(120);
      expect(snap?.rows).toBe(40);

      // At least one terminal-updated fired for this resize with the new dims.
      await vi.waitFor(
        () => {
          const hit = updates.find((u) => u.cols === 120 && u.rows === 40);
          expect(hit).toBeDefined();
        },
        { timeout: 2_000 },
      );
    },
    TEST_TIMEOUT,
  );

  itPty(
    'rename() trims whitespace, falls back to basename on empty, and caps at 80 chars',
    async () => {
      const summary = await mgr.create({ cwd: tmpdir(), shell: SHELL });

      // Trim whitespace.
      const trimmed = mgr.rename(summary.terminalId, '   my cool tab   ');
      expect(trimmed.title).toBe('my cool tab');

      // Empty-after-trim falls back to basename(shell).
      const emptied = mgr.rename(summary.terminalId, '   ');
      expect(emptied.title).toBe(basename(SHELL));

      // Over-long titles truncated to 80 chars.
      const longTitle = 'x'.repeat(200);
      const capped = mgr.rename(summary.terminalId, longTitle);
      expect(capped.title.length).toBe(80);
      expect(capped.title).toBe('x'.repeat(80));
    },
    TEST_TIMEOUT,
  );

  itPty(
    'rename() emits terminal-updated with the new title',
    async () => {
      const summary = await mgr.create({ cwd: tmpdir(), shell: SHELL });

      const seen: TerminalSummary[] = [];
      mgr.on('terminal-updated', (s: TerminalSummary) => {
        if (s.terminalId === summary.terminalId) seen.push(s);
      });

      mgr.rename(summary.terminalId, 'renamed-tab');

      await vi.waitFor(
        () => {
          const hit = seen.find((s) => s.title === 'renamed-tab');
          expect(hit).toBeDefined();
        },
        { timeout: 2_000 },
      );
    },
    TEST_TIMEOUT,
  );

  itPty(
    'close() removes the terminal and emits terminals-updated { kind: "remove" }',
    async () => {
      const summary = await mgr.create({ cwd: tmpdir(), shell: SHELL });

      const removeEvents: TerminalsUpdate[] = [];
      mgr.on('terminals-updated', (u: TerminalsUpdate) => {
        if (u.kind === 'remove' && u.terminalId === summary.terminalId) {
          removeEvents.push(u);
        }
      });

      mgr.close(summary.terminalId);

      // Gone from the list.
      const list = mgr.listSummaries();
      expect(list.map((s) => s.terminalId)).not.toContain(summary.terminalId);

      // Snapshot is null for unknown id.
      expect(mgr.outputSnapshot(summary.terminalId)).toBeNull();

      await vi.waitFor(
        () => {
          expect(removeEvents.length).toBeGreaterThan(0);
        },
        { timeout: 2_000 },
      );
    },
    TEST_TIMEOUT,
  );

  itPty(
    'write() throws for unknown terminals and for terminals that have been closed',
    async () => {
      // Unknown id.
      expect(() => mgr.write('term_doesnotexist', 'x')).toThrow(/Unknown terminal/);

      const summary = await mgr.create({ cwd: tmpdir(), shell: SHELL });
      mgr.close(summary.terminalId);
      // After close, the entry is removed from the map entirely, so the
      // "Unknown terminal" branch fires (not the "has exited" branch).
      expect(() => mgr.write(summary.terminalId, 'x')).toThrow(/Unknown terminal/);
    },
    TEST_TIMEOUT,
  );

  itPty(
    'shell exiting naturally emits an output chunk with exited: true and updates the summary',
    async () => {
      const summary = await mgr.create({ cwd: tmpdir(), shell: SHELL });

      const exitChunkPromise = waitForOutput(
        mgr,
        summary.terminalId,
        (c) => c.exited === true,
      );

      mgr.write(summary.terminalId, 'exit\n');

      const exitChunk = await exitChunkPromise;
      expect(exitChunk.exited).toBe(true);
      // exitCode may be a number or null depending on how node-pty surfaces
      // the exit, but the field must be present on the chunk.
      expect(exitChunk).toHaveProperty('exitCode');

      // Summary / snapshot reflect the exit.
      await vi.waitFor(
        () => {
          const snap = mgr.outputSnapshot(summary.terminalId);
          expect(snap).not.toBeNull();
          expect(snap!.exited).toBe(true);
        },
        { timeout: 4_000 },
      );

      const listed = mgr
        .listSummaries()
        .find((s) => s.terminalId === summary.terminalId);
      expect(listed?.exited).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it('getTerminalManager() returns a singleton; _resetTerminalManagerForTest() swaps it', () => {
    const a = getTerminalManager();
    const b = getTerminalManager();
    expect(a).toBe(b);

    _resetTerminalManagerForTest();
    const c = getTerminalManager();
    expect(c).not.toBe(a);
  });
});
