// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from 'react';
import { parseToolUseError } from './ToolResultMessage';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';
import { ChevronIcon } from '../ui/ChevronIcon';
import { TOOL_VIEWS, TOOL_COLORS, SANDBOX_BASH_TOOL, UPDATE_SESSION_STATUS_TOOL } from './toolViews/registry';
import { AskUserQuestionToolView } from './toolViews/AskUserQuestionToolView';
import { ExitPlanModeToolView, ExitPlanModeInteractiveView } from './toolViews/PlanModeToolView';
import { FallbackToolView } from './toolViews/FallbackToolView';
import { LONG_BASH_COMMAND_THRESHOLD } from './toolViews/BashToolView';
import { InlinePermissionActions } from './InlinePermissionActions';
import { InteractiveQuestionView } from './InteractiveQuestionView';
import { linkifyPaths } from './linkifyPaths';

/** Tools whose stdout typically contains paths worth linkifying. */
const LINKIFY_RESULT_TOOLS = new Set(['Bash', 'Glob', 'Grep', SANDBOX_BASH_TOOL]);

const INLINE_RESULT_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
const INLINE_RESULT_BORDER: Record<string, string> = {
  Read:  'border-blue-500/20',
  Write: 'border-green-500/20',
  Edit:  'border-yellow-500/20',
  Bash:  'border-orange-500/20',
  Glob:  'border-purple-500/20',
  Grep:  'border-purple-500/20',
  [SANDBOX_BASH_TOOL]: 'border-cyan-500/20',
};

// Tools where result text is implied by the tool call itself (suppress unless error)
const TOOLS_SUPPRESS_RESULT_CONTENT = new Set(['Edit', 'Write', UPDATE_SESSION_STATUS_TOOL]);

function InlineToolResult({ content, toolName, suppressContent, expanded }: {
  content: string;
  toolName?: string;
  suppressContent?: boolean;
  expanded: boolean;
}) {
  const borderColor = INLINE_RESULT_BORDER[toolName ?? ''] ?? 'border-slate-500/20';

  if (!content.trim()) return null;

  const toolError = parseToolUseError(content);
  if (toolError !== null || suppressContent) {
    if (toolError === null) return null; // suppressed and no error
    return (
      <div className="mt-1.5 border-t border-red-500/30">
        <div className="pt-1.5 flex items-start gap-1.5">
          <span className="text-red-400/70 text-[10px] uppercase tracking-wide shrink-0 mt-px">Error</span>
          <span className="text-red-300 text-xs">{toolError || 'Tool call failed'}</span>
        </div>
      </div>
    );
  }

  if (!expanded) return null;

  const body = toolName && LINKIFY_RESULT_TOOLS.has(toolName)
    ? linkifyPaths(content)
    : content;

  return (
    <div className={`mt-1.5 border-t ${borderColor}`}>
      <pre className="mt-1 min-w-0 whitespace-pre-wrap break-all text-slate-400 overflow-x-auto pt-1">
        {body}
      </pre>
    </div>
  );
}

