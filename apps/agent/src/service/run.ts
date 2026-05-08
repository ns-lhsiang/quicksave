// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Daemon entrypoint — `quicksave service run`.
 *
 * Boot sequence:
 * 1. Acquire singleton lock.
 * 2. Start IPC server on Unix socket.
 * 3. Load config and managed repos.
 * 4. Start AgentConnection (signaling + message handler).
 * 5. Persist ready state to service.json.
 * 6. Run heartbeat loop.
 */

import { basename, join, resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { hostname } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { getOrCreateConfig, getManagedRepos, getManagedCodingPaths, addManagedRepo, removeManagedRepo, loadConfig, type AgentConfig } from '../config.js';
import { AgentConnection } from '../connection/connection.js';
import { BusServerTransport } from '../messageBus/busServerTransport.js';
import { MessageBusServer } from '@sumicom/quicksave-message-bus';
import { MessageHandler } from '../handlers/messageHandler.js';
import { wireLegacyBusVerbs } from '../handlers/legacyBusAdapter.js';
import { GitOperations } from '../git/operations.js';
import { IpcServer } from './ipcServer.js';
import { DebugHttpServer } from './debugHttpServer.js';
import { PushClient, httpBaseFromSignalingUrl } from './pushClient.js';
import {
  acquireLock,
  ensureDirectories,
  getSocketPath,
  getRunDir,
  cleanStaleRuntime,
} from './singleton.js';
import { writeServiceState, removeServiceState } from './stateStore.js';
import { wasLaunchedBySystemd } from './systemdUnit.js';
import { IPC_VERSION, BUILD_ID, isDebugEnabled, isDev } from './types.js';
import type {
  ServiceState,
  StatusResult,
  PairingInfoResult,
  RepoInfo,
  DebugResult,
  AgentStateResult,
  UnlockPairingResult,
} from './types.js';
import {
  type CardEvent,
  type CardHistoryResponse,
  type CardStreamEnd,
  type ClaudePreferences,
  type CommitSummaryState,
  type ConfigValue,
  type Message,
  type Repository,
  type SessionCardsUpdate,
  type BroadcastSessionEntry,
  type SessionConfigUpdatedPayload,
  type SessionHistoryUpdatedPayload,
  type SessionUpdatePayload,
  type CodexLoginState,
  type CodexModelInfo,
  type TerminalSummary,
  type TerminalsUpdate,
  type TerminalOutputSnapshot,
  type TerminalOutputChunk,
} from '@sumicom/quicksave-shared';
import { getSessionRegistry } from '../ai/sessionRegistry.js';
import { getEventStore } from '../storage/eventStore.js';
import { enrichEntry } from '../ai/enrichEntry.js';
import { getTerminalManager } from '../terminal/terminalManager.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const PACKAGE_VERSION = '0.8.7';

export async function runDaemon(): Promise<void> {
  ensureDirectories();

  // Prevent unhandled rejections from silently killing the daemon
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in daemon:', reason);
  });

  // 1. Acquire singleton lock
  const releaseLock = acquireLock();
  if (!releaseLock) {
    console.error('Another daemon is already running. Use `quicksave service status` to check.');
    process.exit(1);
  }

  const socketPath = getSocketPath();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;

  // 2. Start IPC server
  const ipcServer = new IpcServer({ version: PACKAGE_VERSION });

  try {
    await ipcServer.listen(socketPath);
  } catch (err) {
    console.error('Failed to start IPC server:', err);
    releaseLock();
    process.exit(1);
  }

  // 3. Load config and managed repos
  const config = getOrCreateConfig('wss://signal.quicksave.dev');

  const repoPaths = getManagedRepos();
  const codingPaths = getManagedCodingPaths();

  const validRepos = await validateRepos(repoPaths);
  console.log(`Managed repos: ${validRepos.length} valid of ${repoPaths.length} configured`);

  // 4. Start AgentConnection
  const connection = new AgentConnection({
    signalingServer: config.signalingServer,
    agentId: config.agentId,
    keyPair: config.keyPair,
  });

  // MessageBus lives alongside the legacy connection handlers. The adapter
  // filters inbound messages for `type === 'bus:frame'`; everything else
  // continues to flow through the existing MessageHandler path.
  const busTransport = new BusServerTransport(connection);
  const bus = new MessageBusServer(busTransport);

  const isProduction = !isDev();
  const messageHandler = new MessageHandler(validRepos, config.license, codingPaths, isProduction);

  // Signed HTTP side-channel to the relay for Web Push. The relay's default
  // push HTTP origin is derived from the signaling URL; PWAs may override per
  // offer for dev/staging relays.
  const pushClient = new PushClient({
    signKeyPair: config.signKeyPair,
    defaultRelayHttpUrl: httpBaseFromSignalingUrl(config.signalingServer),
  });
  messageHandler.setPushClient(pushClient);

  // Self-restart after update: spawn a detached launcher that
  // 1. sanity-checks the new binary (--version)
  // 2. only then kills the old daemon
  // 3. starts the new daemon
  // If the sanity check fails, old daemon stays alive untouched.
  messageHandler.onRestartRequested = () => {
    console.log('Update complete — spawning upgrade launcher...');
    const thisFile = fileURLToPath(import.meta.url);
    const isTs = thisFile.endsWith('.ts');
    const entryPath = resolve(dirname(thisFile), isTs ? '../index.ts' : '../index.js');
    const logPath = join(getRunDir(), 'daemon.log');
    const node = process.execPath;
    const nf = isTs ? `--import tsx ` : '';
    const oldPid = process.pid;
    // Escape single quotes in paths for safe shell interpolation
    const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    // Detached shell: verify → kill old → start new.
    // Sanity check + its `||` fallback must stay in a single array element —
    // if we split them and `.join(' && ')`, the result becomes `… && || { … }`
    // which is a shell syntax error and the whole launcher silently aborts.
    const script = [
      `sleep 1`,
      // Sanity-check: if new binary can't even print version, abort
      `${sq(node)} ${nf}${sq(entryPath)} --version > /dev/null 2>&1 || { echo "[upgrade] new binary failed sanity check, aborting" >> ${sq(logPath)}; exit 1; }`,
      // New binary works — kill old daemon (graceful shutdown releases lock)
      `kill ${oldPid}`,
      // Wait for old daemon to fully exit and release lock
      `for i in 1 2 3 4 5; do kill -0 ${oldPid} 2>/dev/null || break; sleep 1; done`,
      // Start new daemon
      `${sq(node)} ${nf}${sq(entryPath)} service run >> ${sq(logPath)} 2>&1`,
    ].join(' && ');
    spawn('sh', ['-c', script], {
      detached: true, stdio: 'ignore', env: process.env,
    }).unref();
  };

  // Pub/sub: ClaudeCodeService emits card events → send only to peers subscribed to that session
  const claudeService = messageHandler.getClaudeService();
  const commitSummaryStore = messageHandler.getCommitSummaryStore();

  // ── MessageBus subscription paths ─────────────────────────────────────────
  // Each onSubscribe delivers the current state atomically in its `snap`
  // frame; downstream publishes fire `upd` frames. Subscriptions survive
  // reconnects — the client re-sends `sub` and the server re-snapshots —
  // which eliminates the post-reconnect staleness window.

  // Live active-session list. Snapshot = every active session; updates =
  // single SessionUpdatePayload per change.
  bus.onSubscribe<'/sessions/active', SessionUpdatePayload[], SessionUpdatePayload>(
    '/sessions/active',
    { snapshot: () => claudeService.snapshotActiveSessions() },
  );

  // Global user-editable preferences (model, reasoning effort).
  bus.onSubscribe<'/preferences', ClaudePreferences, ClaudePreferences>(
    '/preferences',
    { snapshot: () => claudeService.getPreferences() },
  );

  // Session registry entries (historical + active). Snapshot returns every
  // entry across all cwds; updates publish single upsert/delete events.
  bus.onSubscribe<'/sessions/history', BroadcastSessionEntry[], SessionHistoryUpdatedPayload>(
    '/sessions/history',
    { snapshot: () => getSessionRegistry().getEntriesForProject().map(enrichEntry) },
  );

  // Per-repo AI commit-summary generation state. Snapshot = every tracked
  // repo; updates publish one repo's state at a time.
  bus.onSubscribe<'/repos/commit-summary', CommitSummaryState[], CommitSummaryState>(
    '/repos/commit-summary',
    { snapshot: () => commitSummaryStore.snapshot() },
  );

  // Per-session config, keyed by sessionId so late subscribers don't need to
  // pre-know which ids exist.
  bus.onSubscribe<'/sessions/config', Record<string, Record<string, ConfigValue>>, SessionConfigUpdatedPayload>(
    '/sessions/config',
    { snapshot: () => claudeService.getAllSessionConfigs() },
  );

  // Per-session card history + live card/stream-end stream. Snapshot = the
  // initial `CardHistoryResponse` (offset=0, includes pendingInput overlay
  // and title). Updates carry incremental CardEvents or CardStreamEnd.
  bus.onSubscribe<'/sessions/:sessionId/cards', CardHistoryResponse, SessionCardsUpdate>(
    '/sessions/:sessionId/cards',
    {
      snapshot: async ({ params }) => {
        const sessionId = params.sessionId;
        const liveCwd = claudeService.getSessionCwd(sessionId);
        const cwd = liveCwd ?? getSessionRegistry().findBySessionId(sessionId)?.cwd ?? '';
        return claudeService.getCards(sessionId, cwd, 0, 50);
      },
    },
  );

  // Presence marker for the session view. The PWA subscribes only while the
  // tab is visible AND focused; it unsubscribes on visibilitychange/blur and
  // on tab close. We use `subscriberCount(attention) === 0` as the push gate,
  // so a backgrounded device on another browser doesn't suppress the
  // notification on the user's phone. No snapshot payload — subscribe alone
  // is the signal.
  bus.onSubscribe<'/sessions/:sessionId/attention', null, never>(
    '/sessions/:sessionId/attention',
    { snapshot: () => null },
  );

  // ── Terminals (PTY-backed interactive shells) ──────────────────────────
  // `/terminals`          — full list + upsert/remove events.
  // `/terminals/:id/output` — scrollback snapshot + live output chunks.
  const terminalManager = getTerminalManager();
  bus.onSubscribe<'/terminals', TerminalSummary[], TerminalsUpdate>(
    '/terminals',
    { snapshot: () => terminalManager.listSummaries() },
  );
  bus.onSubscribe<'/terminals/:terminalId/output', TerminalOutputSnapshot | null, TerminalOutputChunk>(
    '/terminals/:terminalId/output',
    {
      snapshot: ({ params }) => terminalManager.outputSnapshot(params.terminalId),
    },
  );
  terminalManager.on('terminals-updated', (update: TerminalsUpdate) => {
    bus.publish<TerminalsUpdate>('/terminals', update);
  });
  terminalManager.on('terminal-updated', (summary: TerminalSummary) => {
    bus.publish<TerminalsUpdate>('/terminals', { kind: 'upsert', terminal: summary });
  });
  terminalManager.on('output', (chunk: TerminalOutputChunk) => {
    bus.publish<TerminalOutputChunk>(`/terminals/${chunk.terminalId}/output`, chunk);
  });

  claudeService.on('card-event', (event: CardEvent) => {
    bus.publish<SessionCardsUpdate>(
      `/sessions/${event.sessionId}/cards`,
      { kind: 'card', event },
    );
  });
  claudeService.on('card-stream-end', (result: CardStreamEnd) => {
    bus.publish<SessionCardsUpdate>(
      `/sessions/${result.sessionId}/cards`,
      { kind: 'stream-end', result },
    );

    // Web Push trigger: session went idle while no PWA is actively attending
    // this session. Subscribing to cards alone isn't enough — a backgrounded
    // tab on another device keeps that subscription alive, which would
    // silently swallow the notification on the user's phone. The attention
    // topic is only held while visible+focused, so counting its subscribers
    // answers "is anyone actually looking at this session?" correctly.
    //
    // Skip when the turn paused for user input (user-input-request handles
    // that path) and when the agent was explicitly interrupted.
    const attendingCount = bus.subscriberCount(`/sessions/${result.sessionId}/attention`);
    const suppressed = result.interrupted || claudeService.hasPendingInputForSession(result.sessionId);
    if (attendingCount === 0 && !suppressed) {
      pushClient.notify(result.sessionId, {
        title: 'Quicksave',
        body: 'Session is ready for your next instruction',
        tag: result.sessionId,
        agentId: config.agentId,
      }).then((r) => { if (!r.ok || (r.sent ?? 0) === 0) console.warn(`[push] idle notify returned status=${r.status} sent=${r.sent ?? 0}`); })
        .catch((err) => console.warn('[push] notify (idle) failed', err));
    }

    const cwd = claudeService.getSessionCwd(result.sessionId);
    const inputTokens = result.tokenUsage?.input ?? 0;
    const outputTokens = result.tokenUsage?.output ?? 0;
    const cacheCreationTokens = result.tokenUsage?.cacheCreation ?? 0;
    const cacheReadTokens = result.tokenUsage?.cacheRead ?? 0;
    // Codex-only: thread-cumulative counters carried alongside the per-turn
    // deltas so a cold-resumed daemon can continue emitting deltas without
    // double-counting the prior turns.
    const cumulativeInputTokens = result.tokenUsage?.cumulativeInput;
    const cumulativeOutputTokens = result.tokenUsage?.cumulativeOutput;
    const cumulativeCachedInputTokens = result.tokenUsage?.cumulativeCachedInput;
    const costUsd = result.totalCostUsd ?? 0;

    // Fetch the CLI's context-window breakdown before recording the turn.
    // Only the Claude Code CLI responds; other providers return null quickly.
    // Fire-and-record to avoid blocking the peer notification above.
    (async () => {
      const contextUsage = await claudeService.getSessionContextUsage(result.sessionId).catch(() => null);

      getEventStore().record({
        type: 'turn_ended',
        sessionId: result.sessionId,
        cwd: cwd ?? null,
        data: {
          success: result.success,
          interrupted: result.interrupted ?? false,
          error: result.error,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          costUsd,
          ...(cumulativeInputTokens !== undefined ? { cumulativeInputTokens } : {}),
          ...(cumulativeOutputTokens !== undefined ? { cumulativeOutputTokens } : {}),
          ...(cumulativeCachedInputTokens !== undefined ? { cumulativeCachedInputTokens } : {}),
          ...(contextUsage ? { contextUsage: { ...contextUsage, capturedAt: Date.now() } } : {}),
        },
      });

      // Update session registry with cost/message count
      if (cwd) {
        const registry = getSessionRegistry();
        const entry = registry.getEntry(cwd, result.sessionId);
        if (entry) {
          registry.updateEntry(cwd, result.sessionId, {
            messageCount: (entry.messageCount ?? 0) + 1,
            totalCostUsd: (entry.totalCostUsd ?? 0) + costUsd,
            lastAccessedAt: Date.now(),
          });
        }
      }

      // Re-broadcast /sessions/active now that the turn_ended event has been
      // persisted. The earlier emitSessionUpdate fired synchronously inside
      // emitStreamEnd (sessionManager.ts), BEFORE this async IIFE recorded
      // the event — so that broadcast carried the previous turn's
      // lastTurnEndedAt. PWA clients depend on lastTurnEndedAt advancing to
      // detect "the session has new output you haven't seen" (unread mark);
      // without this follow-up, the home list never picks up the new value
      // until the next session activity, breaking cross-tab unread sync.
      claudeService.emitSessionUpdate(result.sessionId);
    })().catch((err) => {
      console.error(`[turn_ended] failed to record turn for session=${result.sessionId.slice(0, 8)}:`, err);
    });
  });
  claudeService.on('user-input-request', (request) => {
    // The CardBuilder emits a card-event (update with pendingInput) before
    // this fires, so any PWA subscribed to /sessions/:id/cards already sees
    // the prompt. Here we only handle side effects: push-notify idle peers
    // and record the permission event. Gate on attention (not cards) so a
    // backgrounded tab doesn't suppress notifications on a device the user
    // is actually holding.
    const watchers = bus.subscriberCount(`/sessions/${request.sessionId}/attention`);
    if (watchers === 0) {
      const body = request.inputType === 'permission'
        ? 'Permission required to continue'
        : 'Input required to continue';
      pushClient.notify(request.sessionId, {
        title: request.title || 'Quicksave',
        body,
        tag: request.sessionId,
        agentId: config.agentId,
      }).then((r) => { if (!r.ok || (r.sent ?? 0) === 0) console.warn(`[push] input-request notify returned status=${r.status} sent=${r.sent ?? 0}`); })
        .catch((err) => console.warn('[push] notify (input-request) failed', err));
    }

    getEventStore().record({
      type: 'permission_requested',
      sessionId: request.sessionId,
      data: {
        requestId: request.requestId,
        inputType: request.inputType,
        title: request.title,
      },
    });
  });
  claudeService.on('user-input-resolved', (info) => {
    // CardBuilder.clearPendingInput emits a card-event (update with
    // pendingInput: undefined) before this fires, so PWA state is already
    // reconciled via the /sessions/:id/cards subscription.
    getEventStore().record({
      type: 'permission_resolved',
      sessionId: info.sessionId,
      data: { requestId: info.requestId },
    });
  });
  claudeService.on('session-updated', (info) => {
    // Delivered via the bus `/sessions/active` subscription. New peers receive
    // the full active-session list atomically in their snap frame, so no
    // separate connect-time broadcast is needed.
    bus.publish<SessionUpdatePayload>('/sessions/active', info);
  });
  claudeService.on('preferences-updated', (prefs) => {
    bus.publish<ClaudePreferences>('/preferences', prefs);
  });
  claudeService.on('session-config-updated', (payload) => {
    bus.publish<SessionConfigUpdatedPayload>('/sessions/config', payload);
  });

  // Per-repo commit-summary state (agent-owned). Each PWA mirrors the
  // pending suggestion + generation progress via `/repos/commit-summary`.
  commitSummaryStore.on('state-updated', (state) => {
    bus.publish<CommitSummaryState>('/repos/commit-summary', state);
  });

  // Codex OAuth device-auth state. The PWA subscribes while the login
  // modal is open; `snap` delivers the current state (idle, in-progress,
  // or logged-in) and every subsequent `upd` reflects a transition. The
  // push is how we notify the PWA that the user just finished the OAuth
  // dance on their phone without forcing it to poll.
  const codexLoginManager = messageHandler.getCodexLoginManager();
  codexLoginManager.setUpdateHandler((state) => {
    bus.publish<CodexLoginState>('/codex/login', state);
  });
  bus.onSubscribe<'/codex/login', CodexLoginState, CodexLoginState>(
    '/codex/login',
    { snapshot: () => codexLoginManager.getStatus() },
  );

  // Local Codex model list. Snapshot delivers whatever the daemon currently
  // has cached; refresh comes via the 30-min TTL inside
  // `MessageHandler.fetchCodexModels` (no fs watcher — `model/list` is the
  // canonical source now and there's no on-disk file we can watch). The
  // eager `primeCodexModelsCache` call below populates the snapshot before
  // the first PWA subscriber arrives.
  messageHandler.setCodexModelsUpdateHandler((models) => {
    bus.publish<CodexModelInfo[]>('/codex/models', models);
  });
  bus.onSubscribe<'/codex/models', CodexModelInfo[], CodexModelInfo[]>(
    '/codex/models',
    { snapshot: () => messageHandler.getCachedCodexModels() },
  );
  messageHandler.primeCodexModelsCache();

  // ── MessageBus command adapter ────────────────────────────────────────────
  // Every request-response verb from the legacy MessageHandler is exposed as a
  // bus command via `wireLegacyBusVerbs`, so the PWA can
  // `bus.command(verb, payload)` instead of going through the legacy
  // pendingRequests machinery. See `handlers/legacyBusAdapter.ts` for the
  // verb list, the `__repoPath` smuggling rule, and the error encoding.
  wireLegacyBusVerbs(bus, messageHandler);

  // Init preferences from the last session's JSONL (best-effort, non-blocking)
  claudeService.initPreferences().catch(() => {});

  // Init session registry (loads all entries from disk)
  getSessionRegistry();

  // Per-session card stream, pendingInput overlay, and session status are all
  // delivered via the bus (`/sessions/:id/cards` + `/sessions/active`), so the
  // legacy per-session pubsub subscribe/unsubscribe wiring is no longer used.
  messageHandler.onHistoryUpdated = (cwd, entry, action) => {
    // For deletes the entry is a tombstone — SQLite join would be noise, and
    // downstream consumers only key off `entry.sessionId` + `action`.
    const enriched = action === 'delete' ? entry : enrichEntry(entry);
    bus.publish<SessionHistoryUpdatedPayload>('/sessions/history', { cwd, entry: enriched, action });
  };

  // Wire: incoming PWA messages → MessageHandler → response back to PWA.
  // Bus frames are consumed by `BusServerTransport` first (they route through
  // `bus.onCommand` handlers or subscribe dispatchers), so skip them here to
  // avoid producing UNKNOWN_MESSAGE_TYPE noise. Everything else — handshake,
  // and any legacy PWA builds still sending request messages directly — still
  // flows through the MessageHandler dispatch.
  connection.on('message', async (message: Message, peerAddress: string) => {
    if (message.type === 'bus:frame') return;
    try {
      const response = await messageHandler.handleMessage(message, peerAddress);
      connection.send(response, peerAddress);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  });

  // 5. Register IPC methods and status provider BEFORE writing service state,
  //    so methods are available as soon as clients can discover the daemon.
  const startedAt = new Date().toISOString();
  const serviceState: ServiceState = {
    pid: process.pid,
    version: PACKAGE_VERSION,
    ipcVersion: IPC_VERSION,
    buildId: BUILD_ID,
    startedAt,
    lastHeartbeatAt: startedAt,
    socketPath,
    agentId: config.agentId,
    publicKey: config.keyPair.publicKey,
    signalingServer: config.signalingServer,
    connectionState: 'disconnected',
    peerCount: 0,
    ...(wasLaunchedBySystemd() ? { managedBy: 'systemd' as const } : {}),
  };

  ipcServer.setStatusProvider((): StatusResult => {
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    return {
      version: PACKAGE_VERSION,
      pid: process.pid,
      uptime: Math.floor(uptimeMs / 1000),
      connectionState: serviceState.connectionState,
      peerCount: connection.getPeerCount(),
      activeSessions: messageHandler.getActiveSessionCount(),
      managedRepos: getManagedRepos().length,
    };
  });

  registerDaemonMethods(ipcServer, connection, messageHandler, config);

  // Start debug HTTP server (local-only, gated by debug mode)
  let debugHttpServer: DebugHttpServer | null = null;
  if (isDebugEnabled()) {
    debugHttpServer = new DebugHttpServer(claudeService);
    debugHttpServer.start().catch((err) => {
      console.warn('Failed to start debug HTTP server:', err);
    });
  }

  // Wire peer events
  connection.on('connected', (peerAddress: string) => {
    const peerKey = peerAddress.replace('pwa:', '');
    console.log(`+ PWA connected: ${peerKey.slice(0, 12)}... (${connection.getPeerCount()} peers)`);
    serviceState.peerCount = connection.getPeerCount();
    serviceState.connectionState = 'connected';
    writeServiceState(serviceState);
    ipcServer.broadcast({
      jsonrpc: '2.0',
      method: 'event.peerConnected',
      params: { peerId: peerKey.slice(0, 12), peerCount: connection.getPeerCount() },
    });
  });

  connection.on('disconnected', (peerAddress: string) => {
    const peerKey = peerAddress.replace('pwa:', '');
    messageHandler.removeClient(peerAddress);
    console.log(`- PWA disconnected: ${peerKey.slice(0, 12)}... (${connection.getPeerCount()} peers)`);
    serviceState.peerCount = connection.getPeerCount();
    if (!connection.hasPeers()) serviceState.connectionState = 'disconnected';
    writeServiceState(serviceState);
    ipcServer.broadcast({
      jsonrpc: '2.0',
      method: 'event.peerDisconnected',
      params: { peerId: peerKey.slice(0, 12), peerCount: connection.getPeerCount() },
    });
  });

  connection.on('error', (error: Error) => {
    console.error('Connection error:', error.message);
  });

  // Persist ready state — daemon becomes discoverable by CLI clients
  writeServiceState(serviceState);

  // Start signaling connection (may be slow — all IPC methods already registered above)
  try {
    await connection.start();
    console.log('Signaling connection established');
  } catch (error) {
    console.error('Failed to start signaling connection:', error);
    // Daemon continues running — will retry on reconnect
  }

  // 6. Heartbeat loop
  heartbeatTimer = setInterval(() => {
    serviceState.lastHeartbeatAt = new Date().toISOString();
    serviceState.peerCount = connection.getPeerCount();
    writeServiceState(serviceState);
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`Quicksave daemon started (pid: ${process.pid})`);
  console.log(`  IPC socket: ${socketPath}`);
  console.log(`  Agent ID:   ${config.agentId}`);

  // Shutdown handler
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('Daemon shutting down...');

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    messageHandler.cleanup();
    terminalManager.shutdown();
    connection.disconnect();
    if (debugHttpServer) await debugHttpServer.close();
    await ipcServer.close();
    removeServiceState();
    cleanStaleRuntime();
    releaseLock();

    process.exit(0);
  };

  ipcServer.on('shutdown-requested', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------------------
// IPC method registration
// ---------------------------------------------------------------------------

function registerDaemonMethods(
  ipcServer: IpcServer,
  connection: AgentConnection,
  messageHandler: MessageHandler,
  config: AgentConfig,
): void {
  // get-agent-state — C4 coarse pair state + identity snapshot for CLI.
  // Reads fresh config on every call so rotation from `unlock-pairing` or a
  // tombstone is reflected immediately.
  ipcServer.registerMethod('get-agent-state', (): AgentStateResult => {
    const current = loadConfig() ?? config;
    return {
      state: connection.getState(),
      agentId: current.agentId,
      publicKey: current.keyPair.publicKey,
      signPublicKey: current.signKeyPair.publicKey,
      peerPWAPublicKey: current.peerPWAPublicKey ?? null,
      peerPWASignPublicKey: current.peerPWASignPublicKey ?? null,
      peerCount: connection.getPeerCount(),
      connectionState: connection.hasPeers() ? 'connected' : 'disconnected',
    };
  });

  // unlock-pairing — exits `closed` state and rotates the agent's own
  // cryptographic identity (agentId + X25519 + Ed25519). Awaits signaling
  // reconnect so `get-pairing-info` right after returns a live address.
  ipcServer.registerMethod('unlock-pairing', async (): Promise<UnlockPairingResult> => {
    const previousState = connection.getState();
    await connection.unlockPairing();
    return { previousState, state: connection.getState() };
  });

  // get-pairing-info — always reads fresh config so rotations are reflected
  ipcServer.registerMethod('get-pairing-info', (): PairingInfoResult => {
    const current = loadConfig() ?? config;
    const signPk = current.signKeyPair.publicKey;
    const pairingUrl = `https://quicksave.dev/#/connect/${current.agentId}?pk=${encodeURIComponent(current.keyPair.publicKey)}&spk=${encodeURIComponent(signPk)}&name=${encodeURIComponent(hostname())}`;
    return {
      agentId: current.agentId,
      publicKey: current.keyPair.publicKey,
      signPublicKey: signPk,
      pairingUrl,
      connectionState: connection.hasPeers() ? 'connected' : 'disconnected',
      peerCount: connection.getPeerCount(),
    };
  });

  // list-repos
  ipcServer.registerMethod('list-repos', async (): Promise<{ repos: RepoInfo[] }> => {
    const paths = getManagedRepos();
    const repos: RepoInfo[] = [];
    for (const path of paths) {
      const git = new GitOperations(path);
      const valid = await git.isValidRepo();
      let currentBranch: string | undefined;
      if (valid) {
        try {
          const branches = await git.getBranches();
          currentBranch = branches.current;
        } catch { /* ignore */ }
      }
      repos.push({ path, name: basename(path), valid, currentBranch });
    }
    return { repos };
  });

  // add-repo
  ipcServer.registerMethod('add-repo', async (params): Promise<{ added: boolean; repo?: RepoInfo }> => {
    const path = params.path as string;
    if (!path) throw Object.assign(new Error('Missing path'), { rpcCode: -32602 });

    const git = new GitOperations(path);
    const valid = await git.isValidRepo();
    if (!valid) {
      throw Object.assign(new Error(`Not a valid git repository: ${path}`), { rpcCode: -32602 });
    }

    addManagedRepo(path);

    const rootPath = await git.getGitRoot();
    const branches = await git.getBranches();
    const repo: RepoInfo = { path: rootPath, name: basename(rootPath), valid: true, currentBranch: branches.current };

    // Update running message handler so PWA can use the repo immediately
    messageHandler.addRepo({ path: rootPath, name: basename(rootPath), currentBranch: branches.current });

    ipcServer.broadcast({
      jsonrpc: '2.0',
      method: 'event.repoAdded',
      params: { repo },
    });

    return { added: true, repo };
  });

  // remove-repo
  ipcServer.registerMethod('remove-repo', (params): { removed: boolean } => {
    const path = params.path as string;
    if (!path) throw Object.assign(new Error('Missing path'), { rpcCode: -32602 });

    removeManagedRepo(path);
    messageHandler.removeRepo(path);

    ipcServer.broadcast({
      jsonrpc: '2.0',
      method: 'event.repoRemoved',
      params: { path },
    });

    return { removed: true };
  });

  // restart
  ipcServer.registerMethod('restart', (): { ok: true } => {
    process.nextTick(() => ipcServer.emit('shutdown-requested'));
    return { ok: true };
  });

  // Debug methods — gated by QUICKSAVE_DEBUG / dev mode
  if (!isDebugEnabled()) return;

  // debug — full daemon introspection snapshot
  ipcServer.registerMethod('debug', (): DebugResult => {
    const connState = connection.getDebugState();
    const claudeState = messageHandler.getClaudeService().getDebugState();
    return {
      pid: process.pid,
      uptime: process.uptime(),
      peers: connState.peers,
      subscriptions: connState.subscriptions,
      pendingInputs: claudeState.pendingInputs,
      activeSessions: claudeState.activeSessions,
    };
  });

  // resolve-input — force-resolve a stuck permission request
  ipcServer.registerMethod('resolve-input', (params): { resolved: boolean } => {
    const requestId = params.requestId as string;
    const action = (params.action as string) || 'allow';
    if (!requestId) throw Object.assign(new Error('Missing requestId'), { rpcCode: -32602 });
    const resolved = messageHandler.getClaudeService().resolveUserInput({
      requestId,
      sessionId: '',
      action: action as 'allow' | 'deny',
    });
    return { resolved };
  });

  // list-sessions — SDK sessions enriched with live state
  ipcServer.registerMethod('list-sessions', async (params): Promise<{ sessions: unknown[] }> => {
    const cwd = (params.cwd as string) || getManagedRepos()[0] || process.cwd();
    const sessions = await messageHandler.getClaudeService().listAvailableSessions(cwd);
    return { sessions };
  });

  // get-cards — card history for a session
  ipcServer.registerMethod('get-cards', async (params): Promise<unknown> => {
    const sessionId = params.sessionId as string;
    const cwd = (params.cwd as string) || getManagedRepos()[0] || process.cwd();
    const offset = (params.offset as number) || 0;
    const limit = (params.limit as number) || 50;
    if (!sessionId) throw Object.assign(new Error('Missing sessionId'), { rpcCode: -32602 });
    return messageHandler.getClaudeService().getCards(sessionId, cwd, offset, limit);
  });
}

// ---------------------------------------------------------------------------
// Repo validation helper
// ---------------------------------------------------------------------------

async function validateRepos(paths: string[]): Promise<Repository[]> {
  const repos: Repository[] = [];
  const removed: string[] = [];
  for (const repoPath of paths) {
    if (!existsSync(repoPath)) {
      console.warn(`  Removing missing repo: ${repoPath}`);
      removed.push(repoPath);
      continue;
    }
    const git = new GitOperations(repoPath);
    const valid = await git.isValidRepo();
    if (!valid) {
      console.warn(`  Skipping invalid repo: ${repoPath}`);
      continue;
    }
    try {
      const rootPath = await git.getGitRoot();
      const { current: currentBranch } = await git.getBranches();
      repos.push({ path: rootPath, name: basename(rootPath), currentBranch });
    } catch (err) {
      console.warn(`  Failed to read repo: ${repoPath}`, err);
    }
  }
  for (const p of removed) removeManagedRepo(p);
  return repos;
}
