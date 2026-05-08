// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { spawn, type ChildProcess } from 'child_process';
import type {
  ClaudeModel,
  CommitSummaryProgress,
  GenerateCommitSummaryErrorCode,
  TokenUsage,
} from '@sumicom/quicksave-shared';
import { getClaudeBin } from './claudeCliProvider.js';

export interface GenerateCliSummaryOptions {
  repoPath: string;
  context?: string;
  model?: ClaudeModel;
  recentCommits?: string[];
  branchName?: string;
  conventions?: string;
  attribution?: boolean;
  /** Called as the CLI streams progress events (stream-json). */
  onProgress?: (progress: Partial<CommitSummaryProgress>) => void;
  /** Registered before spawn so callers can abort the in-flight CLI process. */
  onSpawn?: (child: ChildProcess) => void;
}

export interface GenerateCliSummaryResult {
  summary: string;
  description?: string;
  tokenUsage?: TokenUsage;
}

export class CommitSummaryCliError extends Error {
  constructor(
    message: string,
    public errorCode: GenerateCommitSummaryErrorCode
  ) {
    super(message);
    this.name = 'CommitSummaryCliError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
].join(',');

export class CommitSummaryCliService {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async generateSummary(options: GenerateCliSummaryOptions): Promise<GenerateCliSummaryResult> {
    const { repoPath, model, attribution = true, onProgress, onSpawn } = options;

    const prompt = this.buildPrompt(options);
    const bin = getClaudeBin();

    // stream-json + --verbose lets us observe tool_use / partial assistant
    // text events as they arrive, so we can emit progress updates. The final
    // `result` event still carries the full JSON payload with token usage.
    const args: string[] = [
      '-p',
      prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', ALLOWED_TOOLS,
      '--no-session-persistence',
    ];
    if (model) {
      args.push('--model', model);
    }

    const final = await this.spawnAndCollect(bin, args, repoPath, onProgress, onSpawn);
    const { summary, description } = this.extractCommitMessage(final.result);

    const finalDescription = attribution
      ? appendAttribution(description)
      : description;

    return {
      summary,
      description: finalDescription,
      tokenUsage: final.tokenUsage,
    };
  }

  private spawnAndCollect(
    bin: string,
    args: string[],
    cwd: string,
    onProgress?: (p: Partial<CommitSummaryProgress>) => void,
    onSpawn?: (child: ChildProcess) => void,
  ): Promise<{ result: string; tokenUsage?: TokenUsage }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, {
          cwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(mapSpawnError(err));
        return;
      }

      onSpawn?.(child);

