// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useRef, useState, useEffect } from 'react';
import { ChevronIcon } from '../../ui/ChevronIcon';
import { FilePathLink } from '../FilePathLink';

const SIDE_BY_SIDE_MIN_WIDTH = 640;
const AUTO_EXPAND_THRESHOLD = 2; // lines

export function EditToolView({ input }: { input: Record<string, unknown> }) {
  const filePath = (input.file_path as string) || '';
  const oldStr = (input.old_string as string) || '';
  const newStr = (input.new_string as string) || '';

  const containerRef = useRef<HTMLDivElement>(null);
  const [sideBySide, setSideBySide] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setSideBySide(entry.contentRect.width >= SIDE_BY_SIDE_MIN_WIDTH);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const oldLines = oldStr ? oldStr.split('\n') : [];
  const newLines = newStr ? newStr.split('\n') : [];
  const maxLines = Math.max(oldLines.length, newLines.length);
  const autoExpand = maxLines <= AUTO_EXPAND_THRESHOLD;
  const [expanded, setExpanded] = useState(autoExpand);

  const renderDiff = () => {
    if (sideBySide) {
      return (
        <div className="grid grid-cols-2 divide-x divide-slate-700 rounded overflow-hidden">
          <div className="bg-red-500/10 px-2 py-1">
            {oldLines.map((line, i) => (
              <div key={i} className="text-red-400 whitespace-pre-wrap break-all">- {line}</div>
            ))}
            {oldLines.length === 0 && <div className="text-slate-600 italic text-xs">empty</div>}
          </div>
          <div className="bg-green-500/10 px-2 py-1">
            {newLines.map((line, i) => (
              <div key={i} className="text-green-400 whitespace-pre-wrap break-all">+ {line}</div>
            ))}
            {newLines.length === 0 && <div className="text-slate-600 italic text-xs">empty</div>}
          </div>
        </div>
      );
    }
    return (
      <>
        {oldLines.length > 0 && (
          <div className="bg-red-500/10 rounded-t px-2 py-1">
            {oldLines.map((line, i) => (
              <div key={i} className="text-red-400 whitespace-pre-wrap break-all">- {line}</div>
            ))}
          </div>
        )}
        {newLines.length > 0 && (
          <div className="bg-green-500/10 rounded-b px-2 py-1">
            {newLines.map((line, i) => (
              <div key={i} className="text-green-400 whitespace-pre-wrap break-all">+ {line}</div>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div ref={containerRef}>
      <div className="flex items-center gap-1.5">
        <span className="text-yellow-400">Edit</span>{' '}
        {filePath ? (
          <FilePathLink path={filePath} />
        ) : (
          <span className="text-slate-500 font-mono">?</span>
        )}
        <span className="text-slate-500">(</span>
        <span className="text-red-400">-{oldLines.length}</span>
        <span className="text-slate-500">/</span>
        <span className="text-green-400">+{newLines.length}</span>
        <span className="text-slate-500">)</span>
        {(oldStr || newStr) && !autoExpand && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 shrink-0 bg-slate-700/60 hover:bg-slate-600/60 text-slate-400 hover:text-slate-300 rounded px-1.5 py-0.5 transition-colors"
          >
            <ChevronIcon expanded={expanded} size="w-2.5 h-2.5" strokeWidth={2.5} />
            <span className="text-[10px]">{maxLines} lines</span>
          </button>
        )}
      </div>
      {(oldStr || newStr) && (autoExpand || expanded) && (
        <div className="mt-1.5 font-mono overflow-x-auto">
          {renderDiff()}
        </div>
      )}
    </div>
  );
}
