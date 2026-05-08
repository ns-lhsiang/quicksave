// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (before importing module under test) ──
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('./claudeCliProvider.js', () => ({
  getClaudeBin: vi.fn(() => '/mock/bin/claude'),
}));

const { spawn } = await import('child_process');
const { CommitSummaryCliService, CommitSummaryCliError, __testing } = await import('./commitSummaryCli.js');

// ── Fake ChildProcess helper ──

interface FakeChildOpts {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorOnSpawn?: NodeJS.ErrnoException;
  delayMs?: number;
}

function makeFakeChild(opts: FakeChildOpts = {}) {
  const emitter = new EventEmitter() as any;
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = vi.fn();
  emitter.killed = false;

  if (opts.errorOnSpawn) {
    setImmediate(() => emitter.emit('error', opts.errorOnSpawn));
    return emitter;
  }

  const fire = () => {
    if (opts.stdout) emitter.stdout.emit('data', Buffer.from(opts.stdout, 'utf8'));
    if (opts.stderr) emitter.stderr.emit('data', Buffer.from(opts.stderr, 'utf8'));
    emitter.emit('close', opts.exitCode ?? 0);
  };

  if (opts.delayMs !== undefined) {
    // Never fire close — used for timeout test.
  } else {
    setImmediate(fire);
  }

  return emitter;
}

function makeEnvelope(overrides: Partial<Record<string, unknown>> = {}): string {
  // The CLI emits stream-json: one JSON event per line terminated by \n.
  // The final `type: 'result'` envelope carries the full payload.
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '{"summary":"feat: add foo","description":"bar"}',
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  }) + '\n';
}

// ── Tests ──

