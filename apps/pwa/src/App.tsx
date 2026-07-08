// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { HashRouter, Routes, Route, useNavigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import { useConnectionStore } from './stores/connectionStore';
import { useClaudeStore } from './stores/claudeStore';
import { useGitStore } from './stores/gitStore';
import { useMachineStore } from './stores/machineStore';
import { useIdentityStore } from './stores/identityStore';
import { useGitOperations } from './hooks/useGitOperations';
import { useClaudeOperations } from './hooks/useClaudeOperations';
import { useSessionAttention } from './hooks/useSessionAttention';
import { WebSocketClient } from './lib/websocket';
import { BusClientTransport } from './lib/busClientTransport';
import { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { ConnectionSetup } from './components/ConnectionSetup';
import { ConnectingOverlay, ConnectingStages } from './components/ConnectingOverlay';
import { FleetStatusBar } from './components/FleetStatusBar';
import { SessionAppBar } from './components/SessionAppBar';
import { NewSessionAppBar } from './components/NewSessionAppBar';
import { RepoView } from './components/RepoView';
import { BaseStatusBar, BackButton } from './components/BaseStatusBar';
import { Spinner } from './components/ui/Spinner';
import { PathBrowser } from './components/PathBrowser';
import { GitignoreEditor } from './components/GitignoreEditor';
import { ClaudePanel } from './components/ClaudePanel';
import {
  type ClaudePreferences,
  type ClaudeUserInputResponsePayload,
  type CodexLoginState,
  type CodexModelInfo,
  type CommitSummaryState,
  type ConfigValue,
  type SessionConfigUpdatedPayload,
  type SessionHistoryUpdatedPayload,
  type BroadcastSessionEntry,
  type SessionUpdatePayload,
  type TerminalSummary,
  type TerminalsUpdate,
} from '@sumicom/quicksave-shared';
import { useCodexLoginStore } from './stores/codexLoginStore';
import { useTerminalStore } from './stores/terminalStore';
import { registerActiveBusGetter, registerAgentBusGetter } from './lib/busRegistry';
import { registerWsRetry } from './lib/wsRetryRegistry';
import { applySessionUpdate } from './lib/applySessionUpdate';
import { applyHistoryEntry, applyHistoryAction } from './lib/applyHistoryEntry';
import { GitIdentityModal } from './components/GitIdentityModal';
import { SettingsPage } from './components/SettingsPage';
import { MachineInfoPage } from './components/MachineInfoPage';
import { ArchivedSessionsPage } from './components/ArchivedSessionsPage';
import { AddNewPage } from './components/AddNewPage';
import { JoinGroupPage } from './routes/JoinGroupPage';
import { ProjectList } from './components/ProjectList';
import { ProjectDetail } from './components/ProjectDetail';
import { TerminalPage } from './components/terminal/TerminalPage';
import { FileBrowserPage } from './components/files/FileBrowserPage';
import { FilePreviewModal } from './components/files/FilePreviewModal';
import { useFilePreviewStore } from './stores/filePreviewStore';
import { useProjectConnection } from './hooks/useProjectConnection';
import { resolveHash, getAllKnownPaths } from './lib/pathHash';
import {
  getApiKey,
  getMasterSecretExport,
  getApiKeyExport,
  applyMasterSecret,
  applyApiKey,
} from './lib/secureStorage';
import { SyncClient } from './lib/syncClient';
import { mergeSyncPayloads, syncPayloadsEqual, type SyncPayloadV3 } from './lib/syncMerge';
import { useMediaQuery } from './hooks/useMediaQuery';

/**
 * Subscribe one agent's bus to all agent-pushed state paths. Snapshots
 * deliver the current value atomically on the sub frame (covering the
 * reconnect / key-exchange race window); subsequent publishes arrive as
 * `onUpdate`.
 *
 * Called once per agent when that agent's bus is lazily created. In
 * multi-agent mode each agent gets its own bus so subscriptions fan out
 * correctly (the shared transport would only have reached whichever
 * agent was active at subscribe time).
 *
 * `agentId` is captured so handlers can tag records with the originating
 * machine — critical for filtering sessions by project (the same cwd
 * string on two different machines must not collide).
 */
function subscribeAllPaths(bus: MessageBusClient, agentId: string): void {
  bus.subscribe<SessionUpdatePayload[], SessionUpdatePayload>('/sessions/active', {
    onSnapshot: (sessions) => {
      // The snap is authoritative for THIS agent — any session the store
      // has marked isActive=true for this agent that is NOT in the snap
      // must be demoted, otherwise a stale green badge survives reconnect.
      const liveIds = new Set(sessions.map((s) => s.sessionId));
      useClaudeStore.getState().reconcileActiveSessions(liveIds, agentId);
      for (const s of sessions) applySessionUpdate(s, agentId);
    },
    onUpdate: (session) => applySessionUpdate(session, agentId),
    onError: (err) => console.warn('[bus] /sessions/active error:', err),
  });

  bus.subscribe<ClaudePreferences, ClaudePreferences>('/preferences', {
    onSnapshot: (prefs) => applyPreferencesToStore(prefs),
    onUpdate: (prefs) => applyPreferencesToStore(prefs),
    onError: (err) => console.warn('[bus] /preferences error:', err),
  });

  bus.subscribe<BroadcastSessionEntry[], SessionHistoryUpdatedPayload>('/sessions/history', {
    onSnapshot: (entries) => {
      for (const entry of entries) applyHistoryEntry(entry, agentId);
    },
    onUpdate: (payload) => applyHistoryAction(payload, agentId),
    onError: (err) => console.warn('[bus] /sessions/history error:', err),
  });

  bus.subscribe<CommitSummaryState[], CommitSummaryState>('/repos/commit-summary', {
    onSnapshot: (states) => {
      for (const state of states) applyCommitSummary(state);
    },
    onUpdate: (state) => applyCommitSummary(state),
    onError: (err) => console.warn('[bus] /repos/commit-summary error:', err),
  });

  bus.subscribe<Record<string, Record<string, ConfigValue>>, SessionConfigUpdatedPayload>('/sessions/config', {
    onSnapshot: (all) => {
      for (const [sessionId, config] of Object.entries(all)) {
        useClaudeStore.getState().applySessionConfig(sessionId, config);
      }
    },
    onUpdate: ({ sessionId, config }) => useClaudeStore.getState().applySessionConfig(sessionId, config),
    onError: (err) => console.warn('[bus] /sessions/config error:', err),
  });

  bus.subscribe<CodexLoginState, CodexLoginState>('/codex/login', {
    onSnapshot: (state) => useCodexLoginStore.getState().set(agentId, state),
    onUpdate: (state) => useCodexLoginStore.getState().set(agentId, state),
    onError: (err) => console.warn('[bus] /codex/login error:', err),
  });

  // Live local Codex model list. Daemon's fs.watch on ~/.codex/models_cache.json
  // pushes here whenever the codex CLI updates its cache (binary upgrade,
  // first login, etc.) — keeps the picker fresh without re-issuing the
  // command. Empty snapshots are skipped so we don't clobber a previously
  // populated list during a transient daemon-side load.
  bus.subscribe<CodexModelInfo[], CodexModelInfo[]>('/codex/models', {
    onSnapshot: (models) => {
      if (models.length > 0) useConnectionStore.getState().setCodexModels(models);
    },
    onUpdate: (models) => {
      if (models.length > 0) useConnectionStore.getState().setCodexModels(models);
    },
    onError: (err) => console.warn('[bus] /codex/models error:', err),
  });

  bus.subscribe<TerminalSummary[], TerminalsUpdate>('/terminals', {
    onSnapshot: (list) => useTerminalStore.getState().applySnapshot(agentId, list),
    onUpdate: (upd) => {
      const store = useTerminalStore.getState();
      if (upd.kind === 'upsert') store.upsert(agentId, upd.terminal);
      else store.remove(agentId, upd.terminalId);
    },
    onError: (err) => console.warn('[bus] /terminals error:', err),
  });
}

function applyPreferencesToStore(prefs: ClaudePreferences): void {
  // Server prefs are claude-scoped; write to claude-code's bucket directly
  // (see useClaudeOperations.applyPreferences for the same reasoning).
  const { setAgentPref } = useClaudeStore.getState();
  if (prefs.model !== undefined) setAgentPref('claude-code', 'model', prefs.model);
  if (prefs.reasoningEffort !== undefined) setAgentPref('claude-code', 'reasoningEffort', prefs.reasoningEffort);
}

function applyCommitSummary(state: CommitSummaryState): void {
  // gitStore filters by currentRepoPath, so cross-repo chatter is ignored.
  useGitStore.getState().applyCommitSummaryState(state);
}

interface AgentBus {
  transport: BusClientTransport;
  bus: MessageBusClient;
}

function AppContent() {
  const clientRef = useRef<WebSocketClient | null>(null);
  // One MessageBus per connected agent. Each bus owns its own subscriptions
  // so `/sessions/history` etc. reach every agent, not just whichever one
  // was active when the shared bus first subscribed. Commands route via
  // `sendToAgent(agentId, …)` so they reach the right peer regardless of
  // the client's shared activeAgentId.
  const busesRef = useRef<Map<string, AgentBus>>(new Map());
  const navigate = useNavigate();
  const location = useLocation();
  const intentionalDisconnectRef = useRef(false);
  const {
    state,
    repoPath,
    signalingServer,
    pendingRepoPath,
    setConnecting,
    setSignaling,
    setConnected,
    setDisconnected,
    setReconnecting,
    setError,
    setPendingRepoPath,
    setConnectionStep,
    setAgentOnline,
    reset,
  } = useConnectionStore();

  const { reset: resetGit, setCurrentRepoPath } = useGitStore();
  const { machines, recordConnection } = useMachineStore();
  const machineTombstones = useMachineStore((s) => s.machineTombstones);
  const applySyncedState = useMachineStore((s) => s.applySyncedState);
  const { initialize: initIdentity, publicKey: identityPublicKey, getSecretKey, getSigningSecretKey, getSigningPublicKey, clearAll: clearIdentity, initialized: identityInitialized } = useIdentityStore();
  const agentIdRef = useRef<string | null>(null);

  // Resolve the MessageBus for whichever agent the client currently treats
  // as active. Commands flow through the active agent's bus; sends inside
  // BusClientTransport target that agent explicitly, so re-activating during
  // a multi-agent session won't misroute an in-flight command.
  const getActiveBus = useCallback((): MessageBusClient | null => {
    const aid = clientRef.current?.getActiveAgentId();
    if (!aid) return null;
    return busesRef.current.get(aid)?.bus ?? null;
  }, []);

  // Register the active-bus getter for hooks (e.g. useCodexLogin) that live
  // too deep to receive it via props. See lib/busRegistry.ts.
  useEffect(() => {
    registerActiveBusGetter(getActiveBus);
    registerAgentBusGetter((agentId) => busesRef.current.get(agentId)?.bus ?? null);
  }, [getActiveBus]);

  // Lazily create the per-agent bus + transport and register its
  // subscriptions. Called on each agent's handshake:ack; idempotent so
  // reconnects reuse the same bus (preserves the subscription cache and
  // pending-command queue).
  const ensureBusForAgent = useCallback((agentId: string): AgentBus => {
    const client = clientRef.current;
    if (!client) throw new Error('ensureBusForAgent: no WebSocketClient');
    const existing = busesRef.current.get(agentId);
    if (existing) return existing;
    const transport = new BusClientTransport(client, agentId);
    const bus = new MessageBusClient(transport);
    const entry: AgentBus = { transport, bus };
    busesRef.current.set(agentId, entry);
    subscribeAllPaths(bus, agentId);
    if (typeof window !== 'undefined') {
      ((window as unknown) as { __buses?: Map<string, AgentBus> }).__buses = busesRef.current;
    }
    return entry;
  }, []);

  const {
    cancelPendingGit,
    fetchStatus,
    fetchDiff,
    stageFiles,
    unstageFiles,
    stagePatch,
    unstagePatch,
    commit,
    discardChanges,
    untrackFiles,
    addToGitignore,
    readGitignore,
    writeGitignore,
    generateCommitSummary,
    dismissAiSummary,
    applyAiSuggestion,
    setApiKey,
    checkApiKeyStatus,
    switchRepo,
    browseDirectory,
    addRepo,
    cloneRepo,
    addCodingPath,
    getGitIdentity,
    setGitIdentity,
    checkAgentUpdate,
    updateAgent,
    restartAgent,
    getSystemdStatus,
    installSystemdUnit,
    uninstallSystemdUnit,
  } = useGitOperations(clientRef, getActiveBus);

  /**
   * Switch the active agent and drop any in-flight git:* responses for the
   * previous agent. Without the cancel, a late status/diff response from the
   * old agent would overwrite the gitStore right after the user navigates
   * to a different workspace.
   *
   * Also rehydrate the single-agent mirror (`useConnectionStore.repoPath` /
   * `availableRepos`) from the newly active agent's per-agent state. Without
   * this, the mirror keeps showing whichever agent last handshaked — after
   * a multi-agent reconnect on resume that can be a different machine than
   * the one the user is viewing.
   */
  const setActiveAgent = useCallback((agentId: string) => {
    cancelPendingGit();
    clientRef.current?.setActiveAgent(agentId);
    const connState = useConnectionStore.getState();
    const perAgent = connState.agentConnections[agentId];
    if (perAgent?.state === 'connected') {
      connState.setConnected(
        perAgent.repoPath ?? '',
        perAgent.isPro,
        perAgent.availableRepos,
        perAgent.availableCodingPaths,
        perAgent.agentVersion ?? undefined,
        connState.latestVersion ?? undefined,
      );
      useGitStore.getState().setCurrentRepoPath(perAgent.repoPath);
    }
  }, [cancelPendingGit]);

  const {
    getSessionCards,
    startSession,
    resumeSession,
    cancelSession,
    closeSession,
    endSession,
    restoreSession,
    markSessionRead,
    listArchivedSessions,
    respondToUserInput,
    setSessionConfig,
    sendControlRequest,
    unsubscribeSession,
    listProjectSummaries,
    listProjectRepos,
    deleteProject,
  } = useClaudeOperations(getActiveBus);

  const [showPathBrowser, setShowPathBrowser] = useState(false);
  const [showGitignoreEditor, setShowGitignoreEditor] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const filePreviewOpen = useFilePreviewStore((s) => s.current != null);
  const filePreviewPanelWidth = useFilePreviewStore((s) => s.panelWidth);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [showGitIdentityModal, setShowGitIdentityModal] = useState(false);


  // Prevent body bounce scroll
  useEffect(() => {
    const prevent = (e: TouchEvent) => {
      if (e.target === document.body || e.target === document.documentElement) {
        e.preventDefault();
      }
    };
    document.addEventListener('touchmove', prevent, { passive: false });
    return () => document.removeEventListener('touchmove', prevent);
  }, []);

  // Initialize identity store (persistent X25519 keypair) on startup
  useEffect(() => {
    initIdentity();
  }, [initIdentity]);

  const syncClient = useMemo(() => new SyncClient(signalingServer), [signalingServer]);

  const buildLocalPayload = useCallback(async (): Promise<SyncPayloadV3> => {
    const s = useMachineStore.getState();
    return {
      version: 3,
      masterSecret: await getMasterSecretExport(),
      apiKey: await getApiKeyExport(),
      machines: s.machines,
      machineTombstones: s.machineTombstones,
      exportedAt: new Date().toISOString(),
    };
  }, []);

  // Pull the shared group mailbox on startup (address = hash(groupPubkey)).
  // All PWAs that share `masterSecret` derive the same pubkey, so we read
  // and write to one mailbox — no per-device fan-out.
  useEffect(() => {
    if (!identityPublicKey || !identityInitialized) return;

    let cancelled = false;
    (async () => {
      try {
        const secretKey = await getSecretKey();
        if (!secretKey || cancelled) return;

        const result = await syncClient.fetchMyMailbox(identityPublicKey, secretKey);
        if (cancelled) return;

        if (result?.type === 'tombstone') {
          console.warn('Tombstone detected - wiping local data');
          await clearIdentity();
          return;
        }
        if (result?.type !== 'blob') return;

        const local = await buildLocalPayload();
        const merged = mergeSyncPayloads(local, result.payload);

        applySyncedState({
          machines: merged.machines,
          machineTombstones: merged.machineTombstones,
        });
        if (merged.masterSecret) {
          await applyMasterSecret(merged.masterSecret.value, merged.masterSecret.updatedAt);
        }
        if (merged.apiKey) {
          await applyApiKey(merged.apiKey.value, merged.apiKey.updatedAt);
        }

        // If the merge widened our view beyond the remote blob we read,
        // write it back so the next reader sees the union.
        if (!syncPayloadsEqual(merged, result.payload)) {
          const signingSecret = await getSigningSecretKey();
          const signingPublic = await getSigningPublicKey();
          if (!signingSecret || !signingPublic) return;
          try {
            await syncClient.pushToMailbox(merged, identityPublicKey, {
              publicKey: signingPublic,
              secretKey: signingSecret,
            });
          } catch (error) {
            console.error('Re-push to shared mailbox failed:', error);
          }
        }
      } catch (error) {
        console.error('Failed to check sync mailbox:', error);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityPublicKey, identityInitialized]);

  // Push to the shared group mailbox whenever local synced state changes.
  const lastPushedRef = useRef<SyncPayloadV3 | null>(null);
  useEffect(() => {
    if (!identityPublicKey) return;

    let cancelled = false;
    (async () => {
      try {
        const payload = await buildLocalPayload();
        if (lastPushedRef.current && syncPayloadsEqual(lastPushedRef.current, payload)) {
          return;
        }
        lastPushedRef.current = payload;

        const signingSecret = await getSigningSecretKey();
        const signingPublic = await getSigningPublicKey();
        if (!signingSecret || !signingPublic) return;
        if (cancelled) return;

        try {
          await syncClient.pushToMailbox(payload, identityPublicKey, {
            publicKey: signingPublic,
            secretKey: signingSecret,
          });
        } catch (error) {
          console.error('Failed to push to shared mailbox:', error);
        }
      } catch (error) {
        console.error('Failed to build sync payload:', error);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines, machineTombstones, identityPublicKey]);

  // Track current location for reconnect-safe navigation
  const locationRef = useRef(location);
  useEffect(() => { locationRef.current = location; });

  // Stable callback refs to avoid recreating the client on every render
  const handlersRef = useRef({
    setConnected,
    setCurrentRepoPath,
    recordConnection,
    navigate,
    setDisconnected,
    setReconnecting,
    setError,
    setConnectionStep,
    setAgentOnline,
    setActiveAgent,
  });
  useEffect(() => {
    handlersRef.current = {
      setConnected,
      setCurrentRepoPath,
      recordConnection,
      navigate,
      setDisconnected,
      setReconnecting,
      setError,
      setConnectionStep,
      setAgentOnline,
      setActiveAgent,
    };
  });

  // Create WebSocketClient once when identity is ready.
  // Preserve the client across Vite HMR updates so we don't destroy the
  // WebSocket connection (and cause a black screen) every time a file changes.
  useEffect(() => {
    if (!identityPublicKey) return;

    // Recover a surviving client from a previous HMR cycle
    const hot = (import.meta as any).hot as import('vite/types/hot.d.ts').ViteHotContext | undefined;
    const hmrClient = hot?.data?.wsClient as WebSocketClient | undefined;

    if (hmrClient) {
      // Reuse the existing connected client. Rebuild a per-agent bus for
      // every agent the client already has a session with — the client has
      // survived HMR but the bus instances have not, so their subscriptions
      // need to be re-registered. Each transport is marked connected
      // immediately since the underlying agent link is already past
      // key-exchange (onConnected won't fire again on HMR reuse).
      clientRef.current = hmrClient;
      for (const connectedAgentId of hmrClient.getConnectedAgentIds()) {
        const { transport } = ensureBusForAgent(connectedAgentId);
        transport.notifyConnected();
      }
      registerWsRetry(() => hmrClient.retryReconnect());
      if (typeof window !== 'undefined') {
        (window as unknown as { __wsClient?: WebSocketClient }).__wsClient = hmrClient;
      }
      return;
    }

    if (clientRef.current) return;

    const client = new WebSocketClient(signalingServer, identityPublicKey, {
      onConnected: (agentId, path, pro, availableRepos, availableCodingPaths, preferences, agentVersion, latestVersion, devBuild, codexModels, platform) => {
        const { transport } = ensureBusForAgent(agentId);
        transport.notifyConnected();
        // Each handshake-ack establishes a fresh agent session and the agent
        // wipes the peer's bus subscriptions on disconnect, so every link
        // refresh — including reconnects where notifyDisconnected was
        // intentionally suppressed to keep streaming UI alive — must re-send
        // sub frames. notifyConnected is a no-op when already-connected;
        // notifyReestablished is what drives sub re-send on those blips.
        transport.notifyReestablished();
        agentIdRef.current = agentId;
        if (preferences) {
          // Server prefs are claude-scoped — write to claude-code's bucket
          // so codex prefs aren't clobbered when the user is on Codex.
          useClaudeStore.getState().setAgentPref('claude-code', 'model', preferences.model);
        }
        if (codexModels?.length) {
          useConnectionStore.getState().setCodexModels(codexModels);
        }
        // Update the single-agent mirror only when this agent is the one
        // the client treats as active (or no active has been chosen yet).
        // Without this gate, two machines reconnecting in parallel after a
        // PWA resume race to overwrite repoPath/availableRepos with
        // whichever handshake lands last, leaving UI bound to the wrong
        // machine and subsequent switch-repo hitting the wrong agent.
        const currentActive = clientRef.current?.getActiveAgentId() ?? null;
        if (!currentActive || currentActive === agentId) {
          handlersRef.current.setConnected(path, pro, availableRepos, availableCodingPaths, agentVersion, latestVersion);
          handlersRef.current.setCurrentRepoPath(path);
        }
        // Update multi-agent connection map (authoritative per-agent state)
        useConnectionStore.getState().setAgentConnected(agentId, path, pro, availableRepos, availableCodingPaths, agentVersion, devBuild, platform);
        const repoPaths = availableRepos?.map((r) => r.path);
        const codingPaths = availableCodingPaths?.map((p) => p.path);
        handlersRef.current.recordConnection(agentId, path, pro, repoPaths, codingPaths);
        // Session reconciliation is driven by the `/sessions/active` bus
        // snap (in `subscribeAllPaths`): its `onSnapshot` calls
        // `reconcileActiveSessions(liveIds)` with the authoritative live
        // list atomically, so no delayed command-based fallback is needed.
        // The `/repos/commit-summary` snap similarly hydrates any pending
        // AI commit summary state.

        // Project route components (/p/) manage their own navigation after connection.
        // No need to navigate on connect — the home page and project routes handle it.
      },
      onDisconnected: (disconnectedAgentId) => {
        if (disconnectedAgentId) {
          busesRef.current.get(disconnectedAgentId)?.transport.notifyDisconnected();
          useConnectionStore.getState().setAgentDisconnected(disconnectedAgentId);
        } else {
          // Blanket disconnect (WebSocket itself dropped) — flag every bus.
          for (const { transport } of busesRef.current.values()) transport.notifyDisconnected();
        }
        handlersRef.current.setDisconnected();
        // Demote any isActive=true sessions to closed. We can't trust the
        // pre-disconnect snapshot across the blip, and letting stale green
        // badges persist causes a "flash green then gray" on reconnect when
        // the fresh /sessions/active snap finally corrects them.
        useClaudeStore.getState().clearActiveOnDisconnect();
      },
      onReconnecting: (attempt, maxAttempts) => {
        if (!intentionalDisconnectRef.current) {
          handlersRef.current.setReconnecting(attempt, maxAttempts);
        }
      },
      onMessage: (message, fromAgentId) => {
        // With the command/pubsub migration complete, all responses flow
        // through the bus. Each agent has its own bus; route the frame to
        // the matching transport so subscriptions stay isolated per peer.
        busesRef.current.get(fromAgentId)?.transport.notifyMessage(message, fromAgentId);
      },
      onError: (error) => {
        // Don't show errors during intentional disconnect
        if (!intentionalDisconnectRef.current) {
          handlersRef.current.setError(error.message);
        }
      },
      onConnectionStep: (step, attempt) => {
        handlersRef.current.setConnectionStep(step, attempt);
      },
      onAgentStatus: (agentId, online) => {
        handlersRef.current.setAgentOnline(online);
        useConnectionStore.getState().setAgentOnlineFor(agentId, online);
        // Keep the bus transport's connected state in sync with the agent's
        // session. Without this, a command issued while the agent is offline
        // hits a dead socket and waits out its 10–30s timeout instead of
        // queuing for reconnect; the next onConnected (handshake:ack) will
        // flush the queue.
        if (!online) {
          busesRef.current.get(agentId)?.transport.notifyDisconnected();
        }
      },
    },
    // Signing keypair provider for V2 key-exchange TOFU on the agent side.
    // Returns null if the identity store hasn't finished initializing, and
    // the client will retry on its own backoff schedule.
    async () => {
      try {
        const secretKey = await getSigningSecretKey();
        const publicKey = await getSigningPublicKey();
        if (!secretKey || !publicKey) return null;
        return { publicKey, secretKey };
      } catch (err) {
        console.error('Failed to load signing keypair for key-exchange:', err);
        return null;
      }
    });

    clientRef.current = client;
    // Per-agent buses are created lazily in `onConnected`; nothing to wire
    // up at client-creation time beyond the client itself.
    registerWsRetry(() => client.retryReconnect());
    if (typeof window !== 'undefined') {
      (window as unknown as { __wsClient?: WebSocketClient }).__wsClient = client;
      (window as unknown as { __buses?: Map<string, AgentBus> }).__buses = busesRef.current;
    }

    client.connect().catch((error) => {
      console.error('Failed to connect WebSocket:', error);
      handlersRef.current.setError('Failed to connect to signaling server');
    });

    return () => {
      // During HMR, stash the client so the next module instance can reuse it.
      // The per-agent bus map is NOT stashed — it holds references to the
      // MessageBusClient pending/subscription state that the new module will
      // rebuild by replaying subscribeAllPaths per connected agent.
      if (hot) {
        hot.data.wsClient = client;
      } else {
        client.disconnect();
      }
      clientRef.current = null;
      busesRef.current.clear();
    };
  }, [identityPublicKey, signalingServer, ensureBusForAgent]);

  const handleConnect = useCallback(
    async (newAgentId: string, publicKey: string) => {
      // Skip if already connected or connecting to this agent
      if (clientRef.current?.hasSession(newAgentId)) {
        // Already connected — just set as active
        setActiveAgent(newAgentId);
        agentIdRef.current = newAgentId;
        return;
      }

      agentIdRef.current = newAgentId;
      setConnecting(newAgentId);
      useConnectionStore.getState().setAgentConnecting(newAgentId);

      if (!clientRef.current) {
        setError('WebSocket not connected yet');
        return;
      }

      setSignaling();
      clientRef.current.connectToAgent(newAgentId, publicKey);
    },
    [setConnecting, setSignaling, setError, setActiveAgent]
  );

  const handleAbortConnection = useCallback(() => {
    if (clientRef.current) {
      if (agentIdRef.current) {
        clientRef.current.disconnectFromAgent(agentIdRef.current);
      }
      clientRef.current.stopReconnecting();
    }
    agentIdRef.current = null;
    reset();
    resetGit();
    navigate('/', { replace: true });
  }, [reset, resetGit, navigate]);

  const handleRetryConnection = useCallback(() => {
    const currentAgentId = agentIdRef.current;
    if (!currentAgentId) return;

    if (clientRef.current) {
      clientRef.current.disconnectFromAgent(currentAgentId);
    }
    reset();

    const machine = useMachineStore.getState().getMachine(currentAgentId);
    if (machine) {
      handleConnect(currentAgentId, machine.publicKey);
    }
  }, [reset, handleConnect]);

  const handleSwitchMachine = useCallback((targetAgentId: string) => {
    // In multi-agent mode, we keep existing connections alive and just add the new one
    const machine = useMachineStore.getState().getMachine(targetAgentId);
    if (machine) {
      handleConnect(targetAgentId, machine.publicKey);
    } else {
      navigate('/', { replace: true });
    }
  }, [navigate, handleConnect]);

  // Fetch status and sync API key when connected
  useEffect(() => {
    if (state === 'connected') {
      fetchStatus();
      // Send locally stored API key to agent if available
      getApiKey().then((storedKey) => {
        if (storedKey) {
          setApiKey(storedKey);
        }
      });
      checkApiKeyStatus();
    }
  }, [state, fetchStatus, checkApiKeyStatus, setApiKey]);

  // Switch to pending repo after connection if different from current
  useEffect(() => {
    if (state === 'connected' && pendingRepoPath && pendingRepoPath !== repoPath) {
      // Clear pending first to prevent re-triggering
      setPendingRepoPath(null);
      // Switch to the requested repo
      switchRepo(pendingRepoPath);
    }
  }, [state, pendingRepoPath, repoPath, setPendingRepoPath, switchRepo]);

  // Clean up on unmount (but not during HMR — the main effect handles that)
  useEffect(() => {
    return () => {
      const hot = (import.meta as any).hot as import('vite/types/hot.d.ts').ViteHotContext | undefined;
      if (hot) return; // HMR: let the main effect stash the client
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      agentIdRef.current = null;
    };
  }, []);

  const isConnected = state === 'connected';

  // Auto-connect to ALL known machines on startup
  const autoConnectAllRef = useRef(false);
  useEffect(() => {
    if (autoConnectAllRef.current) return;
    if (!clientRef.current) return;
    if (intentionalDisconnectRef.current) return;
    autoConnectAllRef.current = true;

    const allMachines = useMachineStore.getState().machines;
    for (const machine of allMachines) {
      // handleConnect will skip if already connected
      handleConnect(machine.agentId, machine.publicKey);
    }
  }, [handleConnect, identityPublicKey]);

  // Fetch project summaries + session lists from each agent as they connect
  const fetchedSummariesRef = useRef<Set<string>>(new Set());
  const agentConnections = useConnectionStore((s) => s.agentConnections);
  useEffect(() => {
    for (const [agentId, conn] of Object.entries(agentConnections)) {
      if (conn.state === 'connected' && !fetchedSummariesRef.current.has(agentId)) {
        fetchedSummariesRef.current.add(agentId);
        // Set active agent to route requests to this agent
        setActiveAgent(agentId);
        listProjectSummaries().then((projects) => {
          if (!projects) return;
          // Cache project summaries and prune stale knownCodingPaths
          const agentConn = useConnectionStore.getState().agentConnections[agentId];
          const managedPaths = agentConn?.availableCodingPaths?.map((p) => p.path);
          useMachineStore.getState().cacheAllProjects(agentId, projects, managedPaths);
        });
      }
    }
  }, [agentConnections, listProjectSummaries, setActiveAgent]);

  // Show connecting overlay only for /connect routes (QR/deep link) — not for project routes
  const showOverlay = !location.pathname.startsWith('/p/') && (
    state === 'connecting' || state === 'reconnecting' || (state === 'error' && !!useConnectionStore.getState().error)
  );

  // Delete project: archive all sessions under cwd + remove coding path on
  // agent, then refresh local summaries/managed paths so the home screen
  // drops the project immediately.
  const handleDeleteProject = useCallback(async (cwd: string) => {
    const result = await deleteProject(cwd);
    if (result?.success) {
      const connState = useConnectionStore.getState();
      connState.setAvailableCodingPaths(
        connState.availableCodingPaths.filter((cp) => cp.path !== cwd),
      );
      const projects = await listProjectSummaries();
      const agentId = clientRef.current?.getActiveAgentId() ?? null;
      if (projects && agentId) {
        const agentConn = useConnectionStore.getState().agentConnections[agentId];
        const managedPaths = (agentConn?.availableCodingPaths ?? [])
          .map((p) => p.path)
          .filter((p) => p !== cwd);
        useMachineStore.getState().cacheAllProjects(agentId, projects, managedPaths);
      }
    }
    return result;
  }, [deleteProject, listProjectSummaries]);

  const projectRepoElement = (
    <ProjectRouteRepo
      onConnect={handleConnect}
      onSwitchMachine={handleSwitchMachine}
      onSetActiveAgent={setActiveAgent}
      onSwitchRepo={switchRepo}
      onRefresh={fetchStatus}
      onFetchDiff={fetchDiff}
      onStage={stageFiles}
      onUnstage={unstageFiles}
      onStagePatch={stagePatch}
      onUnstagePatch={unstagePatch}
      onDiscard={discardChanges}
      onUntrack={untrackFiles}
      onAddToGitignore={addToGitignore}
      onCommit={async (msg, desc) => {
        try {
          await commit(msg, desc);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : '';
          if (errMsg.includes('empty ident') || errMsg.includes('Please tell me who you are')) {
            setShowGitIdentityModal(true);
          }
        }
      }}
      onGenerateAiSummary={generateCommitSummary}
      onApplyAiSuggestion={applyAiSuggestion}
      onDismissAiSummary={dismissAiSummary}
      onSetApiKey={setApiKey}
    />
  );

  const projectDetailElement = (
    <ProjectRouteDetail
      onConnect={handleConnect}
      onSwitchMachine={handleSwitchMachine}
      onListProjectRepos={listProjectRepos}
      onDeleteProject={handleDeleteProject}
      onRestartAgent={restartAgent}
      onListArchivedSessions={listArchivedSessions}
      onRestoreSession={restoreSession}
    />
  );

  const projectSessionElement = (
    <ProjectRouteSession
            onConnect={handleConnect}
            onSwitchMachine={handleSwitchMachine}
            showSettings={showAgentSettings}
            onOpenSettings={() => setShowAgentSettings(true)}
            onCloseSettings={() => setShowAgentSettings(false)}
            onSetSessionConfig={setSessionConfig}
            onSendControlRequest={sendControlRequest}
            onCloseSession={closeSession}
            onEndSession={endSession}
            onCancelSession={cancelSession}
            onGetSessionCards={getSessionCards}
            onStartSession={startSession}
            onResumeSession={resumeSession}
            onRespondToUserInput={respondToUserInput}
            onUnsubscribeSession={unsubscribeSession}
            onSetActiveAgent={setActiveAgent}
            onListProjectRepos={listProjectRepos}
            onMarkSessionRead={markSessionRead}
            getBus={getActiveBus}
  />
  );

  const homeElement = machines.length > 0 ? (
    <ProjectList
      onOpenSettings={() => navigate('/settings')}
      onOpenAddNew={() => navigate('/add')}
      onAddMachine={() => {/* TODO: wire add machine modal */}}
    />
  ) : (
    <div className="flex flex-col h-screen overflow-hidden">
      <FleetStatusBar title="Quicksave" onOpenSettings={() => navigate('/settings')} />
      <ConnectionSetup onConnect={handleConnect} />
    </div>
  );

  return (
    <div
      className="flex flex-col bg-slate-900 text-slate-100 overflow-hidden h-full transition-[padding] duration-200"
      style={isDesktop && filePreviewOpen ? { paddingRight: filePreviewPanelWidth } : undefined}
    >
      {isDesktop ? (
        machines.length === 0 ? (
          // Pre-pair: full-width connection setup, no sidebar yet.
          // Still wrap in Routes so /settings works from the gear icon.
          <Routes>
            <Route
              path="/settings"
              element={<SettingsPage onSendApiKeyToAgent={isConnected ? setApiKey : undefined} />}
            />
            <Route path="/pair" element={<JoinGroupPage />} />
            <Route
              path="*"
              element={
                <div className="flex flex-col h-full overflow-hidden">
                  <FleetStatusBar title="Quicksave" onOpenSettings={() => navigate('/settings')} />
                  <ConnectionSetup onConnect={handleConnect} />
                </div>
              }
            />
          </Routes>
        ) : (
          // Desktop: two-column layout — sidebar owns the home app bar, main area only renders project routes
          <div className="flex h-full overflow-hidden">
            <div className="w-72 shrink-0 border-r border-slate-700 bg-slate-800/50">
              <ProjectList compact onOpenSettings={() => navigate('/settings')} onOpenAddNew={() => navigate('/add')} />
            </div>
            <div className="flex-1 min-w-0 flex flex-col">
              <Routes>
                <Route path="/p/:projectId" element={projectDetailElement} />
                <Route path="/p/:projectId/s/:sessionId" element={projectSessionElement} />
                <Route path="/p/:projectId/r/:repoId" element={projectRepoElement} />
                <Route path="/p/:projectId/t/:terminalId" element={<TerminalPage />} />
                <Route path="/p/:projectId/files" element={<FileBrowserPage />} />
                <Route path="/p/:projectId/files/*" element={<FileBrowserPage />} />
                <Route path="/add" element={<AddNewPage onSetActiveAgent={setActiveAgent} onBrowseDirectory={browseDirectory} onCloneRepo={cloneRepo} onAddCodingPath={addCodingPath} onConnect={handleConnect} onStartSession={startSession} />} />
                <Route path="/settings" element={<SettingsPage onSendApiKeyToAgent={isConnected ? setApiKey : undefined} />} />
                <Route path="/settings/m/:agentId" element={<MachineInfoPage onSetActiveAgent={setActiveAgent} onCheckAgentUpdate={checkAgentUpdate} onUpdateAgent={updateAgent} onRestartAgent={restartAgent} onDeleteProject={handleDeleteProject} onGetSystemdStatus={getSystemdStatus} onInstallSystemdUnit={installSystemdUnit} onUninstallSystemdUnit={uninstallSystemdUnit} />} />
                <Route path="/settings/m/:agentId/p/:projectId/archived" element={<ArchivedSessionsPage onSetActiveAgent={setActiveAgent} onListArchivedSessions={listArchivedSessions} onRestoreSession={restoreSession} />} />
                <Route path="/connect/:agentId" element={<ConnectHandler onConnect={handleConnect} />} />
                <Route path="/pair" element={<JoinGroupPage />} />
                <Route path="*" element={null} />
              </Routes>
            </div>
          </div>
        )
      ) : (
        // Mobile: full-screen pages with back navigation
        <Routes>
          <Route path="/" element={homeElement} />
          <Route path="/p/:projectId" element={projectDetailElement} />
          <Route path="/p/:projectId/s/:sessionId" element={projectSessionElement} />
          <Route path="/p/:projectId/r/:repoId" element={projectRepoElement} />
          <Route path="/p/:projectId/t/:terminalId" element={<TerminalPage />} />
          <Route path="/p/:projectId/files" element={<FileBrowserPage />} />
          <Route path="/p/:projectId/files/*" element={<FileBrowserPage />} />
          <Route path="/add" element={<AddNewPage onSetActiveAgent={setActiveAgent} onBrowseDirectory={browseDirectory} onCloneRepo={cloneRepo} onAddCodingPath={addCodingPath} onConnect={handleConnect} onStartSession={startSession} />} />
          <Route path="/settings" element={<SettingsPage onSendApiKeyToAgent={isConnected ? setApiKey : undefined} />} />
          <Route path="/settings/m/:agentId" element={<MachineInfoPage onSetActiveAgent={setActiveAgent} onCheckAgentUpdate={checkAgentUpdate} onUpdateAgent={updateAgent} onRestartAgent={restartAgent} onDeleteProject={handleDeleteProject} onGetSystemdStatus={getSystemdStatus} onInstallSystemdUnit={installSystemdUnit} onUninstallSystemdUnit={uninstallSystemdUnit} />} />
          <Route path="/settings/m/:agentId/p/:projectId/archived" element={<ArchivedSessionsPage onSetActiveAgent={setActiveAgent} onListArchivedSessions={listArchivedSessions} onRestoreSession={restoreSession} />} />
          <Route path="/connect/:agentId" element={<ConnectHandler onConnect={handleConnect} />} />
          <Route path="/pair" element={<JoinGroupPage />} />
        </Routes>
      )}
      {showOverlay && <ConnectingOverlay onAbort={handleAbortConnection} onRetry={handleRetryConnection} />}
      <FilePreviewModal />
      <PathBrowser
        isOpen={showPathBrowser}
        mode="repo"
        onClose={() => setShowPathBrowser(false)}
        onSwitchRepo={switchRepo}
        onBrowseDirectory={browseDirectory}
        onAddRepo={addRepo}
        onCloneRepo={cloneRepo}
        onAddCodingPath={addCodingPath}
      />
      <GitignoreEditor
        isOpen={showGitignoreEditor}
        onClose={() => setShowGitignoreEditor(false)}
        onRead={readGitignore}
        onWrite={writeGitignore}
      />
      {showGitIdentityModal && (
        <GitIdentityModal
          onClose={() => setShowGitIdentityModal(false)}
          onSave={setGitIdentity}
          onGetIdentity={getGitIdentity}
        />
      )}
    </div>
  );
}

// ── Project route wrappers ──────────────────────────────────────────────────

/** Project repo view — git status/staging/commit within a project */
function ProjectRouteRepo({
  onConnect,
  onSwitchMachine,
  onSetActiveAgent,
  onSwitchRepo,
  onRefresh,
  onFetchDiff,
  onStage,
  onUnstage,
  onStagePatch,
  onUnstagePatch,
  onDiscard,
  onUntrack,
  onAddToGitignore,
  onCommit,
  onGenerateAiSummary,
  onApplyAiSuggestion,
  onDismissAiSummary,
  onSetApiKey,
}: {
  onConnect: (agentId: string, publicKey: string) => void;
  onSwitchMachine: (agentId: string) => void;
  onSetActiveAgent: (agentId: string) => void;
  onSwitchRepo: (path: string) => void;
} & Omit<React.ComponentProps<typeof RepoView>, 'onSwitchRepo'> & {
  onSwitchRepo: (path: string) => void;
}) {
  const { projectId, repoId } = useParams<{ projectId: string; repoId: string }>();
  const navigate = useNavigate();
  const { isReady, isConnecting, agentId, connectedAt } = useProjectConnection(projectId, onConnect, onSwitchMachine);
  const status = useGitStore((s) => s.status);

  // Resolve repoId hash → full repo path. Recompute on connect since
  // getAllKnownPaths can grow when project repos load.
  const targetRepoPath = useMemo(
    () => (agentId && repoId ? resolveHash(repoId, getAllKnownPaths(agentId)) : undefined),
    [agentId, repoId, isReady],
  );

  // Bind the git UI to the URL-specified repo on every new handshake.
  // Keying this effect on `connectedAt` (bumped by every handshake)
  // re-issues switch-repo whenever the agent comes back, even if the
  // single-agent mirror happens to still match the URL target from
  // before the suspend.
  //
  // We also point `gitStore.currentRepoPath` at the target eagerly so
  // any racing `git:status` (from RepoView's mount effect or
  // AppContent's state-based fetch) gets stamped with the target path.
  // The agent rejects mismatched stamps with REPO_MISMATCH — the PWA
  // converts that to SUPERSEDED — which prevents the pre-switch repo's
  // (often clean) status from flashing on screen before our switch-repo
  // lands. Without this, `onSetActiveAgent` rehydrates the store to the
  // handshake-ack's repoPath, which on first connect is the agent's
  // default repo, not the URL target.
  useEffect(() => {
    if (!isReady || !agentId || !targetRepoPath) return;
    onSetActiveAgent(agentId);
    useGitStore.getState().setCurrentRepoPath(targetRepoPath);
    onSwitchRepo(targetRepoPath);
  }, [isReady, agentId, targetRepoPath, connectedAt, onSetActiveAgent, onSwitchRepo]);

  // On visibility return, force a status refresh. Covers the case where
  // the app was backgrounded but WebRTC stayed up (no new handshake, so
  // the effect above won't re-fire), yet the git status may still be
  // stale.
  useEffect(() => {
    if (!isReady || !targetRepoPath) return;
    const resync = () => {
      if (document.visibilityState !== 'visible') return;
      onRefresh();
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('pageshow', resync);
    return () => {
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('pageshow', resync);
    };
  }, [isReady, targetRepoPath, onRefresh]);

  if (!isReady || !targetRepoPath) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <BaseStatusBar
          left={<BackButton onClick={() => navigate(-1)} />}
          center={<span className="text-sm font-medium text-slate-300"><FormattedMessage id="repoView.title.fallback" /></span>}
        />
        <div className="flex-1 flex items-center justify-center">
          {(isConnecting || (isReady && !targetRepoPath)) && <Spinner size="w-8 h-8" color="border-blue-500" />}
        </div>
      </div>
    );
  }

  return (
    <>
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-300 truncate">
              {targetRepoPath.split('/').pop() || 'Repo'}
            </span>
            {status?.branch && (
              <span className="text-xs text-slate-500 truncate">
                {status.branch}
                {(status.ahead ?? 0) > 0 && ` ↑${status.ahead}`}
                {(status.behind ?? 0) > 0 && ` ↓${status.behind}`}
              </span>
            )}
          </div>
        }
      />
      <RepoView
        onRefresh={onRefresh}
        onFetchDiff={onFetchDiff}
        onStage={onStage}
        onUnstage={onUnstage}
        onStagePatch={onStagePatch}
        onUnstagePatch={onUnstagePatch}
        onDiscard={onDiscard}
        onUntrack={onUntrack}
        onAddToGitignore={onAddToGitignore}
        onCommit={onCommit}
        onGenerateAiSummary={onGenerateAiSummary}
        onApplyAiSuggestion={onApplyAiSuggestion}
        onDismissAiSummary={onDismissAiSummary}
        onSetApiKey={onSetApiKey}
      />
    </>
  );
}

/** Project detail page — shows session list for a project */
function ProjectRouteDetail({
  onConnect,
  onSwitchMachine,
  onListProjectRepos,
  onDeleteProject,
  onRestartAgent,
  onListArchivedSessions,
  onRestoreSession,
}: {
  onConnect: (agentId: string, publicKey: string) => void;
  onSwitchMachine: (agentId: string) => void;
  onListProjectRepos?: (cwd: string) => Promise<import('@sumicom/quicksave-shared').ProjectRepo[] | null>;
  onDeleteProject?: (cwd: string) => Promise<import('@sumicom/quicksave-shared').ProjectDeleteResponsePayload | null>;
  onRestartAgent?: () => Promise<{ success: boolean; error?: string }>;
  onListArchivedSessions?: (cwd: string, offset?: number, limit?: number) => Promise<import('@sumicom/quicksave-shared').SessionListArchivedResponsePayload | null>;
  onRestoreSession?: (sessionId: string, cwd: string) => Promise<void>;
}) {
  const { projectId } = useParams<{ projectId: string }>();
  const { isReady, isConnecting, isError, cwd, agentId } = useProjectConnection(projectId, onConnect, onSwitchMachine);

  return (
    <ProjectDetail
      isReady={isReady}
      isConnecting={isConnecting}
      isError={isError}
      cwd={cwd}
      agentId={agentId}
      onListProjectRepos={onListProjectRepos}
      onDeleteProject={onDeleteProject}
      onRestartAgent={onRestartAgent}
      onListArchivedSessions={onListArchivedSessions}
      onRestoreSession={onRestoreSession}
    />
  );
}

/** Project session page — shows chat session within a project */
function ProjectRouteSession({
  onConnect,
  onSwitchMachine,
  showSettings,
  onOpenSettings,
  onCloseSettings,
  onSetSessionConfig,
  onSendControlRequest,
  onCloseSession,
  onEndSession,
  onCancelSession,
  onGetSessionCards,
  onStartSession,
  onResumeSession,
  onRespondToUserInput,
  onUnsubscribeSession,
  onSetActiveAgent,
  onListProjectRepos,
  onMarkSessionRead,
  getBus,
}: {
  onConnect: (agentId: string, publicKey: string) => void;
  onSwitchMachine: (agentId: string) => void;
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onSetSessionConfig: (sessionId: string, key: string, value: import('@sumicom/quicksave-shared').ConfigValue) => void;
  onSendControlRequest: (sessionId: string, subtype: string, params?: Record<string, unknown>) => Promise<import('@sumicom/quicksave-shared').SessionControlRequestResponsePayload>;
  onCloseSession: (sessionId: string) => void;
  onEndSession: (sessionId: string) => void;
  onCancelSession: (sessionId: string) => void;
  onGetSessionCards: (sessionId: string, offset?: number, limit?: number, cwd?: string) => Promise<void>;
  onStartSession: ReturnType<typeof useClaudeOperations>['startSession'];
  onResumeSession: ReturnType<typeof useClaudeOperations>['resumeSession'];
  onRespondToUserInput?: (response: ClaudeUserInputResponsePayload) => void;
  onUnsubscribeSession?: (sessionId: string) => void;
  onSetActiveAgent?: (agentId: string) => void;
  onListProjectRepos?: (cwd: string) => Promise<import('@sumicom/quicksave-shared').ProjectRepo[] | null>;
  onMarkSessionRead?: ReturnType<typeof useClaudeOperations>['markSessionRead'];
  getBus: () => MessageBusClient | null;
}) {
  const { projectId, sessionId: urlSessionId } = useParams<{ projectId: string; sessionId: string }>();
  // Hold the attention topic only while this tab is visible+focused so the
  // agent's push gate fires for the *other* devices the user isn't holding.
  // Also stamps `lastReadAt` server-side via the bus so unread state is in
  // sync across every PWA client of this user.
  const attentionSessionId = urlSessionId && urlSessionId !== 'new' ? urlSessionId : null;
  useSessionAttention(attentionSessionId, getBus, { markSessionRead: onMarkSessionRead });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNewSession = searchParams.has('new');
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);
  // Watch the archived flag on the URL-bound session so we can bounce out
  // of pages whose sessionId has been retired in the registry (End Task,
  // project:delete). isActive alone is too noisy — it can flip during normal
  // list reconciliation, plus we now want to KEEP the user on the page when
  // the CLI process is killed (Terminate Coding Agent Process / unexpected
  // CLI exit) since the registry entry is still active and cold-resumable.
  // Cold-resume rekey forks are handled by the separate rerouter below.
  const viewedArchived = useClaudeStore((s) =>
    urlSessionId && urlSessionId !== 'new' ? s.sessions[urlSessionId]?.archived === true : false
  );

  const { isReady, isConnecting, cwd, agentId: targetAgentId } = useProjectConnection(projectId, onConnect, onSwitchMachine);

  const projectBasePath = `/p/${projectId}`;

  // Ensure this agent is active before any send() — critical for multi-agent
  const ensureActiveAgent = useCallback(() => {
    if (targetAgentId) {
      onSetActiveAgent?.(targetAgentId);
    }
  }, [targetAgentId, onSetActiveAgent]);

  // Cold-resume fork rerouter: when a CLI cold resume returns a different
  // session_id than the one we asked for, the daemon migrates state under the
  // new id and the old id is now defunct. If the user is still viewing the
  // old id's URL, the page would silently route bus traffic to the wrong
  // topic — visually empty until they navigate away. Move them to the new id
  // in that narrow case only.
  //
  // Why not unconditional: the user finds being yanked to a different URL
  // jarring. AddNewPage already navigates explicitly when it spins up a
  // brand-new session (null → Y), and SessionList navigates URL-first when a
  // user picks a session (so the URL is already at the new id by the time
  // activeSessionId catches up). The only case left is fork.
  const prevActiveRef = useRef(activeSessionId);
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeSessionId;
    if (
      prev &&
      activeSessionId &&
      prev !== activeSessionId &&
      urlSessionId === prev
    ) {
      navigate(`${projectBasePath}/s/${activeSessionId}`, { replace: true });
    }
  }, [activeSessionId, urlSessionId, projectBasePath, navigate]);

  // Archived session bounce: if the session on this page gets archived on
  // the daemon, navigate back. Prefer `navigate(-1)` so the defunct entry
  // is popped (cleaner mobile back-stack). Fall back to replace when there's
  // no prior entry (deep-link / refresh — `location.key === 'default'`).
  useEffect(() => {
    if (!viewedArchived) return;
    if (location.key !== 'default') {
      navigate(-1);
    } else {
      navigate(projectBasePath, { replace: true });
    }
  }, [viewedArchived, location.key, navigate, projectBasePath]);

  const getSessionId = () => useClaudeStore.getState().activeSessionId || urlSessionId;

  // Bind cwd + agent routing into callbacks
  const boundGetCards = useCallback(
    (sid: string, offset?: number, limit?: number) => { ensureActiveAgent(); return onGetSessionCards(sid, offset, limit, cwd); },
    [onGetSessionCards, cwd, ensureActiveAgent]
  );
  const boundStartSession = useCallback(
    (prompt: string, opts?: Parameters<typeof onStartSession>[1]) => {
      ensureActiveAgent(); return onStartSession(prompt, { ...opts, cwd });
    },
    [onStartSession, cwd, ensureActiveAgent]
  );
  const boundResumeSession = useCallback(
    (sid: string, prompt: string, opts?: Parameters<typeof onResumeSession>[3]) => {
      ensureActiveAgent(); return onResumeSession(sid, prompt, cwd, opts);
    },
    [onResumeSession, cwd, ensureActiveAgent]
  );

  if (!isReady) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <NewSessionAppBar cwd={cwd} onOpenMenu={() => {}} backTo={projectBasePath} />
        <div className="flex-1 flex items-center justify-center">
          {isConnecting ? <ConnectingStages /> : <Spinner size="w-8 h-8" color="border-blue-500" />}
        </div>
      </div>
    );
  }

  return (
    <>
      {isNewSession && !activeSessionId ? (
        <NewSessionAppBar cwd={cwd} onOpenMenu={() => {}} backTo={projectBasePath} />
      ) : (
        <SessionAppBar
          showSettings={showSettings}
          onOpenSettings={onOpenSettings}
          onCloseSettings={onCloseSettings}
          onOpenMenu={() => {}}
          backTo={projectBasePath}
          sessionId={urlSessionId}
          projectId={projectId}
          agentId={targetAgentId ?? undefined}
          cwd={cwd}
          onListProjectRepos={onListProjectRepos}
          onSetSessionConfig={(key, value) => {
            const sid = getSessionId();
            if (sid) onSetSessionConfig(sid, key, value);
          }}
          onSendControlRequest={onSendControlRequest}
          onCloseSession={() => {
            const sid = getSessionId();
            if (sid) onCloseSession(sid);
          }}
          onEndSession={() => {
            const sid = getSessionId();
            if (sid) onEndSession(sid);
          }}
          onCancelSession={() => {
            const sid = getSessionId();
            if (sid) onCancelSession(sid);
          }}
        />
      )}
      <ClaudePanel
        sessionId={urlSessionId === 'new' ? undefined : urlSessionId}
        newSession={isNewSession}
        cwd={cwd}
        onSelectSession={(sid) => navigate(`${projectBasePath}/s/${sid}`)}
        onNewSession={() => navigate(`/add?tab=session&projectId=${encodeURIComponent(projectId ?? '')}`)}
        onGetSessionCards={boundGetCards}
        onSetSessionConfig={(sid, key, value) => onSetSessionConfig(sid, key, value)}
        onSendControlRequest={onSendControlRequest}
        onUnsubscribeSession={onUnsubscribeSession}
        onStartSession={boundStartSession}
        onResumeSession={boundResumeSession}
        onRespondToUserInput={onRespondToUserInput}
      />
    </>
  );
}

