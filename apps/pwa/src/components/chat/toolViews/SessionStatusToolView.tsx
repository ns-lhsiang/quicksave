// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

const STAGE_STYLES: Record<string, string> = {
  investigating: 'bg-blue-500/20 text-blue-300',
  working: 'bg-amber-500/20 text-amber-300',
  verifying: 'bg-cyan-500/20 text-cyan-300',
  done: 'bg-green-500/20 text-green-300',
};

export function SessionStatusToolView({ input, headerSuffix }: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
}) {
  const subject = (input.subject as string | undefined) || undefined;
  const stage = (input.stage as string | undefined) || undefined;
  const blocked = typeof input.blocked === 'boolean' ? (input.blocked as boolean) : undefined;
  const note = (input.note as string | undefined) || undefined;

  const isDryRun = !subject && !stage && blocked === undefined && !note;

  return (
    <div>
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        <span className="text-slate-400 shrink-0">{isDryRun ? 'Read status' : 'Status'}</span>
        {stage && (
          <span className={`shrink-0 rounded px-1.5 py-px text-[10px] uppercase tracking-wide ${STAGE_STYLES[stage] || 'bg-slate-700/60 text-slate-300'}`}>
            {stage}
          </span>
        )}
        {blocked === true && (
          <span className="shrink-0 rounded px-1.5 py-px text-[10px] uppercase tracking-wide bg-red-500/20 text-red-300">
            blocked
          </span>
        )}
        {blocked === false && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
            unblocked
          </span>
        )}
        {headerSuffix}
        <span className="ml-auto shrink-0 rounded px-1.5 py-px text-[10px] uppercase tracking-wide bg-cyan-500/20 text-cyan-300">
          Sandbox
        </span>
      </div>
      {subject && (
        <div className="mt-1 text-slate-200 break-words">{subject}</div>
      )}
      {note && (
        <div className="mt-0.5 text-slate-400 italic break-words">— {note}</div>
      )}
    </div>
  );
}
