// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from 'react';
import { ChevronIcon } from '../../ui/ChevronIcon';
import { FilePathLink } from '../FilePathLink';

const AUTO_EXPAND_THRESHOLD = 2; // lines

export function WriteToolView({ input, headerSuffix }: { input: Record<string, unknown>; headerSuffix?: ReactNode }) {
  const filePath = (input.file_path as string) || '';
  const content = (input.content as string) || '';
  const lines = content ? content.split('\n') : [];
  const lineCount = lines.length;
  const autoExpand = lineCount <= AUTO_EXPAND_THRESHOLD;
  const [expanded, setExpanded] = useState(autoExpand);

  return (
    <div>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-green-400 shrink-0">Write</span>{' '}
        {filePath ? (
          <FilePathLink path={filePath} />
        ) : (
          <span className="text-slate-500 font-mono">?</span>
        )}
        {content && !autoExpand && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 shrink-0 bg-slate-700/60 hover:bg-slate-600/60 text-slate-400 hover:text-slate-300 rounded px-1.5 py-0.5 transition-colors"
            aria-label={expanded ? 'Collapse content' : 'Expand content'}
          >
            <ChevronIcon expanded={expanded} size="w-2.5 h-2.5" strokeWidth={2.5} />
            <span className="text-[10px]">{lineCount} lines</span>
          </button>
        )}
        {headerSuffix}
      </div>
      {content && (autoExpand || expanded) && (
        <div className="mt-1.5 font-mono overflow-x-auto bg-green-500/10 rounded px-2 py-1">
          {lines.map((line, i) => (
            <div key={i} className="text-green-400 whitespace-pre-wrap break-all">+ {line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
