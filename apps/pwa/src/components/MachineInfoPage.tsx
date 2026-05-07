// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { Spinner } from './ui/Spinner';
import { ConfirmModal } from './ui/ConfirmModal';
import { useMachineStore } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useProjects } from '../hooks/useProjects';
import { MachineIcon } from './icons/MachineIcon';
import type { ProjectDeleteResponsePayload } from '@sumicom/quicksave-shared';

interface MachineInfoPageProps {
  onSetActiveAgent: (agentId: string) => void;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
  onRestartAgent?: () => Promise<{ success: boolean; error?: string }>;
  onDeleteProject?: (cwd: string) => Promise<ProjectDeleteResponsePayload | null>;
}

/**
 * Per-machine info page. Surfaces the CLI agent version (and update/restart
 * controls) that used to live in the in-session settings drawer. We bind the
 * client to this machine's agent on mount so the shared `onCheckAgentUpdate`
 * etc. handlers route to the correct peer — the same `setActiveAgent`
 * convention the project routes use.
 */
export function MachineInfoPage({
  onSetActiveAgent,
  onCheckAgentUpdate,
  onUpdateAgent,
  onRestartAgent,
  onDeleteProject,
}: MachineInfoPageProps) {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();

  const machine = useMachineStore((s) => s.machines.find((m) => m.agentId === agentId));
  const removeProjectFromStore = useMachineStore((s) => s.removeProject);
  const conn = useConnectionStore((s) => (agentId ? s.agentConnections[agentId] : undefined));
  const isOnline = conn?.state === 'connected' && conn?.online !== false;

  const allProjects = useProjects();
  const machineProjects = useMemo(
    () => allProjects.filter((p) => p.agentId === agentId),
    [allProjects, agentId],
  );

  const [editMode, setEditMode] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ cwd: string; displayName: string } | null>(null);
  const canDelete = isOnline && !!onDeleteProject;

  // agentVersion and devBuild are per-agent; latestVersion is a global (the
  // npm "latest" tag applies to all agents equally). Routing the active agent
  // to this machine on mount so the version-check/update/restart handlers
  // target the right peer.
  const agentVersion = conn?.agentVersion ?? null;
  const devBuild = conn?.devBuild ?? false;
  const latestVersion = useConnectionStore((s) => s.latestVersion);
  const setLatestVersion = useConnectionStore((s) => s.setLatestVersion);

  useEffect(() => {
    if (agentId) onSetActiveAgent(agentId);
  }, [agentId, onSetActiveAgent]);

  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<{ success: boolean; message: string } | null>(null);

  if (!machine) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <BaseStatusBar
          left={<BackButton onClick={() => navigate(-1)} />}
          center={<span className="text-sm font-medium text-slate-300"><FormattedMessage id="machineInfo.fallback.title" /></span>}
        />
        <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
          Machine not found.
        </div>
      </div>
    );
  }

  const handleConfirmDelete = async () => {
    if (!pendingDelete || !agentId || !onDeleteProject) return;
    const { cwd } = pendingDelete;
    setPendingDelete(null);
    const result = await onDeleteProject(cwd);
    if (result && !result.success) {
      console.error('Failed to delete project:', result.error);
      return;
    }
    removeProjectFromStore(agentId, cwd);
    if (machineProjects.length <= 1) setEditMode(false);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={<span className="text-sm font-medium text-slate-300 truncate">{machine.nickname}</span>}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-6">

          {/* Identity card */}
          <div className="flex items-center gap-3 p-3 bg-slate-700/50 rounded-lg">
            <div className="relative w-12 h-12 bg-slate-700 rounded-lg flex items-center justify-center text-slate-300 flex-shrink-0">
              <MachineIcon className="w-6 h-6" />
              <span
                className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-800 ${
                  isOnline ? 'bg-green-500' : 'bg-slate-500'
                }`}
                aria-label={isOnline ? 'Online' : 'Offline'}
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-medium text-white truncate">{machine.nickname}</p>
              <p className="text-xs text-slate-400 font-mono truncate">{machine.agentId}</p>
            </div>
          </div>

          {/* CLI Agent section — moved here from the in-session settings drawer
              so version checks live with the rest of the per-machine UI. */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              CLI Agent
            </h3>

            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-300"><FormattedMessage id="machineInfo.cliAgent.version" /></p>
              <span className="text-sm font-mono text-slate-400">
                {agentVersion || (isOnline ? 'unknown' : 'offline')}{devBuild && isOnline ? ' (dev)' : ''}
              </span>
            </div>

            {!isOnline && (
              <p className="text-xs text-slate-500">
                Connect to this machine to check or update the agent.
              </p>
            )}

            {isOnline && devBuild && (
              <div className="space-y-2">
                {restartResult && (
                  <div className={`p-2 rounded text-sm ${
                    restartResult.success
                      ? 'bg-green-500/20 border border-green-500/50 text-green-400'
                      : 'bg-red-500/20 border border-red-500/50 text-red-400'
                  }`}>
                    {restartResult.message}
                  </div>
                )}
                <button
                  onClick={async () => {
                    if (!onRestartAgent) return;
                    setIsRestarting(true);
                    setRestartResult(null);
                    try {
                      const result = await onRestartAgent();
                      if (result.success) {
                        setRestartResult({ success: true, message: 'Agent is restarting...' });
                      } else {
                        setRestartResult({ success: false, message: result.error || 'Restart failed' });
                      }
                    } catch (err) {
                      setRestartResult({ success: false, message: err instanceof Error ? err.message : 'Restart failed' });
                    } finally {
                      setIsRestarting(false);
                    }
                  }}
                  disabled={isRestarting || !onRestartAgent}
                  className="w-full py-2 px-4 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
                >
                  {isRestarting ? (
                    <>
                      <Spinner color="border-white" />
                      Restarting...
                    </>
                  ) : (
                    'Restart Agent'
                  )}
                </button>
              </div>
            )}

            {isOnline && !devBuild && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-300"><FormattedMessage id="machineInfo.cliAgent.latest" /></p>
                  <span className="text-sm font-mono text-slate-400 flex items-center gap-2">
                    {isCheckingUpdate ? (
                      <Spinner size="w-3 h-3" />
                    ) : (
                      latestVersion || '—'
                    )}
                    {onCheckAgentUpdate && !isCheckingUpdate && (
                      <button
                        onClick={async () => {
                          setIsCheckingUpdate(true);
                          try {
                            const result = await onCheckAgentUpdate();
                            if (result.latestVersion) setLatestVersion(result.latestVersion);
                          } finally {
                            setIsCheckingUpdate(false);
                          }
                        }}
                        className="p-0.5 hover:bg-slate-600 rounded transition-colors"
                        aria-label="Check for updates"
                        title="Check for updates"
                      >
                        <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                    )}
                  </span>
                </div>

                {latestVersion && agentVersion && latestVersion !== agentVersion && (
                  <div className="p-2 bg-amber-500/20 border border-amber-500/50 rounded text-sm text-amber-400">
                    New version available: {latestVersion}
                  </div>
                )}

                {latestVersion && agentVersion && latestVersion === agentVersion && !updateResult && (
                  <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
                    Already up to date
                  </div>
                )}

                {updateResult && (
                  <div className={`p-2 rounded text-sm ${
                    updateResult.success
                      ? 'bg-green-500/20 border border-green-500/50 text-green-400'
                      : 'bg-red-500/20 border border-red-500/50 text-red-400'
                  }`}>
                    {updateResult.message}
                  </div>
                )}

                <button
                  onClick={async () => {
                    if (!onUpdateAgent) return;
                    setIsUpdating(true);
                    setUpdateResult(null);
                    try {
                      const result = await onUpdateAgent();
                      if (result.success) {
                        const msg = result.restarting
                          ? `Updated: ${result.previousVersion} → ${result.newVersion}. Agent is restarting...`
                          : `Already on the latest version (${result.previousVersion}).`;
                        setUpdateResult({ success: true, message: msg });
                        if (result.newVersion) setLatestVersion(result.newVersion);
                      } else {
                        setUpdateResult({ success: false, message: result.error || 'Update failed' });
                      }
                    } catch (err) {
                      setUpdateResult({ success: false, message: err instanceof Error ? err.message : 'Update failed' });
                    } finally {
                      setIsUpdating(false);
                    }
                  }}
                  disabled={isUpdating || !onUpdateAgent || (!!latestVersion && latestVersion === agentVersion)}
                  className="w-full py-2 px-4 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
                >
                  {isUpdating ? (
                    <>
                      <Spinner color="border-white" />
                      Updating...
                    </>
                  ) : (
                    'Update Agent'
                  )}
                </button>
              </>
            )}
          </div>

          {/* Projects section — lists the projects/cwds that exist on this
              machine, navigable to the project detail page. */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                <FormattedMessage id="machineInfo.projects.title" />
              </h3>
              {canDelete && machineProjects.length > 0 && (
                <button
                  type="button"
                  onClick={() => setEditMode((v) => !v)}
                  className="text-xs font-medium text-slate-300 hover:text-white transition-colors"
                >
                  {editMode ? (
                    <FormattedMessage id="common.done" defaultMessage="Done" />
                  ) : (
                    <FormattedMessage id="common.edit" defaultMessage="Edit" />
                  )}
                </button>
              )}
            </div>

            {machineProjects.length === 0 ? (
              <p className="text-xs text-slate-500">
                <FormattedMessage id="machineInfo.projects.empty" />
              </p>
            ) : (
              <div className="divide-y divide-slate-700/40 rounded-lg bg-slate-700/30 overflow-hidden">
                {machineProjects.map((project) => {
                  const inner = (
                    <>
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${project.isConnected ? 'bg-emerald-400' : 'bg-slate-500'}`}
                      />
                      <div className="flex-1 min-w-0 text-[12px] text-slate-300 font-mono break-all">
                        {project.cwd}
                      </div>
                      {project.sessionCount > 0 && !editMode && (
                        <span className="text-[11px] text-slate-400 shrink-0">
                          <FormattedMessage
                            id="machineInfo.projects.sessionCount"
                            values={{ count: project.sessionCount }}
                          />
                        </span>
                      )}
                    </>
                  );

                  if (editMode) {
                    return (
                      <div
                        key={project.projectId}
                        className="w-full flex items-center gap-3 px-3 py-2.5"
                      >
                        {inner}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => setPendingDelete({ cwd: project.cwd, displayName: project.displayName })}
                            className="p-1.5 rounded-md text-red-400 hover:bg-red-500/15 transition-colors shrink-0"
                            aria-label="Delete project"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  }

                  return (
                    <button
                      key={project.projectId}
                      type="button"
                      onClick={() => navigate(`/settings/m/${agentId}/p/${project.projectId}/archived`)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-700/50 transition-colors text-left"
                      aria-label={`Restore archived tasks for ${project.cwd}`}
                    >
                      {inner}
                      <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {pendingDelete && (
        <ConfirmModal
          title={<FormattedMessage id="projectDetail.delete.title" />}
          message={
            <FormattedMessage
              id="projectDetail.delete.message"
              values={{ name: pendingDelete.displayName }}
            />
          }
          confirmLabel={<FormattedMessage id="projectDetail.delete.confirmLabel" />}
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
