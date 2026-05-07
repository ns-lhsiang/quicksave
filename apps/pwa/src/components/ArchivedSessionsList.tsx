// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useCallback, useEffect, useRef } from 'react';
import type { BroadcastSessionEntry, SessionListArchivedResponsePayload } from '@sumicom/quicksave-shared';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { Spinner } from './ui/Spinner';

const PAGE_SIZE = 20;

interface ArchivedSessionsListProps {
  cwd: string;
  onListArchived: (cwd: string, offset: number, limit: number) => Promise<SessionListArchivedResponsePayload | null>;
  onRestore: (sessionId: string, cwd: string) => Promise<void>;
  defaultExpanded?: boolean;
}

export function ArchivedSessionsList({ cwd, onListArchived, onRestore, defaultExpanded = false }: ArchivedSessionsListProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [entries, setEntries] = useState<BroadcastSessionEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tried, setTried] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  // When the project changes, discard the prior project's page and any
  // in-flight response, so we re-fetch for the new cwd on next expand.
  useEffect(() => {
    reqIdRef.current++;
    setEntries([]);
    setTotal(0);
    setOffset(0);
    setTried(false);
    setLoading(false);
  }, [cwd]);

  const fetchPage = useCallback(async (nextOffset: number) => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    const res = await onListArchived(cwd, nextOffset, PAGE_SIZE);
    if (myReq !== reqIdRef.current) return; // superseded by a newer fetch or cwd change
    if (res) {
      setEntries(res.entries);
      setTotal(res.total);
      setOffset(res.offset);
    }
    setTried(true);
    setLoading(false);
  }, [cwd, onListArchived]);

  useEffect(() => {
    if (expanded && !tried && !loading) {
      fetchPage(0);
    }
  }, [expanded, tried, loading, fetchPage]);

  const handleRestore = useCallback(async (sessionId: string) => {
    setRestoring(sessionId);
    await onRestore(sessionId, cwd);
    // Remove the restored entry from the page locally; total decreases by 1.
    setEntries((prev) => prev.filter((e) => e.sessionId !== sessionId));
    setTotal((prev) => Math.max(0, prev - 1));
    setRestoring(null);
  }, [onRestore, cwd]);

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 pt-4 pb-2 text-left hover:bg-slate-700/30 transition-colors"
      >
        <h2 className="text-[12px] font-medium text-slate-500 uppercase tracking-wider">
          Archived Tasks
          {expanded && total > 0 && (
            <span className="ml-2 normal-case text-slate-500 tracking-normal">({total})</span>
          )}
        </h2>
        <svg
          className={`w-4 h-4 text-slate-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {expanded && (
        <>
          {loading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size="w-5 h-5" color="border-blue-500" />
            </div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">
              No archived tasks
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-700/40">
                {entries.map((entry) => (
                  <div
                    key={entry.sessionId}
                    className="px-4 py-2.5 flex items-center gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="list-title text-sm line-clamp-2 text-slate-400">
                        {entry.title || entry.firstPrompt?.slice(0, 80) || entry.sessionId.slice(0, 12)}
                      </p>
                      <div className="list-meta flex items-center gap-2 mt-0.5 text-[11px]">
                        {entry.gitBranch && <span>{entry.gitBranch}</span>}
                        <span>{formatRelativeTime(entry.lastAccessedAt)}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRestore(entry.sessionId)}
                      disabled={restoring === entry.sessionId}
                      className="shrink-0 text-xs px-2.5 py-1 rounded-md text-blue-400 hover:text-blue-300 hover:bg-slate-700/50 transition-colors disabled:opacity-50"
                    >
                      {restoring === entry.sessionId ? '…' : 'Restore'}
                    </button>
                  </div>
                ))}
              </div>

              {total > PAGE_SIZE && (
                <div className="px-4 py-2 flex items-center justify-between text-xs text-slate-400">
                  <span>
                    {pageStart}–{pageEnd} of {total}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => fetchPage(Math.max(0, offset - PAGE_SIZE))}
                      disabled={!hasPrev || loading}
                      className="px-2 py-1 rounded-md hover:bg-slate-700/50 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => fetchPage(offset + PAGE_SIZE)}
                      disabled={!hasNext || loading}
                      className="px-2 py-1 rounded-md hover:bg-slate-700/50 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
