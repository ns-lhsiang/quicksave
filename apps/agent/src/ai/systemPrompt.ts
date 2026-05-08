// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId } from '@sumicom/quicksave-shared';

import { SANDBOX_BASH_TOOL, UPDATE_SESSION_STATUS_TOOL } from './sandboxMcp.js';

const STATUS_PROMPT = [
  'Treat each session as a ticket. The session status tool is already loaded and available. On your FIRST response in a new session, call it with at minimum `subject` and `stage` before doing other work. `subject` is what the user is trying to solve (e.g. "Fix auth token expiring early"), not what you are doing (not "Debugging jwt.ts"). On RESUME, if you do not see a prior status tool call in conversation history, call it ONCE with no arguments as a dry-run to read the current stored status; if the returned subject is empty OR does not match what the user is now asking for, follow up with a real call to set/correct it.',
  'Re-call the session status tool whenever the stage changes (investigating -> working -> verifying -> done), whenever work becomes blocked or unblocked (set `blocked` true/false without changing `stage`), or when a one-line `note` would give the user useful progress signal. `note` is an append-only event log, so for long-running tasks emit a fresh `note` every time you rule out an approach, cross a sub-goal, or hit a blocker. Do not skip `verifying` when you have tests/build/repro running. Do not declare `done` until the user\'s problem is fully resolved.',
].join('\n\n');

const COMMIT_TRAILER_PROMPT =
  'When you create git commits in a quicksave session, add `Co-Authored-By: Quicksave AI` as a co-author trailer alongside whatever your platform default already adds (e.g. `Co-Authored-By: Claude ...`). Quicksave is the spawning context and should be credited in addition to — not instead of — the underlying model. Both trailers, one per line, after a blank line below the body.';

const PLATFORM_PROMPTS: Record<AgentId, string[]> = {
  'claude-code': [
    `For non-destructive shell commands (ls, cat, find, git log, git status, git diff, etc.), prefer \`${SANDBOX_BASH_TOOL}\` over Bash. SandboxBash runs in a sandboxed environment. Use Bash only for commands that modify state.`,
    `The session status tool name is \`${UPDATE_SESSION_STATUS_TOOL}\`.`,
    STATUS_PROMPT,
    COMMIT_TRAILER_PROMPT,
  ],
  codex: [
    `For non-destructive shell commands (ls, cat, find, git log, git status, git diff, etc.), prefer the \`${SANDBOX_BASH_TOOL}\` MCP tool when it is available. Use Bash when the command does not fit that tool or requires normal Codex sandbox/approval handling.`,
    `The session status tool name is \`${UPDATE_SESSION_STATUS_TOOL}\`.`,
    STATUS_PROMPT,
    COMMIT_TRAILER_PROMPT,
  ],
};

export function buildSystemPrompt(agentId: AgentId, extra?: string): string {
  const base = (PLATFORM_PROMPTS[agentId] ?? PLATFORM_PROMPTS['claude-code']).join('\n\n');
  return extra ? `${base}\n\n${extra}` : base;
}