export function ToolCallMessage({ toolName, toolInput, content, toolResultContent, toolResultIsError, toolAnswers, pendingInputRequest, onRespond }: {
  toolName?: string;
  toolInput?: string;
  content: string;
  toolResultContent?: string;
  toolResultIsError?: boolean;
  toolAnswers?: Record<string, string>;
  pendingInputRequest?: ClaudeUserInputRequestPayload;
  onRespond?: (action: 'allow' | 'deny', response?: string, allowPattern?: string) => void;
}) {
  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(toolInput || content || '{}');
  } catch {
    // fallback to empty
  }

  // Parse tool result for views that need answer data (e.g. AskUserQuestion)
  let parsedResult: Record<string, unknown> | undefined;
  if (toolResultContent) {
    try { parsedResult = JSON.parse(toolResultContent); } catch { /* ignore */ }
  }
  // Prefer the agent-attached answers (set the moment the user responds);
  // fall back to anything embedded in the CLI tool_result.
  const askAnswers = toolAnswers ?? (parsedResult as { answers?: Record<string, string> } | undefined)?.answers;

  const hasPending = !!pendingInputRequest;

  // AskUserQuestion with pending request: render unified interactive view
  if (toolName === 'AskUserQuestion' && hasPending && pendingInputRequest.inputType === 'question' && onRespond) {
    return (
      <div className="flex justify-start">
        <div className="bg-slate-800/60 border-l-2 border-blue-500/80 rounded-r-lg pl-2.5 pr-3 py-1.5 w-full text-xs text-slate-300 overflow-hidden">
          <InteractiveQuestionView
            request={pendingInputRequest}
            parsedInput={parsedInput}
            onRespond={onRespond}
          />
        </div>
      </div>
    );
  }

  // ExitPlanMode with pending request: render plan review with approve/reject
  // Plan text is in the INPUT (input.plan), not the output
  if (toolName === 'ExitPlanMode' && hasPending && onRespond) {
    return (
      <div className="flex justify-start">
        <div className="bg-slate-800/60 border-l-2 border-indigo-500/80 rounded-r-lg pl-2.5 pr-3 py-1.5 w-full text-sm text-slate-300 overflow-x-auto">
          <ExitPlanModeInteractiveView input={parsedInput} plan={parsedInput.plan as string} onRespond={onRespond} />
        </div>
      </div>
    );
  }

  const ToolView = toolName ? TOOL_VIEWS[toolName] : undefined;
  const accentColor = hasPending
    ? 'border-amber-500/80'
    : toolName ? (TOOL_COLORS[toolName] || 'border-slate-500/60') : 'border-slate-500/60';

  // Inline result expand state (lifted so chevron can live in header row)
  const isMcpTool = !!toolName?.startsWith('mcp__');
  const isInlineResultTool = !!(toolName && toolResultContent && (INLINE_RESULT_TOOLS.has(toolName) || isMcpTool));
  const resultContent = toolResultContent || '';
  const resultLineCount = resultContent.trimEnd().split('\n').length;
  const resultAutoExpand = !resultContent.trim() || resultLineCount <= 2;
  const resultSuppressed = toolName ? TOOLS_SUPPRESS_RESULT_CONTENT.has(toolName) : false;
  const resultError = isInlineResultTool ? parseToolUseError(resultContent) : null;
  const resultIsCollapsible = isInlineResultTool && !resultAutoExpand && resultError === null && !resultSuppressed;

  // Bash (and our sandboxed Bash) get a unified left-side chevron that toggles
  // BOTH command truncation and result visibility. Other tools keep the
  // right-side "{N} lines" chevron.
  const isBash = toolName === 'Bash' || toolName === SANDBOX_BASH_TOOL;
  const bashCommandLong = isBash && !hasPending
    && ((parsedInput.command as string) ?? '').length > LONG_BASH_COMMAND_THRESHOLD;
  const showRightChevron = resultIsCollapsible && !isBash;
  const showLeftChevron = isBash && (bashCommandLong || resultIsCollapsible);

  const [resultExpanded, setResultExpanded] = useState(false);

  const defaultChevronButton: ReactNode = showRightChevron ? (
    <button
      onClick={() => setResultExpanded(v => !v)}
      className="flex items-center gap-1 shrink-0 bg-slate-700/60 hover:bg-slate-600/60 text-slate-400 hover:text-slate-300 rounded px-1.5 py-0.5 transition-colors"
    >
      <ChevronIcon expanded={resultExpanded} size="w-2.5 h-2.5" strokeWidth={2.5} />
      <span className="text-[10px]">{resultLineCount} lines</span>
    </button>
  ) : null;

  const bashChevronButton: ReactNode = showLeftChevron ? (
    <button
      onClick={() => setResultExpanded(v => !v)}
      className="flex items-center gap-1 shrink-0 bg-slate-700/60 hover:bg-slate-600/60 text-slate-400 hover:text-slate-300 rounded p-1 transition-colors"
      aria-label={resultExpanded ? 'Collapse' : 'Expand'}
    >
      <ChevronIcon expanded={resultExpanded} size="w-4 h-4" strokeWidth={2.5} />
      {resultIsCollapsible && (
        <span className="text-[10px]">{resultLineCount} lines</span>
      )}
    </button>
  ) : null;

  return (
    <div className="flex justify-start">
      <div className={`bg-slate-800/60 border-l-2 ${accentColor} rounded-r-lg pl-2.5 pr-3 py-1.5 w-full text-slate-300 ${toolName === 'ExitPlanMode' ? 'text-sm overflow-x-auto' : 'text-xs overflow-hidden'}`}>
        <div className="min-w-0">
          {toolName === 'AskUserQuestion'
            ? <AskUserQuestionToolView input={parsedInput} answers={askAnswers} />
            : toolName === 'ExitPlanMode'
              ? <ExitPlanModeToolView input={parsedInput} plan={parsedInput.plan as string} isRejected={toolResultIsError} />
              : ToolView
                ? <ToolView
                    input={parsedInput}
                    headerSuffix={(isBash ? bashChevronButton : defaultChevronButton) ?? undefined}
                    resultContent={resultContent}
                    isPending={hasPending}
                    expanded={resultExpanded}
                  />
                : <FallbackToolView toolName={toolName} content={toolInput || content} />}
        </div>
        {isInlineResultTool && (
          <InlineToolResult
            content={resultContent}
            toolName={toolName}
            suppressContent={resultSuppressed}
            expanded={resultAutoExpand || resultExpanded}
          />
        )}
        {pendingInputRequest && onRespond && pendingInputRequest.inputType === 'permission' && (
          <InlinePermissionActions request={pendingInputRequest} onRespond={onRespond} />
        )}
      </div>
    </div>
  );
}
