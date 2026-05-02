// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

export const LONG_BASH_COMMAND_THRESHOLD = 100;

export function BashToolView({ input, headerSuffix, isPending, expanded, label, labelClassName }: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
  isPending?: boolean;
  expanded?: boolean;
  /** Optional pill rendered at the start of the header — used by sandbox
   *  variants (e.g. SandboxBash) to identify themselves. */
  label?: string;
  /** Tailwind classes for the label pill. Defaults to a cyan tone matching
   *  the sandbox accent color. */
  labelClassName?: string;
}) {
  const command = (input.command as string) || '?';
  const description = input.description as string | undefined;

  const isLongCommand = !isPending && command.length > LONG_BASH_COMMAND_THRESHOLD;
  const showCollapsedCommand = isLongCommand && !expanded;

  const labelPill = label ? (
    <span
      className={`shrink-0 rounded px-1.5 py-px text-[10px] uppercase tracking-wide ${labelClassName ?? 'bg-cyan-500/20 text-cyan-300'}`}
    >
      {label}
    </span>
  ) : null;

  return (
    <div>
      {description && (
        <div className="flex items-start gap-1.5 mb-1 min-w-0">
          <div className="text-slate-200 text-sm flex-1 min-w-0 break-words">{description}</div>
          {headerSuffix}
          {labelPill}
        </div>
      )}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-orange-400 shrink-0">$</span>{' '}
        <span
          className={`font-mono text-slate-400 flex-1 min-w-0 ${showCollapsedCommand ? 'truncate' : 'break-all'}`}
        >
          {command}
        </span>
        {!description && headerSuffix}
        {!description && labelPill}
      </div>
    </div>
  );
}

/** Bash run inside Quicksave's sandboxed MCP. Visually tagged so it's
 *  unmistakable from a regular Bash invocation. */
export function SandboxBashToolView(props: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
  isPending?: boolean;
  expanded?: boolean;
}) {
  return <BashToolView {...props} label="Sandbox" />;
}