      let stdoutBuf = '';
      let stderr = '';
      let settled = false;
      let finalResult: string | undefined;
      let finalTokenUsage: TokenUsage | undefined;
      let toolCount = 0;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        reject(new CommitSummaryCliError(
          `Claude CLI timed out after ${Math.round(this.timeoutMs / 1000)}s`,
          'CLI_TIMEOUT'
        ));
      }, this.timeoutMs);

      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        // Process complete lines; keep the trailing partial line in the buffer.
        let newlineIdx: number;
        while ((newlineIdx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, newlineIdx).trim();
          stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
          if (!line) continue;

          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // not a JSON line, skip
          }

          const parsed = interpretStreamEvent(event);
          if (parsed?.kind === 'progress' && onProgress) {
            if (parsed.toolCountDelta) {
              toolCount += parsed.toolCountDelta;
              onProgress({ ...parsed.progress, toolCount });
            } else {
              onProgress({ ...parsed.progress, toolCount });
            }
          } else if (parsed?.kind === 'result') {
            finalResult = parsed.result;
            finalTokenUsage = parsed.tokenUsage;
          } else if (parsed?.kind === 'error') {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
            reject(classifyCliFailure(parsed.message, null));
            return;
          }
        }
      });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(mapSpawnError(err));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal === 'SIGTERM' && code === null) {
          reject(new CommitSummaryCliError('Generation was cancelled', 'CLI_ERROR'));
          return;
        }
        if (code !== 0) {
          const hint = stderr.trim() || stdoutBuf.trim() || `exit code ${code}`;
          reject(classifyCliFailure(hint, code));
          return;
        }
        if (!finalResult) {
          reject(new CommitSummaryCliError(
            'Claude CLI produced no result event',
            'CLI_PARSE_ERROR'
          ));
          return;
        }
        onProgress?.({ phase: 'finalizing' });
        resolve({ result: finalResult, tokenUsage: finalTokenUsage });
      });
    });
  }

  private extractCommitMessage(result: string): { summary: string; description?: string } {
    // Models often wrap or surround the JSON with markdown fences and chatter.
    // Try every plausible candidate (whole text, fence bodies, balanced
    // brace blocks scanned right-to-left) and return the first that parses.
    for (const candidate of jsonCandidates(result)) {
      const parsed = tryParseCommitJson(candidate);
      if (parsed) return parsed;
    }

    throw new CommitSummaryCliError(
      'Could not extract {summary, description} from Claude CLI output',
      'CLI_PARSE_ERROR'
    );
  }

  private buildPrompt(opts: GenerateCliSummaryOptions): string {
    const sections: string[] = [
      'You are generating a git commit message for staged changes in this repository.',
      '',
      'Steps:',
      '1. Run `git diff --cached --name-only` to see which files changed; then `git diff --cached` for content.',
      '2. If staged changes touch a function, type, or component that is referenced elsewhere, briefly inspect call sites (Grep + Read) to understand intent.',
      '3. Inspect recent commits to match the project\'s style (`git log --oneline -20`).',
      '4. Your VERY LAST line of output must be a single JSON object — no markdown fences, no commentary after it:',
      '   {"summary": "<header line, ≤72 chars>", "description": "<body explaining the why>"}',
      '',
      'Default format — Conventional Commits v1.0.0:',
      '  <type>(<scope>): <subject>',
      '',
      '  [body]',
      '',
      '  [footers]',
      '',
      'Type (required): one of feat, fix, docs, refactor, chore, test, style, perf, ci, build.',
      '  - feat: user-visible new capability  - fix: user-visible bug fix',
      '  - refactor: behavior-preserving code change  - perf: measurable perf improvement',
      '  - test/docs/style/chore/ci/build: as named',
      '',
      'Scope (optional, recommended): a single short noun naming the area of the codebase touched.',
      '  - Infer it from the staged file paths\' common prefix (top-level dir, package, or module name).',
      '  - If staged changes span multiple unrelated areas, OMIT the scope rather than inventing an umbrella term.',
      '  - Lowercase, hyphenated; no commas, no slashes.',
      '',
      'Subject (required, in `summary`):',
      '  - ≤72 chars including the `<type>(<scope>): ` prefix.',
      '  - Imperative present tense ("add X", not "added X" / "adds X").',
      '  - No trailing period. Lowercase first word after the colon (unless it is a proper noun).',
      '  - Describe WHAT and WHY in one breath; details go in the body.',
      '',
      'Body (in `description`, separated from header by a blank line in the rendered commit):',
      '  - Wrap each line at ≤72 chars. Use `\\n` for line breaks inside the JSON string.',
      '  - Use blank lines between paragraphs. Use `- ` bullets when listing multiple distinct aspects.',
      '  - Required when: behavior changes, multiple modules touched, motivation non-obvious, or migration steps needed.',
      '  - Omit `description` ONLY for truly trivial changes (typo fix, dependency bump, single-line tweak).',
      '',
      'Footer (append to `description` after a blank line, one trailer per line):',
      '  - `BREAKING CHANGE: <what broke and how to migrate>` for any breaking API/behavior change.',
      '  - Issue refs like `Refs: #123` / `Closes: #123` when the staged changes resolve a tracked issue.',
      '',
      'Hard constraints:',
      '  - Do NOT wrap the JSON in markdown fences. Do NOT write anything after the JSON object.',
      '  - Do NOT invent issue numbers, ticket IDs, or co-author trailers — only include footers backed by evidence in the diff or context.',
    ];

    if (opts.conventions) {
      sections.push(
        '',
        'Project commit conventions (these OVERRIDE the defaults above where they conflict — e.g. allowed scope vocabulary, custom types, subject length):',
        opts.conventions,
      );
    }
    if (opts.recentCommits?.length) {
      sections.push('', 'Recent commits (match this style):', ...opts.recentCommits.map((m) => `- ${m}`));
    }
    if (opts.branchName) {
      sections.push('', `Branch: ${opts.branchName}`);
    }
    if (opts.context) {
      sections.push('', `User context: ${opts.context}`);
    }

    return sections.join('\n');
  }
}

type StreamInterpretation =
  | { kind: 'progress'; progress: Partial<CommitSummaryProgress>; toolCountDelta?: number }
  | { kind: 'result'; result: string; tokenUsage?: TokenUsage }
  | { kind: 'error'; message: string }
  | null;

/**
 * Interpret a single stream-json envelope into a progress update or the final
 * result. The CLI emits envelopes of several shapes; we read the ones we need
 * and ignore the rest (tolerant of CLI version drift).
 */
