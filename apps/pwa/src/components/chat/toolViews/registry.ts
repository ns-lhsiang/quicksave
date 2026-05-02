// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ComponentType, ReactNode } from 'react';
import { ReadToolView } from './ReadToolView';
import { EditToolView } from './EditToolView';
import { WriteToolView } from './WriteToolView';
import { BashToolView, SandboxBashToolView } from './BashToolView';
import { GrepToolView } from './GrepToolView';
import { GlobToolView } from './GlobToolView';
import { WebFetchToolView } from './WebFetchToolView';
import { WebSearchToolView } from './WebSearchToolView';
import { SkillToolView } from './SkillToolView';
import { AgentToolView } from './AgentToolView';
import { TodoWriteToolView } from './TodoWriteToolView';
import { NotebookEditToolView } from './NotebookEditToolView';
import { AskUserQuestionToolView } from './AskUserQuestionToolView';
import { EnterPlanModeToolView, ExitPlanModeToolView } from './PlanModeToolView';
import { ToolSearchToolView } from './ToolSearchToolView';
import { SessionStatusToolView } from './SessionStatusToolView';

/** Canonical tool names exposed by Quicksave's own MCP server.
 *  Mirrors the constants in apps/agent/src/ai/sandboxMcp.ts. */
export const SANDBOX_BASH_TOOL = 'mcp__quicksave-sandbox__SandboxBash';
export const UPDATE_SESSION_STATUS_TOOL = 'mcp__quicksave-sandbox__UpdateSessionStatus';

export type ToolViewProps = {
  input: Record<string, unknown>;
  /** Optional node rendered at the end of the tool's header line.
   *  Bash places this on the description's right side when a description is
   *  present, otherwise at the end of the command row. Other tools render it
   *  at the end of their single header row. */
  headerSuffix?: ReactNode;
  /** Tool's result content when available. Optional fallback for views like
   *  WebSearch whose toolInput can be empty on historical/legacy cards but
   *  whose result text still carries the meaningful payload (e.g.
   *  `Search: <query>`). Most views ignore this. */
  resultContent?: string;
  /** True while the tool call is awaiting user input (permission or question).
   *  Views that auto-collapse (e.g. Bash) keep the full content visible while
   *  pending so the user can read it before approving. */
  isPending?: boolean;
  /** Shared expanded state controlled by the parent (e.g. Bash uses this to
   *  decide whether to truncate or fully render its command alongside its
   *  result). */
  expanded?: boolean;
};

export const TOOL_VIEWS: Record<string, ComponentType<ToolViewProps>> = {
  Read: ReadToolView,
  Edit: EditToolView,
  Write: WriteToolView,
  Bash: BashToolView,
  Grep: GrepToolView,
  Glob: GlobToolView,
  WebFetch: WebFetchToolView,
  WebSearch: WebSearchToolView,
  Skill: SkillToolView,
  Agent: AgentToolView,
  TodoWrite: TodoWriteToolView,
  NotebookEdit: NotebookEditToolView,
  AskUserQuestion: AskUserQuestionToolView,
  EnterPlanMode: EnterPlanModeToolView as ComponentType<ToolViewProps>,
  ExitPlanMode: ExitPlanModeToolView,
  ToolSearch: ToolSearchToolView,
  [SANDBOX_BASH_TOOL]: SandboxBashToolView,
  [UPDATE_SESSION_STATUS_TOOL]: SessionStatusToolView,
};

/** Tool-specific accent colors for the left border */
export const TOOL_COLORS: Record<string, string> = {
  Read: 'border-blue-500/60',
  Edit: 'border-yellow-500/60',
  Write: 'border-green-500/60',
  Bash: 'border-orange-500/60',
  Grep: 'border-purple-500/60',
  Glob: 'border-purple-500/60',
  WebFetch: 'border-cyan-500/60',
  WebSearch: 'border-cyan-500/60',
  Skill: 'border-indigo-500/60',
  Agent: 'border-violet-500/60',
  TodoWrite: 'border-teal-500/60',
  NotebookEdit: 'border-amber-500/60',
  AskUserQuestion: 'border-blue-500/60',
  EnterPlanMode: 'border-indigo-500/60',
  ExitPlanMode: 'border-indigo-500/60',
  ToolSearch: 'border-pink-500/60',
  [SANDBOX_BASH_TOOL]: 'border-cyan-500/60',
  [UPDATE_SESSION_STATUS_TOOL]: 'border-teal-500/60',
};