// Lightweight handler for QR code / shared link connections (/connect/:agentId?pk=...&name=...)
// Adds machine if new, triggers connection, and redirects — no UI of its own.
function ConnectHandler({ onConnect }: { onConnect: (agentId: string, publicKey: string) => void }) {
  const { agentId } = useParams<{ agentId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { addMachine, getMachine } = useMachineStore();
  const { setPendingRepoPath } = useConnectionStore();
  const initiated = useRef(false);

  useEffect(() => {
    if (initiated.current || !agentId) return;
    initiated.current = true;

    const pk = searchParams.get('pk');
    const spk = searchParams.get('spk') || undefined;
    const name = searchParams.get('name');
    const repo = searchParams.get('repo');

    if (repo) setPendingRepoPath(repo);

    if (pk) {
      // New machine from QR code
      if (!getMachine(agentId)) {
        addMachine({ agentId, publicKey: pk, signPublicKey: spk, nickname: name || `Machine ${agentId.slice(0, 8)}`, icon: '' });
      }
      onConnect(agentId, pk);
    } else {
      // Reconnect to existing machine
      const machine = getMachine(agentId);
      if (machine) {
        onConnect(machine.agentId, machine.publicKey);
      }
    }

    // Redirect to home (overlay will show connecting)
    navigate('/', { replace: true });
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

function App() {
  useEffect(() => {
    const splash = document.getElementById('app-splash');
    if (!splash) return;

    const hide = () => {
      requestAnimationFrame(() => splash.classList.add('fade-out'));
    };
    const show = () => splash.classList.remove('fade-out');

    hide();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        show();
      } else {
        hide();
      }
    };
    const onPageShow = () => hide();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', show);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', show);
    };
  }, []);

  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}

export default App;