function interpretStreamEvent(event: unknown): StreamInterpretation {
  if (!event || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;

  // Terminal result envelope: `{ type: 'result', result: string, usage, is_error }`
  if (e.type === 'result') {
    if (e.is_error) {
      const msg = typeof e.result === 'string' ? e.result : 'Claude CLI reported an error';
      return { kind: 'error', message: msg };
    }
    const result = typeof e.result === 'string' ? e.result : '';
    if (!result) return null;
    return { kind: 'result', result, tokenUsage: extractTokenUsage(e.usage) };
  }

  // System init — the CLI is spinning up tools.
  if (e.type === 'system') {
    if (e.subtype === 'init') {
      return { kind: 'progress', progress: { phase: 'preparing' } };
    }
    return null;
  }

  // Assistant turn — wraps a raw Anthropic API message under `message`.
  if (e.type === 'assistant') {
    const msg = e.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) return null;

    let toolName: string | undefined;
    let text: string | undefined;
    let toolCountDelta = 0;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use') {
        toolName = typeof b.name === 'string' ? b.name : toolName;
        toolCountDelta += 1;
      } else if (b.type === 'text') {
        const t = typeof b.text === 'string' ? b.text : undefined;
        if (t) text = text ? `${text}${t}` : t;
      }
    }

    if (toolName) {
      return {
        kind: 'progress',
        progress: { phase: 'inspecting', lastToolName: toolName },
        toolCountDelta,
      };
    }
    if (text) {
      const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      return { kind: 'progress', progress: { phase: 'generating', partialText: snippet } };
    }
    return null;
  }

  return null;
}

/**
 * Yield JSON candidate strings to try, in priority order:
 *   1. The trimmed whole text.
 *   2. Each ```...``` fence body (last fence first — LLMs usually put the
 *      "real answer" fence at the end of any preamble).
 *   3. Every balanced {...} block scanned right-to-left, ignoring braces
 *      inside JSON string literals.
 *
 * Yields lazily so callers can stop at the first parsable candidate.
 */
function* jsonCandidates(raw: string): Generator<string> {
  const trimmed = raw.trim();
  if (!trimmed) return;
  yield trimmed;

  // Pull each fence body. We accept ```json, ```JSON, or bare ```.
  const fenceBodies: string[] = [];
  const fenceRe = /```(?:[a-zA-Z]+)?\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const body = m[1].trim();
    if (body) fenceBodies.push(body);
  }
  for (let i = fenceBodies.length - 1; i >= 0; i--) {
    yield fenceBodies[i];
  }

  // Walk right-to-left, finding balanced {...} blocks. We respect JSON string
  // literals so a `}` inside `"foo}"` doesn't throw off the brace count.
  for (const block of balancedBraceBlocks(trimmed)) {
    yield block;
  }
}

function* balancedBraceBlocks(text: string): Generator<string> {
  // Forward-scan once to find every `{`/`}` that is NOT inside a JSON string
  // literal. Then pair them with a depth stack so each close-brace knows its
  // matching open. We yield slices from the rightmost close first, so a
  // trailing real JSON wins over any earlier example block in the chatter.
  type Brace = { idx: number; kind: '{' | '}' };
  const braces: Brace[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '}') braces.push({ idx: i, kind: c });
  }

  const pairs: Array<[number, number]> = [];
  const stack: number[] = [];
  for (const b of braces) {
    if (b.kind === '{') stack.push(b.idx);
    else if (stack.length > 0) {
      const open = stack.pop()!;
      pairs.push([open, b.idx]);
    }
  }
  // Sort by close index descending — rightmost (likely final) JSON first.
  pairs.sort((a, b) => b[1] - a[1]);
  for (const [open, close] of pairs) {
    yield text.slice(open, close + 1);
  }
}

function tryParseCommitJson(text: string): { summary: string; description?: string } | null {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.summary === 'string' && obj.summary.trim()) {
      const description = typeof obj.description === 'string' && obj.description.trim()
        ? obj.description.trim()
        : undefined;
      return { summary: obj.summary.trim(), description };
    }
  } catch { /* fall through */ }
  return null;
}

function appendAttribution(description: string | undefined): string {
  const trailer = 'Commit-message-by: Quicksave AI';
  return description ? `${description}\n\n${trailer}` : trailer;
}

function extractTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = Number(u.input_tokens) || 0;
  const outputTokens = Number(u.output_tokens) || 0;
  if (!inputTokens && !outputTokens) return undefined;
  return { inputTokens, outputTokens };
}

function mapSpawnError(err: unknown): CommitSummaryCliError {
  const msg = err instanceof Error ? err.message : String(err);
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return new CommitSummaryCliError(
      'Claude CLI binary not found. Install with: npm install -g @anthropic-ai/claude-code',
      'NO_CLI_BINARY'
    );
  }
  return new CommitSummaryCliError(`Failed to spawn Claude CLI: ${msg}`, 'CLI_ERROR');
}

function classifyCliFailure(hint: string, _exitCode: number | null): CommitSummaryCliError {
  const lower = hint.toLowerCase();
  if (lower.includes('not authenticated') || lower.includes('please log in') || lower.includes('login') || lower.includes('api key')) {
    return new CommitSummaryCliError(
      'Claude CLI is not authenticated. Run `claude` once to log in.',
      'NO_CLI_AUTH'
    );
  }
  return new CommitSummaryCliError(hint, 'CLI_ERROR');
}

// Exposed for testing
export const __testing = { interpretStreamEvent, jsonCandidates };