describe('CommitSummaryCliService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateSummary — happy paths', () => {
    it('parses bare JSON result', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('feat: add foo');
      expect(out.description).toBe('bar');
    });

    it('parses result wrapped in markdown fences', async () => {
      const fenced = '```json\n{"summary":"fix: y","description":"z"}\n```';
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: fenced }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('fix: y');
    });

    it('extracts trailing JSON when prefixed with chatter', async () => {
      const mixed = 'Here you go:\n\n{"summary":"chore: tidy"}';
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: mixed }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('chore: tidy');
      expect(out.description).toBeUndefined();
    });

    it('extracts JSON when chatter follows it', async () => {
      const mixed = '{"summary":"fix: edge","description":"covers the empty case"}\n\nLet me know if you want changes.';
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: mixed }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('fix: edge');
      expect(out.description).toBe('covers the empty case');
    });

    it('extracts fenced JSON sandwiched between preamble and trailing prose', async () => {
      const mixed = [
        'Here is the message:',
        '',
        '```json',
        '{"summary":"feat: ship it","description":"because reasons"}',
        '```',
        '',
        'Hope this helps!',
      ].join('\n');
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: mixed }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('feat: ship it');
      expect(out.description).toBe('because reasons');
    });

    it('prefers the trailing JSON when an example block appears earlier', async () => {
      const mixed = [
        'For reference, the format is:',
        '{"summary": "example", "description": "this is an example"}',
        '',
        'And here is the real one:',
        '{"summary":"refactor: split modules","description":"untangle deps"}',
      ].join('\n');
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: mixed }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('refactor: split modules');
      expect(out.description).toBe('untangle deps');
    });

    it('handles JSON whose description contains a literal `}` inside a string', async () => {
      const tricky = '{"summary":"fix: braces","description":"interface{} parser breaks here"}';
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: tricky }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('fix: braces');
      expect(out.description).toBe('interface{} parser breaks here');
    });

    it('returns token usage from envelope', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it('appends attribution trailer by default', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r' });
      expect(out.description).toContain('bar');
      expect(out.description).toContain('Commit-message-by: Quicksave AI');
    });

    it('attribution-only when description absent', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: '{"summary":"test: only"}' }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r' });
      expect(out.description).toBe('Commit-message-by: Quicksave AI');
    });
  });

  describe('generateSummary — spawn args', () => {
    it('passes allowedTools whitelist and read-only git tools', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      await svc.generateSummary({ repoPath: '/some/repo', attribution: false });

      const [bin, args, spawnOpts] = (spawn as any).mock.calls[0];
      expect(bin).toBe('/mock/bin/claude');
      expect(spawnOpts.cwd).toBe('/some/repo');

      // Scan args for flags
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--verbose');
      expect(args).toContain('--no-session-persistence');

      const toolsIdx = args.indexOf('--allowedTools');
      expect(toolsIdx).toBeGreaterThan(-1);
      const tools = args[toolsIdx + 1];
      expect(tools).toContain('Read');
      expect(tools).toContain('Grep');
      expect(tools).toContain('Glob');
      expect(tools).toContain('Bash(git diff:*)');
      expect(tools).toContain('Bash(git log:*)');
      // Must NOT allow writes
      expect(tools).not.toContain('Edit');
      expect(tools).not.toContain('Write');
    });

    it('passes --model when specified', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      await svc.generateSummary({
        repoPath: '/r',
        model: 'claude-opus-4-7',
        attribution: false,
      });
      const [, args] = (spawn as any).mock.calls[0];
      const idx = args.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('claude-opus-4-7');
    });

    it('includes branch, context, and conventions in prompt', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      await svc.generateSummary({
        repoPath: '/r',
        branchName: 'feature/x',
        context: 'fixing layout bug',
        conventions: 'use lowercase',
        recentCommits: ['feat: a', 'fix: b'],
        attribution: false,
      });
      const [, args] = (spawn as any).mock.calls[0];
      const promptIdx = args.indexOf('-p');
      const prompt = args[promptIdx + 1];
      expect(prompt).toContain('feature/x');
      expect(prompt).toContain('fixing layout bug');
      expect(prompt).toContain('use lowercase');
      expect(prompt).toContain('feat: a');
      expect(prompt).toContain('fix: b');
    });
  });

  describe('generateSummary — error mapping', () => {
    it('maps ENOENT to NO_CLI_BINARY', async () => {
      const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      (spawn as any).mockReturnValue(makeFakeChild({ errorOnSpawn: err as any }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'NO_CLI_BINARY' });
    });

    it('maps non-zero exit with auth hint to NO_CLI_AUTH', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        exitCode: 1,
        stderr: 'Not authenticated. Please log in.',
      }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'NO_CLI_AUTH' });
    });

    it('maps non-zero exit with generic error to CLI_ERROR', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        exitCode: 2,
        stderr: 'something went sideways',
      }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_ERROR' });
    });

    it('maps unparseable stdout to CLI_PARSE_ERROR', async () => {
      // A line that parses as JSON but has no recognized `type` field: the
      // interpreter ignores every line, the process exits 0, and we end up
      // with no `result` event — which maps to CLI_PARSE_ERROR.
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: '{"noise":true}\n' }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_PARSE_ERROR' });
    });

    it('maps envelope with is_error=true to CLI_ERROR', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: JSON.stringify({ type: 'result', is_error: true, result: 'model blew up' }) + '\n',
      }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_ERROR' });
    });

    it('maps result missing summary field to CLI_PARSE_ERROR', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: 'no json here at all' }),
      }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_PARSE_ERROR' });
    });

    it('kills process and rejects with CLI_TIMEOUT when process hangs', async () => {
      const child = makeFakeChild({ delayMs: 999_999 });
      (spawn as any).mockReturnValue(child);
      const svc = new CommitSummaryCliService(50);
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_TIMEOUT' });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('interpretStreamEvent', () => {
    const { interpretStreamEvent } = __testing;

    it('returns null for non-object input', () => {
      expect(interpretStreamEvent(null)).toBeNull();
      expect(interpretStreamEvent('str')).toBeNull();
      expect(interpretStreamEvent(42)).toBeNull();
    });

    it('returns null for unknown type', () => {
      expect(interpretStreamEvent({ type: 'mystery' })).toBeNull();
    });

    it('maps system/init to a preparing progress', () => {
      const out = interpretStreamEvent({ type: 'system', subtype: 'init' });
      expect(out).toEqual({ kind: 'progress', progress: { phase: 'preparing' } });
    });

    it('returns null for system with unknown subtype', () => {
      expect(interpretStreamEvent({ type: 'system', subtype: 'other' })).toBeNull();
    });

    it('maps assistant tool_use to inspecting with tool count delta', () => {
      const event = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Grep' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      };
      const out = interpretStreamEvent(event);
      expect(out).toEqual({
        kind: 'progress',
        progress: { phase: 'inspecting', lastToolName: 'Read' },
        toolCountDelta: 2,
      });
    });

    it('maps assistant text blocks to generating progress with snippet', () => {
      const event = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Here is my plan: first I will look at...' }],
        },
      };
      const out = interpretStreamEvent(event);
      expect(out?.kind).toBe('progress');
      if (out?.kind === 'progress') {
        expect(out.progress.phase).toBe('generating');
        expect(out.progress.partialText).toContain('Here is my plan');
      }
    });

    it('truncates long text snippets with ellipsis', () => {
      const longText = 'x'.repeat(250);
      const event = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: longText }] },
      };
      const out = interpretStreamEvent(event);
      if (out?.kind === 'progress') {
        expect(out.progress.partialText?.length).toBeLessThanOrEqual(201);
        expect(out.progress.partialText?.endsWith('…')).toBe(true);
      } else {
        throw new Error('expected progress event');
      }
    });

    it('returns null when assistant content is empty', () => {
      expect(interpretStreamEvent({ type: 'assistant', message: { content: [] } })).toBeNull();
    });

    it('returns null when assistant content is missing', () => {
      expect(interpretStreamEvent({ type: 'assistant' })).toBeNull();
    });

    it('maps result envelope to kind=result with token usage', () => {
      const event = {
        type: 'result',
        result: '{"summary":"feat: x"}',
        usage: { input_tokens: 20, output_tokens: 10 },
      };
      const out = interpretStreamEvent(event);
      expect(out).toEqual({
        kind: 'result',
        result: '{"summary":"feat: x"}',
        tokenUsage: { inputTokens: 20, outputTokens: 10 },
      });
    });

    it('maps result envelope with is_error=true to kind=error', () => {
      const out = interpretStreamEvent({
        type: 'result',
        is_error: true,
        result: 'model exploded',
      });
      expect(out).toEqual({ kind: 'error', message: 'model exploded' });
    });

    it('falls back to a generic error message when is_error has no string result', () => {
      const out = interpretStreamEvent({ type: 'result', is_error: true });
      expect(out).toEqual({
        kind: 'error',
        message: 'Claude CLI reported an error',
      });
    });

    it('returns null for result envelope with empty result string', () => {
      expect(interpretStreamEvent({ type: 'result', result: '' })).toBeNull();
    });
  });

  describe('CommitSummaryCliError', () => {
    it('preserves errorCode property', () => {
      const e = new CommitSummaryCliError('oops', 'CLI_TIMEOUT');
      expect(e.errorCode).toBe('CLI_TIMEOUT');
      expect(e.message).toBe('oops');
      expect(e.name).toBe('CommitSummaryCliError');
    });
  });
});
