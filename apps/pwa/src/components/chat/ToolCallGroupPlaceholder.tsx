// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { ChevronIcon } from '../ui/ChevronIcon';

export function ToolCallGroupPlaceholder({ count, expanded, onToggle }: {
  count: number;
  /** When true, the chip acts as a "hide" affordance shown above the
   *  expanded group; when false, it stands in for the hidden tool calls. */
  expanded: boolean;
  onToggle: () => void;
}) {
  const noun = count === 1 ? 'call' : 'calls';
  return (
    <div className="flex justify-start">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 bg-slate-800/40 hover:bg-slate-800/70 border border-dashed border-slate-700 rounded-lg px-3 py-1 text-xs text-slate-400 hover:text-slate-300 transition-colors"
        aria-expanded={expanded}
        aria-label={expanded ? `Hide ${count} tool ${noun}` : `Show ${count} hidden tool ${noun}`}
      >
        <ChevronIcon expanded={expanded} size="w-3 h-3" strokeWidth={2.5} />
        {count} tool {noun}
      </button>
    </div>
  );
}
