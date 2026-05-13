// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminalOps } from '../../hooks/useTerminalOps';
import { getActiveBus } from '../../lib/busRegistry';
import { useProjects, type ProjectEntry } from '../../hooks/useProjects';
import { useMachineStore } from '../../stores/machineStore';
import { Spinner } from '../ui/Spinner';
import { toProjectId } from '../../lib/projectId';

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Flat terminal list for the home page — one row per PTY across every
 * connected machine. Meta row mirrors SessionTicketCard's style: project
 * name + machine pill.
 */
export function TerminalListSection() {
  const navigate = useNavigate();
  const terminals = useTerminalStore((s) => s.terminals);
  const projects = useProjects();
  const machines = useMachineStore((s) => s.machines);
  const { createTerminal } = useTerminalOps(getActiveBus);
  const [picking, setPicking] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const projectByKey = useMemo(() => {
    const map = new Map<string, ProjectEntry>();
    for (const p of projects) map.set(`${p.agentId}\0${p.cwd}`, p);
    return map;
  }, [projects]);

  const machineByAgent = useMemo(() => {
    const map = new Map<string, typeof machines[number]>();
    for (const m of machines) map.set(m.agentId, m);
    return map;
  }, [machines]);

  const rows = useMemo(() => {
    return Object.values(terminals)
      .filter((t) => t.machineAgentId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [terminals]);

  const handleSpawn = useCallback(async (project: ProjectEntry) => {
    setCreateError(null);
    setCreatingFor(project.projectId);
    try {
      const res = await createTerminal({ cwd: project.cwd });
      if (res.success && res.terminal) {
        navigate(`/p/${project.projectId}/t/${res.terminal.terminalId}`);
      } else {
        setCreateError(res.error ?? 'Failed to create terminal');
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingFor(null);
      setPicking(false);
    }
  }, [createTerminal, navigate]);

  const handleNewTerminal = useCallback(() => {
    setCreateError(null);
    if (projects.length === 0) {
      setCreateError('Add a project first to spawn a terminal.');
      return;
    }
    if (projects.length === 1) {
      void handleSpawn(projects[0]);
      return;
    }
    setPicking(true);
  }, [projects, handleSpawn]);

  return (
    <div className="max-w-lg mx-auto py-4 space-y-4">
      <div className="px-4">
        <button
          onClick={handleNewTerminal}
          disabled={creatingFor !== null}
          className="w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-sm font-medium transition-colors disabled:opacity-50"
        >
          {creatingFor ? (
            <Spinner size="w-4 h-4" color="border-blue-400" />
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          )}
          New terminal
        </button>
        {createError && (
          <p className="mt-2 text-xs text-red-400">{createError}</p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-center text-sm text-slate-500 py-12 px-6">
          No terminals yet. Spawn one to run shell commands on any connected machine.
        </p>
      ) : (
        <div className="divide-y divide-slate-700/40">
          {rows.map((t) => {
            const project = projectByKey.get(`${t.machineAgentId}\0${t.cwd}`);
            const projectName = project?.displayName ?? t.cwd.split('/').pop() ?? t.cwd;
            const projectId = project?.projectId ?? toProjectId(t.machineAgentId, t.cwd);
            const machine = machineByAgent.get(t.machineAgentId);
            return (
              <button
                key={t.terminalId}
                onClick={() => navigate(`/p/${projectId}/t/${t.terminalId}`)}
                className="w-full text-left px-4 py-3 hover:bg-slate-700/30 active:bg-slate-700/50 transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 9l6 6 6-6M4 5h16" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="list-title text-sm truncate">{t.title}</p>
                  <div className="list-meta flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-500 flex-wrap">
                    <span className="text-slate-400">{projectName}</span>
                    {machine?.nickname && (
                      <span className="opacity-70">@ {machine.nickname}</span>
                    )}
                    {t.exited ? (
                      <span className="text-amber-400">· exited{t.exitCode != null ? ` (${t.exitCode})` : ''}</span>
                    ) : (
                      <span className="text-emerald-400">· running</span>
                    )}
                    <span className="opacity-70">· {formatRelativeTime(t.lastActivityAt)}</span>
                  </div>
                </div>
                <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            );
          })}
        </div>
      )}

      {picking && (
        <ProjectPickerModal
          projects={projects}
          creatingFor={creatingFor}
          onPick={handleSpawn}
          onCancel={() => { setPicking(false); setCreateError(null); }}
        />
      )}
    </div>
  );
}

function ProjectPickerModal({
  projects,
  creatingFor,
  onPick,
  onCancel,
}: {
  projects: ProjectEntry[];
  creatingFor: string | null;
  onPick: (p: ProjectEntry) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-h-[70vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-700 text-sm font-medium text-slate-200">
          Pick a project for the new terminal
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-700/40">
          {projects.map((p) => (
            <button
              key={p.projectId}
              disabled={creatingFor !== null}
              onClick={() => onPick(p)}
              className="w-full text-left px-4 py-3 hover:bg-slate-700/50 active:bg-slate-700/60 flex items-center gap-3 disabled:opacity-50"
            >
              <div className="flex-1 min-w-0">
                <p className="list-title text-sm truncate">{p.displayName}</p>
                <p className="list-meta text-[11px] text-slate-500 truncate">
                  {p.machineName} · {p.cwd}
                </p>
              </div>
              {creatingFor === p.projectId && <Spinner size="w-4 h-4" color="border-blue-400" />}
            </button>
          ))}
        </div>
        <button
          onClick={onCancel}
          className="px-4 py-3 text-sm text-slate-400 hover:bg-slate-700/40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
