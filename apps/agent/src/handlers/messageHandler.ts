// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import {
  Message,
  createMessage,
  StatusRequestPayload,
  StatusResponsePayload,
  DiffRequestPayload,
  DiffResponsePayload,
  StageRequestPayload,
  StageResponsePayload,
  UnstageRequestPayload,
  UnstageResponsePayload,
  StagePatchRequestPayload,
  StagePatchResponsePayload,
  UnstagePatchRequestPayload,
  UnstagePatchResponsePayload,
  CommitRequestPayload,
  CommitResponsePayload,
  LogRequestPayload,
  LogResponsePayload,
  BranchesResponsePayload,
  CheckoutRequestPayload,
  CheckoutResponsePayload,
  DiscardRequestPayload,
  DiscardResponsePayload,
  UntrackRequestPayload,
  UntrackResponsePayload,
  SubmodulesResponsePayload,
  GitConfigGetResponsePayload,
  GitConfigSetRequestPayload,
  GitConfigSetResponsePayload,
  GitignoreAddRequestPayload,
  GitignoreAddResponsePayload,
  GitignoreReadResponsePayload,
  GitignoreWriteRequestPayload,
  GitignoreWriteResponsePayload,
  ErrorPayload,
  HandshakePayload,
  HandshakeAckPayload,
  License,
  GenerateCommitSummaryRequestPayload,
  GenerateCommitSummaryResponsePayload,
  ClearCommitSummaryRequestPayload,
  ClearCommitSummaryResponsePayload,
  SetApiKeyRequestPayload,
  SetApiKeyResponsePayload,
  GetApiKeyStatusResponsePayload,
  Repository,
  ListReposResponsePayload,
  SwitchRepoRequestPayload,
  SwitchRepoResponsePayload,
  BrowseDirectoryRequestPayload,
  BrowseDirectoryResponsePayload,
  DirectoryEntry,
  AddRepoRequestPayload,
  AddRepoResponsePayload,
  CloneRepoRequestPayload,
  CloneRepoResponsePayload,
  CodingPath,
  ListCodingPathsResponsePayload,
  AddCodingPathRequestPayload,
  AddCodingPathResponsePayload,
  RemoveRepoRequestPayload,
  RemoveRepoResponsePayload,
  RemoveCodingPathRequestPayload,
  RemoveCodingPathResponsePayload,
  AgentCheckUpdateResponsePayload,
  AgentUpdateResponsePayload,
  AgentRestartResponsePayload,
  ClaudeStartRequestPayload,
  ClaudeStartResponsePayload,
  ClaudeResumeRequestPayload,
  ClaudeResumeResponsePayload,
  ClaudeCancelRequestPayload,
  ClaudeCancelResponsePayload,
  ClaudeCloseRequestPayload,
  ClaudeCloseResponsePayload,
  ClaudeEndTaskRequestPayload,
  ClaudeEndTaskResponsePayload,
  ClaudeGetMessagesRequestPayload,
  ClaudeUserInputResponsePayload,
  ClaudeSetPreferencesRequestPayload,
  ClaudeSetPreferencesResponsePayload,
  ClaudeSetSessionPermissionRequestPayload,
  ClaudeSetSessionPermissionResponsePayload,
  CardHistoryResponse,
  AttachmentUploadRequestPayload,
  AttachmentUploadResponsePayload,
  AttachmentCancelRequestPayload,
  AttachmentCancelResponsePayload,
  AttachmentFetchRequestPayload,
  AttachmentFetchResponsePayload,
  SessionSetConfigRequestPayload,
  SessionSetConfigResponsePayload,
  SessionControlRequestPayload,
  SessionControlRequestResponsePayload,
  SessionRegistryEntry,
  SessionUpdateHistoryRequestPayload,
  SessionUpdateHistoryResponsePayload,
  SessionDeleteHistoryRequestPayload,
  SessionDeleteHistoryResponsePayload,
  SessionListArchivedRequestPayload,
  SessionListArchivedResponsePayload,
  SessionMarkReadRequestPayload,
  SessionMarkReadResponsePayload,
  AgentId,
  CodexModelInfo,
  CodexListModelsResponsePayload,
  CodexLoginStartResponsePayload,
  CodexLoginStatusResponsePayload,
  CodexLoginCancelResponsePayload,
  ProjectListSummariesResponsePayload,
  ProjectSummary,
  ProjectDeleteRequestPayload,
  ProjectDeleteResponsePayload,
  ProjectListReposRequestPayload,
  ProjectListReposResponsePayload,
  ProjectRepo,
  PushSubscriptionOfferPayload,
  PushSubscriptionOfferResponsePayload,
  TerminalCreateRequestPayload,
  TerminalCreateResponsePayload,
  TerminalInputRequestPayload,
  TerminalInputResponsePayload,
  TerminalResizeRequestPayload,
  TerminalResizeResponsePayload,
  TerminalCloseRequestPayload,
  TerminalCloseResponsePayload,
  TerminalRenameRequestPayload,
  TerminalRenameResponsePayload,
  FilesListRequestPayload,
  FilesListResponsePayload,
  FilesReadRequestPayload,
  FilesReadResponsePayload,
  SystemdStatusResponsePayload,
  SystemdInstallResponsePayload,
  SystemdUninstallResponsePayload,
} from '@sumicom/quicksave-shared';
import {
  getSystemdStatus,
  installUserUnit,
  uninstallUserUnit,
  systemctlAvailable,
} from '../service/systemdUnit.js';
import { GitOperations } from '../git/operations.js';
import type { PushClient } from '../service/pushClient.js';
import { getAnthropicApiKey, setAnthropicApiKey, hasAnthropicApiKey, addManagedRepo, removeManagedRepo, addManagedCodingPath, removeManagedCodingPath } from '../config.js';
import { CommitSummaryService } from '../ai/commitSummary.js';
import { CommitSummaryCliService, CommitSummaryCliError } from '../ai/commitSummaryCli.js';
import { CommitSummaryStateStore } from '../ai/commitSummaryStore.js';
import { SessionManager } from '../ai/sessionManager.js';
import { ClaudeCodeProvider } from '../ai/claudeCodeProvider.js';
import { AttachmentStaging } from '../ai/attachmentStaging.js';
import { loadAttachment, removeSessionAttachments } from '../ai/attachmentStore.js';
import { CodexAppServerProvider } from '../ai/codexAppServer/index.js';
import { CodexLoginManager } from '../ai/codexLogin.js';
import { getTerminalManager } from '../terminal/terminalManager.js';
import { getFileBrowser } from '../files/fileBrowser.js';
import { getSessionRegistry } from '../ai/sessionRegistry.js';
import { enrichEntry } from '../ai/enrichEntry.js';
import { getEventStore } from '../storage/eventStore.js';
import { readdir, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir, platform as osPlatform } from 'os';
import { spawnAppServer } from '../ai/codexAppServer/index.js';
import type { Model as CodexAppServerModel } from '../ai/codexAppServer/schema/generated/v2/Model.js';

const VERSION_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
// model/list reflects the current authenticated account's available models.
// 30 min strikes a balance: long enough to avoid spawning a fresh app-server
// every PWA reload; short enough that plan upgrades / model rollouts surface
// within the same session day. Force-refreshes still bypass the TTL.
const CODEX_MODELS_TTL_MS = 30 * 60 * 1000;

/** Coerce `os.platform()` into the narrow union the PWA expects. Anything
 *  outside the three first-class platforms gets `'other'` so the field is
 *  always present and the PWA doesn't have to handle `undefined`. */
function normalizePlatform(p: NodeJS.Platform): 'linux' | 'darwin' | 'win32' | 'other' {
  if (p === 'linux' || p === 'darwin' || p === 'win32') return p;
  return 'other';
}

/** Shallow equality on a model list. Used to suppress no-op
 *  `/codex/models` broadcasts after a TTL refresh that returned the
 *  same list. */
function codexModelListsEqual(
  a: CodexModelInfo[] | undefined,
  b: CodexModelInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i];
    if (ai.id !== bi.id || ai.name !== bi.name) return false;
    if (ai.defaultReasoningEffort !== bi.defaultReasoningEffort) return false;
    if (ai.isDefault !== bi.isDefault) return false;
    const aE = ai.reasoningEfforts, bE = bi.reasoningEfforts;
    if (aE !== bE) {
      if (!aE || !bE) return false;
      if (aE.length !== bE.length) return false;
      for (let j = 0; j < aE.length; j++) if (aE[j] !== bE[j]) return false;
    }
  }
  return true;
}

/** Map a single `model/list` entry to the lean `CodexModelInfo` the PWA
 *  picker consumes. Hidden models (e.g. `codex-auto-review`) are caller-
 *  filtered before this runs. */
function projectAppServerModel(m: CodexAppServerModel): CodexModelInfo {
  const reasoningEfforts: string[] = [];
  for (const opt of m.supportedReasoningEfforts) {
    if (typeof opt.reasoningEffort === 'string') reasoningEfforts.push(opt.reasoningEffort);
  }
  return {
    id: m.id,
    name: m.displayName || m.id,
    reasoningEfforts: reasoningEfforts.length > 0 ? reasoningEfforts : undefined,
    defaultReasoningEffort: m.defaultReasoningEffort,
    isDefault: m.isDefault || undefined,
  };
}

export class MessageHandler {
  private repos: Map<string, GitOperations>;
  private agentVersion = '0.8.7';
  private defaultRepoPath: string;
  private clientRepos: Map<string, string> = new Map(); // peerAddress -> repoPath
  private repoLocks: Map<string, string> = new Map(); // repoPath -> peerAddress holding lock
  private availableRepos: Repository[];
  private codingPaths: Map<string, CodingPath> = new Map(); // path -> CodingPath
  private aiService: CommitSummaryService | null = null;
  private aiCliService: CommitSummaryCliService | null = null;
  /** Per-repo agent-owned commit summary state. The daemon wires the
   *  `state-updated` event to `connection.broadcast` (see service/run.ts). */
  private commitSummaryStore: CommitSummaryStateStore = new CommitSummaryStateStore();
  private claudeService: SessionManager;
  private attachmentStaging: AttachmentStaging = new AttachmentStaging();
  private attachmentGcTimer: NodeJS.Timeout | null = null;
  private pushClient: PushClient | null = null;
  private latestVersionCache: { version: string; checkedAt: number } | null = null;
  private versionCheckInFlight: Promise<string | null> | null = null;
  private codexModelsCache: { models: CodexModelInfo[]; checkedAt: number } | null = null;
  private codexModelsCheckInFlight: Promise<CodexModelInfo[] | null> | null = null;
  private codexModelsUpdateHandler: ((models: CodexModelInfo[]) => void) | null = null;
  /** Override for tests; defaults to `~/.codex`. Still consulted by
   *  `getCodexLoginStatus` to read `auth.json`; no longer used for model
   *  discovery (that flows through `model/list` against a short-lived
   *  app-server instance). */
  private readonly codexCacheDir: string;
  private codexLoginManager = new CodexLoginManager();
  onHistoryUpdated?: (cwd: string, entry: SessionRegistryEntry, action: 'upsert' | 'delete') => void;

  private productionBuild: boolean;

  constructor(
    repos: Repository[],
    _license?: License,
    codingPaths?: string[],
    productionBuild = false,
    options?: {
      codexCacheDir?: string;
      /**
       * Override the default `[ClaudeCodeProvider, CodexAppServerProvider]` lineup.
       * Used by the e2e harness to inject a `StubProvider` that doesn't
       * spawn real CLIs. When provided, the lineup is wrapped in a fresh
       * `SessionManager` exactly the same way the daemon does in `run.ts`.
       */
      sessionManager?: SessionManager;
    },
  ) {
    this.repos = new Map();
    for (const repo of repos) {
      this.repos.set(repo.path, new GitOperations(repo.path));
    }
    this.availableRepos = repos;
    this.defaultRepoPath = repos.length > 0 ? repos[0].path : '';
    this.productionBuild = productionBuild;
    this.claudeService = options?.sessionManager
      ?? new SessionManager([new ClaudeCodeProvider(), new CodexAppServerProvider()]);
    this.codexCacheDir = options?.codexCacheDir ?? join(homedir(), '.codex');

    // Load explicit coding paths only (repos and coding paths are independent)
    if (codingPaths) {
      for (const p of codingPaths) {
        this.codingPaths.set(p, { path: p, name: basename(p) });
      }
    }

    this.attachmentGcTimer = setInterval(() => this.attachmentStaging.gc(), 60_000);
    if (typeof (this.attachmentGcTimer as { unref?: () => void }).unref === 'function') {
      (this.attachmentGcTimer as { unref?: () => void }).unref!();
    }
  }

  /**
   * Check npm registry for latest version. Deduped: returns cached value
   * if checked within the last 12 hours. Only runs in production builds.
   */
  private async checkLatestVersion(force = false): Promise<string | null> {
    if (!force && !this.productionBuild) return null;

    // Return cached value if fresh
    if (!force && this.latestVersionCache &&
        Date.now() - this.latestVersionCache.checkedAt < VERSION_CHECK_INTERVAL_MS) {
      return this.latestVersionCache.version;
    }

    // Dedup concurrent requests
    if (this.versionCheckInFlight) return this.versionCheckInFlight;

    this.versionCheckInFlight = (async () => {
      try {
        const res = await fetch('https://registry.npmjs.org/@sumicom/quicksave/latest');
        if (!res.ok) return null;
        const data = await res.json() as { version?: string };
        if (data.version) {
          this.latestVersionCache = { version: data.version, checkedAt: Date.now() };
          return data.version;
        }
        return null;
      } catch {
        return null;
      } finally {
        this.versionCheckInFlight = null;
      }
    })();

    return this.versionCheckInFlight;
  }

  /**
   * Resolve the Codex model list for the current authenticated account.
   *
   * Source: `model/list` against a short-lived `codex app-server` instance.
   * The app-server already enforces account-scoped filtering — what we get
   * back is exactly the list this user can actually invoke (e.g. ChatGPT
   * users won't see `claude-*` models, API-key users see the API-tier list).
   * That's what makes this source authoritative: previously we fell through
   * three sources (`codex debug models` / on-disk cache file / OpenAI
   * `/v1/models`) none of which knew the caller's plan, so the picker
   * surfaced models that would later 400 with `BadRequest`.
   *
   * Returns `null` if the spawn fails or no models come back. Concurrent
   * calls dedup via `codexModelsCheckInFlight`. Cache TTL is single-tier
   * (30 min) — force-refresh bypasses it.
   */
  private async fetchCodexModels(force = false): Promise<CodexModelInfo[] | null> {
    if (!force && this.codexModelsCache) {
      if (Date.now() - this.codexModelsCache.checkedAt < CODEX_MODELS_TTL_MS) {
        return this.codexModelsCache.models;
      }
    }

    if (this.codexModelsCheckInFlight) return this.codexModelsCheckInFlight;

    this.codexModelsCheckInFlight = (async () => {
      const before = this.codexModelsCache?.models;
      try {
        const fromAppServer = await this.fetchCodexModelsFromAppServer();
        if (fromAppServer && fromAppServer.length > 0) {
          this.codexModelsCache = { models: fromAppServer, checkedAt: Date.now() };
          // Broadcast to bus subscribers when the list actually changes.
          // Same dedup behavior as the previous file-watcher path so a TTL
          // refresh that comes back with the same models is silent.
          if (!codexModelListsEqual(before, fromAppServer)) {
            this.codexModelsUpdateHandler?.(fromAppServer);
          }
          return fromAppServer;
        }
        return null;
      } catch {
        return null;
      } finally {
        this.codexModelsCheckInFlight = null;
      }
    })();

    return this.codexModelsCheckInFlight;
  }

  /**
   * Spawn a short-lived `codex app-server`, run `initialize` + `model/list`,
   * shut down. Filters out `hidden: true` models (e.g. `codex-auto-review`)
   * so they don't leak into the picker. Returns `null` on any failure —
   * caller treats null as "no source available, picker falls back to
   * hard-coded defaults".
   */
  private async fetchCodexModelsFromAppServer(): Promise<CodexModelInfo[] | null> {
    let handle: Awaited<ReturnType<typeof spawnAppServer>> | null = null;
    try {
      handle = await spawnAppServer({
        clientInfo: { name: 'quicksave-agent', title: 'Quicksave Agent', version: '0.0.0' },
        capabilities: { experimentalApi: false, optOutNotificationMethods: null },
      });
      const res = await handle.rpc.request<{ data: CodexAppServerModel[]; nextCursor: string | null }>(
        'model/list',
        { cursor: null, limit: null, includeHidden: false },
      );
      return res.data
        .filter((m) => !m.hidden)
        .map((m) => projectAppServerModel(m));
    } catch (err) {
      console.warn('[codex-models] model/list failed:', err instanceof Error ? err.message : err);
      return null;
    } finally {
      if (handle) {
        try { await handle.shutdown(); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Resolve a user-provided model into one the current account actually
   * supports. If the cache is empty (model/list never succeeded) the
   * requested value passes through — we'd rather try and let codex 400 than
   * silently swallow a model the user explicitly chose. If the cache exists
   * but the requested model isn't in it, we fall back to whichever model
   * `model/list` flagged as `isDefault` (e.g. ChatGPT account picks `gpt-5.5`).
   * Non-codex agents are pass-through; their model space is independent.
   */
  validateCodexModel(requested: string | undefined, agentId: AgentId): string | undefined {
    if (agentId !== 'codex') return requested;
    const cached = this.codexModelsCache?.models;
    if (!cached || cached.length === 0) return requested;
    if (requested && cached.some((m) => m.id === requested)) return requested;
    const fallback = cached.find((m) => m.isDefault) ?? cached[0];
    if (requested && fallback?.id !== requested) {
      console.warn(`[codex-models] requested model "${requested}" not in account list; coercing to "${fallback?.id}"`);
    }
    return fallback?.id ?? requested;
  }

  /** Snapshot accessor for the bus `/codex/models` subscription. */
  getCachedCodexModels(): CodexModelInfo[] {
    return this.codexModelsCache?.models ?? [];
  }

  /**
   * Wire the daemon's bus broadcast for unsolicited model-list pushes.
   * Called once during daemon boot; the watcher invokes this on cache change.
   */
  setCodexModelsUpdateHandler(handler: (models: CodexModelInfo[]) => void): void {
    this.codexModelsUpdateHandler = handler;
  }

  /**
   * Prime the in-memory cache at daemon boot. No-op if already cached.
   * Replaces the previous file-watcher path: there's no on-disk file we
   * watch any more, so the only refresh trigger is TTL expiry (30 min)
   * or an explicit `force=true` call. The eager prime keeps the first
   * `/codex/models` subscriber from getting an empty snapshot.
   */
  primeCodexModelsCache(): void {
    void this.fetchCodexModels().catch(() => {});
  }

  /**
   * Best-effort check for whether the local Codex CLI has valid auth.
   * The PWA uses this to prompt for login when it returns false. Does not
   * validate the token — just checks that a credential source exists.
   */
  private async getCodexLoginStatus(): Promise<{ loggedIn: boolean; method?: 'chatgpt' | 'api-key' }> {
    if (process.env.OPENAI_API_KEY) return { loggedIn: true, method: 'api-key' };
    try {
      const authPath = join(this.codexCacheDir, 'auth.json');
      const raw = await readFile(authPath, 'utf-8');
      const auth = JSON.parse(raw) as {
        OPENAI_API_KEY?: string;
        tokens?: { access_token?: string };
      };
      if (auth.OPENAI_API_KEY) return { loggedIn: true, method: 'api-key' };
      if (auth.tokens?.access_token) return { loggedIn: true, method: 'chatgpt' };
    } catch { /* no auth file */ }
    return { loggedIn: false };
  }

  addRepo(repo: Repository): void {
    if (this.repos.has(repo.path)) return;
    this.repos.set(repo.path, new GitOperations(repo.path));
    this.availableRepos.push(repo);
    if (!this.defaultRepoPath) {
      this.defaultRepoPath = repo.path;
    }
  }

  removeRepo(path: string): void {
    this.repos.delete(path);
    this.availableRepos = this.availableRepos.filter((r) => r.path !== path);
    if (this.defaultRepoPath === path) {
      this.defaultRepoPath = this.availableRepos.length > 0 ? this.availableRepos[0].path : '';
    }
    // Drop stale per-peer pins to this path so the next handshake-ack
    // doesn't return a deleted repo.
    for (const [peer, repo] of this.clientRepos) {
      if (repo === path) this.clientRepos.delete(peer);
    }
  }

  private getClientRepoPath(peerAddress: string): string {
    return this.clientRepos.get(peerAddress) || this.defaultRepoPath;
  }

  private getGit(peerAddress: string): GitOperations {
    const repoPath = this.getClientRepoPath(peerAddress);
    const git = this.repos.get(repoPath);
    if (!git) {
      throw new Error('No repository selected. Please add a repository first.');
    }
    return git;
  }

  private acquireRepoLock(repoPath: string, peerAddress: string): boolean {
    const holder = this.repoLocks.get(repoPath);
    if (holder && holder !== peerAddress) {
      return false;
    }
    this.repoLocks.set(repoPath, peerAddress);
    return true;
  }

  private releaseRepoLock(repoPath: string, peerAddress: string): void {
    if (this.repoLocks.get(repoPath) === peerAddress) {
      this.repoLocks.delete(repoPath);
    }
  }

  removeClient(peerAddress: string): void {
    // Intentionally keep `clientRepos[peer]`: peer identity is a stable
    // public key, and the PWA keeps its selected repo across reconnects
    // (e.g., background → resume). Clearing would force the next
    // handshake-ack to return `defaultRepoPath`, which the PWA would then
    // hydrate into gitStore before its post-reconnect `agent:switch-repo`
    // can land — racing `git:status` requests stamped with the default
    // path would pass the REPO_MISMATCH guard and paint the default
    // repo's (typically clean) status over the user's real repo view.
    for (const [repoPath, holder] of this.repoLocks) {
      if (holder === peerAddress) {
        this.repoLocks.delete(repoPath);
      }
    }
    // Drop any in-flight uploads from this peer; on reconnect the PWA will
    // re-stage them via the upload manager's resume path.
    this.attachmentStaging.removePeer(peerAddress);
    // Pending user input requests are NOT auto-approved on disconnect.
    // They persist until the user reconnects and explicitly responds.
  }

  cleanup(): void {
    if (this.attachmentGcTimer) {
      clearInterval(this.attachmentGcTimer);
      this.attachmentGcTimer = null;
    }
    this.claudeService.cleanup();
  }

  getActiveSessionCount(): number {
    return this.claudeService.getActiveSessionCount();
  }

  /** Exposed so the daemon can wire state-updated events to broadcasts. */
  getCommitSummaryStore(): CommitSummaryStateStore {
    return this.commitSummaryStore;
  }

  getClaudeService(): SessionManager {
    return this.claudeService;
  }

  /** Daemon wires this after construction so push:subscription-offer can
   *  forward to the relay. Absent in tests or when VAPID/signaling aren't
   *  configured — offer responses will report an error in that case. */
  setPushClient(client: PushClient | null): void {
    this.pushClient = client;
  }

  getPushClient(): PushClient | null {
    return this.pushClient;
  }

  private getAiService(): CommitSummaryService | null {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) return null;

    // Create service lazily and reuse for caching
    if (!this.aiService) {
      this.aiService = new CommitSummaryService(apiKey);
    }
    return this.aiService;
  }

  async handleMessage(
    message: Message,
    peerAddress: string = 'default',
  ): Promise<Message> {
    const isVerbose =
      message.type.startsWith('claude:') ||
      message.type.startsWith('agent:add') ||
      message.type.startsWith('project:') ||
      message.type.startsWith('attachment:');
    if (isVerbose) {
      console.log(`[msg] ${message.type} from ${peerAddress.slice(0, 12)}`);
    }

    // Repo-scoped guard for git:* requests. The PWA stamps `repoPath` on
    // each request so a response can't be misapplied if the user has since
    // switched repos. If the envelope's repoPath differs from the peer's
    // current repo, reject with REPO_MISMATCH so the client can discard
    // rather than render stale data.
    if (
      message.type.startsWith('git:') &&
      !message.type.endsWith(':response') &&
      typeof message.repoPath === 'string'
    ) {
      const currentRepo = this.getClientRepoPath(peerAddress);
      if (message.repoPath !== currentRepo) {
        const err = this.createErrorResponse(
          message.id,
          'REPO_MISMATCH',
          `Repo mismatch: request expected ${message.repoPath}, peer is on ${currentRepo}`,
        );
        err.repoPath = currentRepo;
        return err;
      }
    }

    const response = await this.dispatch(message, peerAddress);

    // Stamp git:* responses with the repo the agent actually used so the
    // PWA can validate before applying to the store.
    if (response.type.startsWith('git:') && response.type.endsWith(':response')) {
      response.repoPath = this.getClientRepoPath(peerAddress);
    }
    return response;
  }

  private async dispatch(message: Message, peerAddress: string): Promise<Message> {
    switch (message.type) {
        case 'handshake':
          return this.handleHandshake(message as Message<HandshakePayload>, peerAddress);
        case 'ping':
          return createMessage('pong', { timestamp: Date.now() });
        case 'git:status':
          return this.handleStatus(message as Message<StatusRequestPayload>, peerAddress);
        case 'git:diff':
          return this.handleDiff(message as Message<DiffRequestPayload>, peerAddress);
        case 'git:stage':
          return this.handleStage(message as Message<StageRequestPayload>, peerAddress);
        case 'git:unstage':
          return this.handleUnstage(message as Message<UnstageRequestPayload>, peerAddress);
        case 'git:stage-patch':
          return this.handleStagePatch(message as Message<StagePatchRequestPayload>, peerAddress);
        case 'git:unstage-patch':
          return this.handleUnstagePatch(message as Message<UnstagePatchRequestPayload>, peerAddress);
        case 'git:commit':
          return this.handleCommit(message as Message<CommitRequestPayload>, peerAddress);
        case 'git:log':
          return this.handleLog(message as Message<LogRequestPayload>, peerAddress);
        case 'git:branches':
          return this.handleBranches(peerAddress);
        case 'git:checkout':
          return this.handleCheckout(message as Message<CheckoutRequestPayload>, peerAddress);
        case 'git:discard':
          return this.handleDiscard(message as Message<DiscardRequestPayload>, peerAddress);
        case 'git:untrack':
          return this.handleUntrack(message as Message<UntrackRequestPayload>, peerAddress);
        case 'git:submodules':
          return this.handleSubmodules(message, peerAddress);
        case 'git:config-get':
          return this.handleGitConfigGet(message, peerAddress);
        case 'git:config-set':
          return this.handleGitConfigSet(message as Message<GitConfigSetRequestPayload>, peerAddress);
        case 'git:gitignore-add':
          return this.handleGitignoreAdd(message as Message<GitignoreAddRequestPayload>, peerAddress);
        case 'git:gitignore-read':
          return this.handleGitignoreRead(message, peerAddress);
        case 'git:gitignore-write':
          return this.handleGitignoreWrite(message as Message<GitignoreWriteRequestPayload>, peerAddress);
        case 'ai:generate-commit-summary':
          return this.handleGenerateCommitSummary(message as Message<GenerateCommitSummaryRequestPayload>, peerAddress);
        case 'ai:commit-summary:clear':
          return this.handleClearCommitSummary(message as Message<ClearCommitSummaryRequestPayload>, peerAddress);
        case 'ai:set-api-key':
          return this.handleSetApiKey(message as Message<SetApiKeyRequestPayload>);
        case 'ai:get-api-key-status':
          return this.handleGetApiKeyStatus(message);
        case 'agent:list-repos':
          return this.handleListRepos(message, peerAddress);
        case 'agent:switch-repo':
          return this.handleSwitchRepo(message as Message<SwitchRepoRequestPayload>, peerAddress);
        case 'agent:browse-directory':
          return this.handleBrowseDirectory(message as Message<BrowseDirectoryRequestPayload>);
        case 'agent:add-repo':
          return this.handleAddRepo(message as Message<AddRepoRequestPayload>);
        case 'agent:remove-repo':
          return this.handleRemoveRepo(message as Message<RemoveRepoRequestPayload>);
        case 'agent:clone-repo':
          return this.handleCloneRepo(message as Message<CloneRepoRequestPayload>);
        case 'agent:list-coding-paths':
          return this.handleListCodingPaths(message);
        case 'agent:add-coding-path':
          return this.handleAddCodingPath(message as Message<AddCodingPathRequestPayload>);
        case 'agent:remove-coding-path':
          return this.handleRemoveCodingPath(message as Message<RemoveCodingPathRequestPayload>);
        case 'agent:check-update':
          return this.handleAgentCheckUpdate(message);
        case 'agent:update':
          return this.handleAgentUpdate(message);
        case 'agent:restart':
          return this.handleAgentRestart(message);
        case 'systemd:status':
          return this.handleSystemdStatus(message);
        case 'systemd:install':
          return this.handleSystemdInstall(message);
        case 'systemd:uninstall':
          return this.handleSystemdUninstall(message);
        case 'codex:list-models':
          return this.handleCodexListModels(message);
        case 'codex:login-start':
          return this.handleCodexLoginStart(message);
        case 'codex:login-status':
          return this.handleCodexLoginStatus(message);
        case 'codex:login-cancel':
          return this.handleCodexLoginCancel(message);
        // Claude Code SDK
        case 'claude:start':
          return this.handleClaudeStart(message as Message<ClaudeStartRequestPayload>, peerAddress);
        case 'claude:resume':
          return this.handleClaudeResume(message as Message<ClaudeResumeRequestPayload>, peerAddress);
        case 'claude:cancel':
          return this.handleClaudeCancel(message as Message<ClaudeCancelRequestPayload>);
        case 'claude:close':
          return this.handleClaudeClose(message as Message<ClaudeCloseRequestPayload>);
        case 'claude:end-task':
          return this.handleClaudeEndTask(message as Message<ClaudeEndTaskRequestPayload>);
        case 'claude:user-input-response':
          return this.handleClaudeUserInputResponse(message as Message<ClaudeUserInputResponsePayload>);
        case 'claude:set-preferences':
          return this.handleSetPreferences(message as Message<ClaudeSetPreferencesRequestPayload>);
        case 'claude:set-session-permission':
          return this.handleSetSessionPermission(message as Message<ClaudeSetSessionPermissionRequestPayload>);
        case 'claude:get-cards':
          return this.handleClaudeGetCards(message as Message<ClaudeGetMessagesRequestPayload>, peerAddress);
        case 'session:set-config':
          return this.handleSetSessionConfig(message as Message<SessionSetConfigRequestPayload>);
        case 'session:control-request':
          return this.handleControlRequest(message as Message<SessionControlRequestPayload>);
        case 'session:update-history':
          return this.handleUpdateHistory(message as Message<SessionUpdateHistoryRequestPayload>);
        case 'session:delete-history':
          return this.handleDeleteHistory(message as Message<SessionDeleteHistoryRequestPayload>);
        case 'session:list-archived':
          return this.handleListArchived(message as Message<SessionListArchivedRequestPayload>);
        case 'session:mark-read':
          return this.handleMarkRead(message as Message<SessionMarkReadRequestPayload>);
        case 'project:list-summaries':
          return this.handleListProjectSummaries(message);
        case 'project:list-repos':
          return await this.handleListProjectRepos(message as Message<ProjectListReposRequestPayload>);
        case 'project:delete':
          return this.handleDeleteProject(message as Message<ProjectDeleteRequestPayload>);
        case 'push:subscription-offer':
          return this.handlePushSubscriptionOffer(message as Message<PushSubscriptionOfferPayload>);
        case 'terminal:create':
          return this.handleTerminalCreate(message as Message<TerminalCreateRequestPayload>);
        case 'terminal:input':
          return this.handleTerminalInput(message as Message<TerminalInputRequestPayload>);
        case 'terminal:resize':
          return this.handleTerminalResize(message as Message<TerminalResizeRequestPayload>);
        case 'terminal:close':
          return this.handleTerminalClose(message as Message<TerminalCloseRequestPayload>);
        case 'terminal:rename':
          return this.handleTerminalRename(message as Message<TerminalRenameRequestPayload>);
        case 'files:list':
          return this.handleFilesList(message as Message<FilesListRequestPayload>);
        case 'files:read':
          return this.handleFilesRead(message as Message<FilesReadRequestPayload>);
        case 'attachment:upload':
          return this.handleAttachmentUpload(message as Message<AttachmentUploadRequestPayload>, peerAddress);
        case 'attachment:cancel':
          return this.handleAttachmentCancel(message as Message<AttachmentCancelRequestPayload>, peerAddress);
        case 'attachment:fetch':
          return this.handleAttachmentFetch(message as Message<AttachmentFetchRequestPayload>);
        default:
          return this.createErrorResponse(message.id, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`);
    }
  }

  private handleHandshake(
    message: Message<HandshakePayload>,
    peerAddress: string,
  ): Message<HandshakeAckPayload> {
    // Fire-and-forget: check npm registry + OpenAI models (12h dedup each)
    this.checkLatestVersion().catch(() => {});
    this.fetchCodexModels().catch(() => {});

    const response = createMessage<HandshakeAckPayload>('handshake:ack', {
      success: true,
      agentVersion: this.agentVersion,
      repoPath: this.getClientRepoPath(peerAddress),
      availableRepos: this.availableRepos,
      availableCodingPaths: [...this.codingPaths.values()],
      preferences: this.claudeService.getPreferences(),
      latestVersion: this.latestVersionCache?.version,
      devBuild: !this.productionBuild || undefined,
      codexModels: this.codexModelsCache?.models,
      platform: normalizePlatform(osPlatform()),
    });
    response.id = message.id;

    return response;
  }

  private async handleStatus(message: Message<StatusRequestPayload>, peerAddress: string): Promise<Message<StatusResponsePayload>> {
    const status = await this.getGit(peerAddress).getStatus();
    const response = createMessage<StatusResponsePayload>('git:status:response', status);
    response.id = message.id;
    return response;
  }

  private async handleDiff(message: Message<DiffRequestPayload>, peerAddress: string): Promise<Message<DiffResponsePayload>> {
    const { path, staged } = message.payload;
    const diff = await this.getGit(peerAddress).getDiff(path, staged);
    const response = createMessage<DiffResponsePayload>('git:diff:response', diff);
    response.id = message.id;
    return response;
  }

  private async handleStage(message: Message<StageRequestPayload>, peerAddress: string): Promise<Message<StageResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<StageResponsePayload>('git:stage:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).stage(message.payload.paths);
      const response = createMessage<StageResponsePayload>('git:stage:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<StageResponsePayload>('git:stage:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stage files',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleUnstage(message: Message<UnstageRequestPayload>, peerAddress: string): Promise<Message<UnstageResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<UnstageResponsePayload>('git:unstage:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).unstage(message.payload.paths);
      const response = createMessage<UnstageResponsePayload>('git:unstage:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<UnstageResponsePayload>('git:unstage:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unstage files',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleStagePatch(message: Message<StagePatchRequestPayload>, peerAddress: string): Promise<Message<StagePatchResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<StagePatchResponsePayload>('git:stage-patch:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).stagePatch(message.payload.patch);
      const response = createMessage<StagePatchResponsePayload>('git:stage-patch:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<StagePatchResponsePayload>('git:stage-patch:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stage patch',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleUnstagePatch(message: Message<UnstagePatchRequestPayload>, peerAddress: string): Promise<Message<UnstagePatchResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<UnstagePatchResponsePayload>('git:unstage-patch:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).unstagePatch(message.payload.patch);
      const response = createMessage<UnstagePatchResponsePayload>('git:unstage-patch:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<UnstagePatchResponsePayload>('git:unstage-patch:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unstage patch',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleCommit(message: Message<CommitRequestPayload>, peerAddress: string): Promise<Message<CommitResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<CommitResponsePayload>('git:commit:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      const { message: commitMessage, description, attribution } = message.payload;
      const hash = await this.getGit(peerAddress).commit(commitMessage, description, attribution ?? true);
      // The pending AI suggestion describes the diff we just committed, so
      // it's stale now — clear it (also broadcasts state → idle to all peers).
      this.commitSummaryStore.clear(repoPath);
      const response = createMessage<CommitResponsePayload>('git:commit:response', {
        success: true,
        hash,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<CommitResponsePayload>('git:commit:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to commit',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleLog(message: Message<LogRequestPayload>, peerAddress: string): Promise<Message<LogResponsePayload>> {
    const limit = message.payload.limit || 50;
    const commits = await this.getGit(peerAddress).getLog(limit);
    const response = createMessage<LogResponsePayload>('git:log:response', { commits });
    response.id = message.id;
    return response;
  }

  private async handleBranches(peerAddress: string): Promise<Message<BranchesResponsePayload>> {
    const { branches, current } = await this.getGit(peerAddress).getBranches();
    return createMessage<BranchesResponsePayload>('git:branches:response', {
      branches,
      current,
    });
  }

  private async handleCheckout(message: Message<CheckoutRequestPayload>, peerAddress: string): Promise<Message<CheckoutResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<CheckoutResponsePayload>('git:checkout:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      const { branch, create } = message.payload;
      await this.getGit(peerAddress).checkout(branch, create);
      const response = createMessage<CheckoutResponsePayload>('git:checkout:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<CheckoutResponsePayload>('git:checkout:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to checkout',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleDiscard(message: Message<DiscardRequestPayload>, peerAddress: string): Promise<Message<DiscardResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<DiscardResponsePayload>('git:discard:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).discard(message.payload.paths);
      const response = createMessage<DiscardResponsePayload>('git:discard:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<DiscardResponsePayload>('git:discard:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to discard changes',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleUntrack(message: Message<UntrackRequestPayload>, peerAddress: string): Promise<Message<UntrackResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<UntrackResponsePayload>('git:untrack:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).untrack(message.payload.paths);
      const response = createMessage<UntrackResponsePayload>('git:untrack:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<UntrackResponsePayload>('git:untrack:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to untrack files',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleSubmodules(message: Message, peerAddress: string): Promise<Message<SubmodulesResponsePayload>> {
    const git = this.getGit(peerAddress);
    const subs = await git.getSubmodules();
    // Auto-register submodule paths so switch-repo works
    for (const sub of subs) {
      if (!this.repos.has(sub.path)) {
        this.repos.set(sub.path, new GitOperations(sub.path));
        this.availableRepos.push({ path: sub.path, name: sub.name, currentBranch: sub.branch });
      }
    }
    const response = createMessage<SubmodulesResponsePayload>('git:submodules:response', {
      submodules: subs.map((s) => ({ name: s.name, path: s.path, branch: s.branch })),
    });
    response.id = message.id;
    return response;
  }

  private async handleGitConfigGet(message: Message, peerAddress: string): Promise<Message<GitConfigGetResponsePayload>> {
    const identity = await this.getGit(peerAddress).getIdentity();
    const response = createMessage<GitConfigGetResponsePayload>('git:config-get:response', identity);
    response.id = message.id;
    return response;
  }

  private async handleGitConfigSet(message: Message<GitConfigSetRequestPayload>, peerAddress: string): Promise<Message<GitConfigSetResponsePayload>> {
    try {
      const { name, email } = message.payload;
      await this.getGit(peerAddress).setIdentity(name, email);
      const response = createMessage<GitConfigSetResponsePayload>('git:config-set:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<GitConfigSetResponsePayload>('git:config-set:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set git identity',
      });
      response.id = message.id;
      return response;
    }
  }

  private async handleGitignoreAdd(message: Message<GitignoreAddRequestPayload>, peerAddress: string): Promise<Message<GitignoreAddResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<GitignoreAddResponsePayload>('git:gitignore-add:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).addToGitignore(message.payload.pattern);
      const response = createMessage<GitignoreAddResponsePayload>('git:gitignore-add:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<GitignoreAddResponsePayload>('git:gitignore-add:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add to .gitignore',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleGitignoreRead(message: Message, peerAddress: string): Promise<Message<GitignoreReadResponsePayload>> {
    const { content, exists } = await this.getGit(peerAddress).readGitignore();
    const response = createMessage<GitignoreReadResponsePayload>('git:gitignore-read:response', { content, exists });
    response.id = message.id;
    return response;
  }

  private async handleGitignoreWrite(message: Message<GitignoreWriteRequestPayload>, peerAddress: string): Promise<Message<GitignoreWriteResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<GitignoreWriteResponsePayload>('git:gitignore-write:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).writeGitignore(message.payload.content);
      const response = createMessage<GitignoreWriteResponsePayload>('git:gitignore-write:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<GitignoreWriteResponsePayload>('git:gitignore-write:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write .gitignore',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  /**
   * Kick off AI commit-summary generation. Generation runs asynchronously and
   * streams progress + result via the `ai:commit-summary:updated` broadcast;
   * the request-response just confirms the kickoff (or reports a validation
   * failure that keeps the state idle, e.g. missing API key / no staged changes).
   */
  private async handleGenerateCommitSummary(
    message: Message<GenerateCommitSummaryRequestPayload>,
    peerAddress: string
  ): Promise<Message<GenerateCommitSummaryResponsePayload>> {
    const source = message.payload.source ?? 'api';
    const repoPath = this.getClientRepoPath(peerAddress);

    const respond = (payload: GenerateCommitSummaryResponsePayload) => {
      const r = createMessage<GenerateCommitSummaryResponsePayload>(
        'ai:generate-commit-summary:response',
        payload
      );
      r.id = message.id;
      return r;
    };

    // API source requires an Anthropic key; CLI source does not.
    let aiService: CommitSummaryService | null = null;
    if (source === 'api') {
      aiService = this.getAiService();
      if (!aiService) {
        return respond({
          success: false,
          error: 'Configure your API key in Settings',
          errorCode: 'NO_API_KEY',
        });
      }
    }

    // Validate staged changes exist before flipping the state into
    // `generating` — we don't want to show "generating…" just to immediately
    // error out on the same tick.
    try {
      const status = await this.getGit(peerAddress).getStatus();
      if (status.staged.length === 0) {
        return respond({
          success: false,
          error: 'No staged changes to summarize',
          errorCode: 'NO_STAGED_CHANGES',
        });
      }
    } catch (error) {
      return respond({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to inspect working tree',
        errorCode: 'API_ERROR',
      });
    }

    // Register the generation with the state store. The returned token lets
    // us detect supersession (the caller fired off a fresh generation while
    // this one was still running, or the state was cleared).
    let aborted = false;
    let cliChild: { kill: (sig?: NodeJS.Signals) => void } | undefined;
    const token = this.commitSummaryStore.startGenerating(repoPath, source, message.payload.model, () => {
      aborted = true;
      try { cliChild?.kill('SIGTERM'); } catch { /* ignore */ }
    });

    // Run generation asynchronously. Errors flow through the state store,
    // NOT through the kickoff response — the response has already been sent.
    void this.runCommitSummary(peerAddress, repoPath, token, source, message.payload, aiService, (child) => {
      cliChild = child;
      if (aborted) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
    });

    return respond({ success: true, state: this.commitSummaryStore.get(repoPath) });
  }

  /**
   * Background worker that actually runs the generation. Reports success,
   * progress, or failure through the CommitSummaryStateStore (which in turn
   * broadcasts `ai:commit-summary:updated` to all peers).
   */
  private async runCommitSummary(
    peerAddress: string,
    repoPath: string,
    token: symbol,
    source: 'api' | 'claude-cli',
    payload: GenerateCommitSummaryRequestPayload,
    aiService: CommitSummaryService | null,
    onSpawn: (child: { kill: (sig?: NodeJS.Signals) => void }) => void,
  ): Promise<void> {
    try {
      const git = this.getGit(peerAddress);
      const [recentLog, branchInfo, conventions] = await Promise.all([
        git.getLog(10).catch(() => []),
        git.getBranches().catch(() => ({ current: '' })),
        git.readCommitConventions().catch(() => undefined),
      ]);
      const recentCommits = recentLog.map((c) => c.message);
      const branchName = branchInfo.current;

      if (source === 'claude-cli') {
        const cliService = this.getAiCliService();
        const result = await cliService.generateSummary({
          repoPath,
          context: payload.context,
          model: payload.model,
          recentCommits: recentCommits.length > 0 ? recentCommits : undefined,
          branchName: branchName || undefined,
          conventions,
          attribution: payload.attribution,
          onProgress: (progress) => {
            this.commitSummaryStore.updateProgress(repoPath, token, progress);
          },
          onSpawn: (child) => {
            onSpawn(child);
          },
        });
        this.commitSummaryStore.setResult(repoPath, token, {
          summary: result.summary,
          description: result.description,
          tokenUsage: result.tokenUsage,
        });
        return;
      }

      // API path — fetch staged diffs fresh. No per-step progress today;
      // the single Anthropic round-trip is fast enough that phase updates add
      // little value. We still flip to `generating` so the UI shows a spinner.
      this.commitSummaryStore.updateProgress(repoPath, token, { phase: 'generating' });
      const status = await git.getStatus();
      const diffs = await Promise.all(
        status.staged.map((file) => git.getDiff(file.path, true))
      );
      const result = await aiService!.generateSummary({
        diffs,
        context: payload.context,
        model: payload.model,
        recentCommits: recentCommits.length > 0 ? recentCommits : undefined,
        branchName: branchName || undefined,
        conventions,
        attribution: payload.attribution,
      });
      this.commitSummaryStore.setResult(repoPath, token, {
        summary: result.summary,
        description: result.description,
        tokenUsage: result.tokenUsage,
        cached: result.cached,
      });
    } catch (error) {
      if (error instanceof CommitSummaryCliError) {
        this.commitSummaryStore.setError(repoPath, token, error.message, error.errorCode);
        return;
      }
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate summary';
      const isRateLimit = errorMessage.includes('rate_limit');
      this.commitSummaryStore.setError(
        repoPath,
        token,
        errorMessage,
        isRateLimit ? 'RATE_LIMITED' : 'API_ERROR',
      );
    }
  }

  private handleClearCommitSummary(
    message: Message<ClearCommitSummaryRequestPayload>,
    peerAddress: string,
  ): Message<ClearCommitSummaryResponsePayload> {
    const repoPath = message.payload.repoPath || this.getClientRepoPath(peerAddress);
    const state = this.commitSummaryStore.clear(repoPath);
    const response = createMessage<ClearCommitSummaryResponsePayload>('ai:commit-summary:clear:response', {
      success: true,
      state,
    });
    response.id = message.id;
    return response;
  }

  private getAiCliService(): CommitSummaryCliService {
    if (!this.aiCliService) {
      this.aiCliService = new CommitSummaryCliService();
    }
    return this.aiCliService;
  }

  private handleSetApiKey(message: Message<SetApiKeyRequestPayload>): Message<SetApiKeyResponsePayload> {
    try {
      setAnthropicApiKey(message.payload.apiKey);
      const response = createMessage<SetApiKeyResponsePayload>('ai:set-api-key:response', {
        success: true,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<SetApiKeyResponsePayload>('ai:set-api-key:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save API key',
      });
      response.id = message.id;
      return response;
    }
  }

  private handleGetApiKeyStatus(message: Message): Message<GetApiKeyStatusResponsePayload> {
    const response = createMessage<GetApiKeyStatusResponsePayload>('ai:get-api-key-status:response', {
      configured: hasAnthropicApiKey(),
    });
    response.id = message.id;
    return response;
  }

  private async handleListRepos(message: Message, peerAddress: string): Promise<Message<ListReposResponsePayload>> {
    // Refresh branch info for all repos
    const repos: Repository[] = [];
    for (const repo of this.availableRepos) {
      const git = this.repos.get(repo.path)!;
      try {
        const { current } = await git.getBranches();
        repos.push({ ...repo, currentBranch: current });
      } catch {
        repos.push(repo);
      }
    }
    const response = createMessage<ListReposResponsePayload>('agent:list-repos:response', {
      repos,
      current: this.getClientRepoPath(peerAddress),
    });
    response.id = message.id;
    return response;
  }

  private handleSwitchRepo(message: Message<SwitchRepoRequestPayload>, peerAddress: string): Message<SwitchRepoResponsePayload> {
    const { path } = message.payload;

    // Check if the requested repo is in our available repos
    if (!this.repos.has(path)) {
      const response = createMessage<SwitchRepoResponsePayload>('agent:switch-repo:response', {
        success: false,
        newPath: this.getClientRepoPath(peerAddress),
        error: `Repository not available: ${path}`,
      });
      response.id = message.id;
      return response;
    }

    this.clientRepos.set(peerAddress, path);
    const response = createMessage<SwitchRepoResponsePayload>('agent:switch-repo:response', {
      success: true,
      newPath: path,
    });
    response.id = message.id;
    return response;
  }

  private async handleBrowseDirectory(
    message: Message<BrowseDirectoryRequestPayload>
  ): Promise<Message<BrowseDirectoryResponsePayload>> {
    const requestedPath = message.payload.path || homedir();

    try {
      const entries: DirectoryEntry[] = [];
      const dirEntries = await readdir(requestedPath, { withFileTypes: true });

      for (const entry of dirEntries) {
        // Skip hidden files/folders (starting with .)
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(requestedPath, entry.name);
        const isDirectory = entry.isDirectory();

        // Check if it's a git repo (has .git folder)
        let isGitRepo = false;
        if (isDirectory) {
          try {
            const gitPath = join(fullPath, '.git');
            const gitStat = await stat(gitPath);
            isGitRepo = gitStat.isDirectory();
          } catch {
            // Not a git repo
          }
        }

        entries.push({
          name: entry.name,
          path: fullPath,
          isDirectory,
          isGitRepo,
        });
      }

      // Sort: directories first, then alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      // Calculate parent path
      const parentPath = requestedPath === '/' ? null : dirname(requestedPath);

      const response = createMessage<BrowseDirectoryResponsePayload>('agent:browse-directory:response', {
        path: requestedPath,
        parentPath,
        entries,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<BrowseDirectoryResponsePayload>('agent:browse-directory:response', {
        path: requestedPath,
        parentPath: dirname(requestedPath),
        entries: [],
        error: error instanceof Error ? error.message : 'Failed to read directory',
      });
      response.id = message.id;
      return response;
    }
  }

  private async handleAddRepo(
    message: Message<AddRepoRequestPayload>
  ): Promise<Message<AddRepoResponsePayload>> {
    const { path: repoPath } = message.payload;

    // Check if already added
    if (this.repos.has(repoPath)) {
      const response = createMessage<AddRepoResponsePayload>('agent:add-repo:response', {
        success: false,
        error: 'Repository already added',
      });
      response.id = message.id;
      return response;
    }

    try {
      // Verify it's a git repo and resolve to actual root
      const git = new GitOperations(repoPath);
      const { current } = await git.getBranches();
      const rootPath = await git.getGitRoot();

      // Check if already added (by resolved root path)
      if (this.repos.has(rootPath)) {
        const response = createMessage<AddRepoResponsePayload>('agent:add-repo:response', {
          success: false,
          error: 'Repository already added',
        });
        response.id = message.id;
        return response;
      }

      // Add to our maps using the actual git root
      this.repos.set(rootPath, git);
      const newRepo: Repository = {
        path: rootPath,
        name: basename(rootPath),
        currentBranch: current,
      };
      this.availableRepos.push(newRepo);
      // Persist to agent.json
      addManagedRepo(rootPath);

      const response = createMessage<AddRepoResponsePayload>('agent:add-repo:response', {
        success: true,
        repo: newRepo,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<AddRepoResponsePayload>('agent:add-repo:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add repository',
      });
      response.id = message.id;
      return response;
    }
  }

  private handleRemoveRepo(
    message: Message<RemoveRepoRequestPayload>
  ): Message<RemoveRepoResponsePayload> {
    const { path: repoPath } = message.payload;

    if (!this.repos.has(repoPath)) {
      const response = createMessage<RemoveRepoResponsePayload>('agent:remove-repo:response', {
        success: false,
        error: 'Repository not found',
      });
      response.id = message.id;
      return response;
    }

    this.removeRepo(repoPath);
    removeManagedRepo(repoPath);

    const response = createMessage<RemoveRepoResponsePayload>('agent:remove-repo:response', {
      success: true,
    });
    response.id = message.id;
    return response;
  }

  private async handleCloneRepo(
    message: Message<CloneRepoRequestPayload>
  ): Promise<Message<CloneRepoResponsePayload>> {
    const { url, targetDir } = message.payload;

    if (!url || !url.trim()) {
      const response = createMessage<CloneRepoResponsePayload>('agent:clone-repo:response', {
        success: false,
        error: 'Repository URL is required',
      });
      response.id = message.id;
      return response;
    }

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      // Clone into the target directory
      await execFileAsync('git', ['clone', url.trim(), targetDir], {
        timeout: 120_000,
      });

      // Verify it's a valid git repo and add it
      const git = new GitOperations(targetDir);
      const { current } = await git.getBranches();
      const rootPath = await git.getGitRoot();

      // Check if already added (by resolved root path)
      if (this.repos.has(rootPath)) {
        const response = createMessage<CloneRepoResponsePayload>('agent:clone-repo:response', {
          success: false,
          error: 'Repository already added',
        });
        response.id = message.id;
        return response;
      }

      // Add to maps and persist
      this.repos.set(rootPath, git);
      const newRepo: Repository = {
        path: rootPath,
        name: basename(rootPath),
        currentBranch: current,
      };
      this.availableRepos.push(newRepo);
      addManagedRepo(rootPath);

      const response = createMessage<CloneRepoResponsePayload>('agent:clone-repo:response', {
        success: true,
        repo: newRepo,
        clonedPath: rootPath,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<CloneRepoResponsePayload>('agent:clone-repo:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to clone repository',
      });
      response.id = message.id;
      return response;
    }
  }

  // ============================================================================
  // Coding Path Handlers
  // ============================================================================

  private handleListCodingPaths(message: Message): Message<ListCodingPathsResponsePayload> {
    const response = createMessage<ListCodingPathsResponsePayload>(
      'agent:list-coding-paths:response',
      { paths: [...this.codingPaths.values()] }
    );
    response.id = message.id;
    return response;
  }

  private async handleAddCodingPath(
    message: Message<AddCodingPathRequestPayload>
  ): Promise<Message<AddCodingPathResponsePayload>> {
    const { path: codingPath } = message.payload;

    if (this.codingPaths.has(codingPath)) {
      const response = createMessage<AddCodingPathResponsePayload>(
        'agent:add-coding-path:response',
        { success: false, error: 'Coding path already added' }
      );
      response.id = message.id;
      return response;
    }

    try {
      // Verify directory exists
      const dirStat = await stat(codingPath);
      if (!dirStat.isDirectory()) {
        const response = createMessage<AddCodingPathResponsePayload>(
          'agent:add-coding-path:response',
          { success: false, error: 'Path is not a directory' }
        );
        response.id = message.id;
        return response;
      }

      const newPath: CodingPath = { path: codingPath, name: basename(codingPath) };
      this.codingPaths.set(codingPath, newPath);
      addManagedCodingPath(codingPath);

      const response = createMessage<AddCodingPathResponsePayload>(
        'agent:add-coding-path:response',
        { success: true, path: newPath }
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<AddCodingPathResponsePayload>(
        'agent:add-coding-path:response',
        { success: false, error: error instanceof Error ? error.message : 'Failed to add coding path' }
      );
      response.id = message.id;
      return response;
    }
  }

  private handleRemoveCodingPath(
    message: Message<RemoveCodingPathRequestPayload>
  ): Message<RemoveCodingPathResponsePayload> {
    const { path: codingPath } = message.payload;

    if (!this.codingPaths.has(codingPath)) {
      const response = createMessage<RemoveCodingPathResponsePayload>(
        'agent:remove-coding-path:response',
        { success: false, error: 'Coding path not found' }
      );
      response.id = message.id;
      return response;
    }

    this.codingPaths.delete(codingPath);
    removeManagedCodingPath(codingPath);

    const response = createMessage<RemoveCodingPathResponsePayload>(
      'agent:remove-coding-path:response',
      { success: true }
    );
    response.id = message.id;
    return response;
  }

  // ============================================================================
  // Agent Self-Update
  // ============================================================================

  /** Callback set by run.ts to trigger daemon restart after update. */
  onRestartRequested?: () => void;

  private async handleAgentCheckUpdate(
    message: Message,
  ): Promise<Message<AgentCheckUpdateResponsePayload>> {
    const currentVersion = this.agentVersion;
    try {
      const latestVersion = await this.checkLatestVersion(/* force */ true);
      const response = createMessage<AgentCheckUpdateResponsePayload>(
        'agent:check-update:response',
        {
          currentVersion,
          latestVersion: latestVersion || undefined,
          updateAvailable: !!latestVersion && latestVersion !== currentVersion,
        },
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<AgentCheckUpdateResponsePayload>(
        'agent:check-update:response',
        {
          currentVersion,
          updateAvailable: false,
          error: error instanceof Error ? error.message : 'Failed to check for updates',
        },
      );
      response.id = message.id;
      return response;
    }
  }

  private async handleAgentUpdate(
    message: Message,
  ): Promise<Message<AgentUpdateResponsePayload>> {
    const previousVersion = this.agentVersion;
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      // Use npm to install the latest global package
      const { stdout, stderr } = await execFileAsync('npm', [
        'install', '-g', '@sumicom/quicksave@latest',
      ], { timeout: 120_000 });

      const output = (stdout + '\n' + stderr).trim();

      // Parse the installed version from npm output
      // npm output typically contains lines like: + @sumicom/quicksave@0.5.3
      let newVersion = output.match(/@sumicom\/quicksave@(\d+\.\d+\.\d+)/)?.[1];

      // Fallback: query npm for the actually installed version
      if (!newVersion) {
        try {
          const { stdout: listOut } = await execFileAsync('npm', [
            'list', '-g', '@sumicom/quicksave', '--json',
          ], { timeout: 10_000 });
          const listData = JSON.parse(listOut) as { dependencies?: { '@sumicom/quicksave'?: { version?: string } } };
          newVersion = listData.dependencies?.['@sumicom/quicksave']?.version;
        } catch { /* best-effort */ }
      }

      const needsRestart = !!newVersion && newVersion !== previousVersion;

      const response = createMessage<AgentUpdateResponsePayload>(
        'agent:update:response',
        {
          success: true,
          previousVersion,
          newVersion: newVersion || undefined,
          restarting: needsRestart,
        },
      );
      response.id = message.id;

      // Schedule daemon restart AFTER we send the response back to PWA
      if (needsRestart && this.onRestartRequested) {
        setTimeout(() => this.onRestartRequested?.(), 500);
      }

      return response;
    } catch (error) {
      const response = createMessage<AgentUpdateResponsePayload>(
        'agent:update:response',
        {
          success: false,
          previousVersion,
          restarting: false,
          error: error instanceof Error
            ? (error.message.includes('EACCES') ? `Permission denied. Try: sudo npm install -g @sumicom/quicksave@latest` : error.message)
            : 'Failed to update agent',
        },
      );
      response.id = message.id;
      return response;
    }
  }

  private async handleAgentRestart(
    message: Message,
  ): Promise<Message<AgentRestartResponsePayload>> {
    if (this.productionBuild) {
      const response = createMessage<AgentRestartResponsePayload>(
        'agent:restart:response',
        { success: false, error: 'Restart is only available for dev builds' },
      );
      response.id = message.id;
      return response;
    }

    try {
      const { spawn } = await import('child_process');
      const { fileURLToPath } = await import('url');
      const { resolve: resolvePath } = await import('path');

      const thisFile = fileURLToPath(import.meta.url);
      const isTs = thisFile.endsWith('.ts');
      const entryPath = resolvePath(dirname(thisFile), isTs ? '../index.ts' : '../../index.js');
      const agentRoot = resolvePath(dirname(thisFile), isTs ? '..' : '..');
      const node = process.execPath;
      const execArgv = isTs ? ['--import', 'tsx'] : [];

      spawn(node, [...execArgv, entryPath, '--restart'], {
        detached: true,
        stdio: 'ignore',
        cwd: agentRoot,
      }).unref();

      const response = createMessage<AgentRestartResponsePayload>(
        'agent:restart:response',
        { success: true },
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<AgentRestartResponsePayload>(
        'agent:restart:response',
        { success: false, error: error instanceof Error ? error.message : 'Failed to restart agent' },
      );
      response.id = message.id;
      return response;
    }
  }

  // ==========================================================================
  // systemd user-unit (Linux auto-start at login)
  //
  // The PWA toggles install/uninstall from the per-machine settings page.
  // These handlers are no-ops on non-Linux hosts (the status payload's
  // `available: false` field is the gate the PWA uses to hide the section,
  // so non-Linux still gets a well-formed response instead of an error).
  // ==========================================================================

  private handleSystemdStatus(message: Message): Message<SystemdStatusResponsePayload> {
    const status = getSystemdStatus();
    const response = createMessage<SystemdStatusResponsePayload>('systemd:status:response', status);
    response.id = message.id;
    return response;
  }

  private handleSystemdInstall(message: Message): Message<SystemdInstallResponsePayload> {
    if (!systemctlAvailable()) {
      const response = createMessage<SystemdInstallResponsePayload>('systemd:install:response', {
        success: false,
        error: 'systemctl --user is not available on this host',
        status: getSystemdStatus(),
      });
      response.id = message.id;
      return response;
    }
    const result = installUserUnit();
    const response = createMessage<SystemdInstallResponsePayload>('systemd:install:response', result);
    response.id = message.id;
    return response;
  }

  private handleSystemdUninstall(message: Message): Message<SystemdUninstallResponsePayload> {
    // Uninstalling can stop the systemd-managed daemon as a side effect — if
    // the running process IS that daemon, `disable --now` would kill our IPC
    // server before the response reaches the PWA. So we compute the response
    // up front (which captures the pre-uninstall status) but defer the
    // actual mutation until next tick, giving the bus transport a chance to
    // flush. The next CLI invocation will hit `ensureDaemon`, which falls
    // back to detached spawn now that the unit is gone.
    if (!systemctlAvailable()) {
      const response = createMessage<SystemdUninstallResponsePayload>('systemd:uninstall:response', {
        success: false,
        error: 'systemctl --user is not available on this host',
        status: getSystemdStatus(),
      });
      response.id = message.id;
      return response;
    }
    setImmediate(() => {
      try {
        uninstallUserUnit();
      } catch (err) {
        console.error('[systemd] deferred uninstall failed:', err);
      }
    });
    // Optimistic response: report the post-uninstall shape (unitInstalled,
    // unitEnabled, isActive all expected to flip false). We can't actually
    // observe the post state because we haven't run the disable yet.
    const optimistic = getSystemdStatus();
    const response = createMessage<SystemdUninstallResponsePayload>('systemd:uninstall:response', {
      success: true,
      status: {
        ...optimistic,
        unitInstalled: false,
        unitEnabled: false,
        isActive: false,
        currentExecStart: undefined,
      },
    });
    response.id = message.id;
    return response;
  }

  private async handleCodexListModels(
    message: Message,
  ): Promise<Message<CodexListModelsResponsePayload>> {
    try {
      const [models, auth] = await Promise.all([
        this.fetchCodexModels(/* force */ true),
        this.getCodexLoginStatus(),
      ]);
      const response = createMessage<CodexListModelsResponsePayload>(
        'codex:list-models:response',
        { models: models ?? [], loggedIn: auth.loggedIn },
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<CodexListModelsResponsePayload>(
        'codex:list-models:response',
        {
          models: [],
          error: error instanceof Error ? error.message : 'Failed to fetch models',
          loggedIn: false,
        },
      );
      response.id = message.id;
      return response;
    }
  }

  /**
   * Kick off the Codex device-auth OAuth flow on the daemon. Returns the
   * one-time verification URL + user code so the PWA can display them — the
   * user typically completes this on a different device (e.g. phone).
   */
  private async handleCodexLoginStart(
    message: Message,
  ): Promise<Message<CodexLoginStartResponsePayload>> {
    const state = await this.codexLoginManager.start();
    const ok = state.loggedIn || Boolean(state.userCode && state.verificationUrl);
    const response = createMessage<CodexLoginStartResponsePayload>(
      'codex:login-start:response',
      { ok, ...state },
    );
    response.id = message.id;
    return response;
  }

  private async handleCodexLoginStatus(
    message: Message,
  ): Promise<Message<CodexLoginStatusResponsePayload>> {
    const state = await this.codexLoginManager.getStatus();
    const response = createMessage<CodexLoginStatusResponsePayload>(
      'codex:login-status:response',
      state,
    );
    response.id = message.id;
    return response;
  }

  private async handleCodexLoginCancel(
    message: Message,
  ): Promise<Message<CodexLoginCancelResponsePayload>> {
    this.codexLoginManager.cancel();
    const response = createMessage<CodexLoginCancelResponsePayload>(
      'codex:login-cancel:response',
      { ok: true },
    );
    response.id = message.id;
    return response;
  }

  /** Expose for the daemon to wire login-state updates into bus broadcasts. */
  getCodexLoginManager(): CodexLoginManager {
    return this.codexLoginManager;
  }

  // ============================================================================
  // Claude Code SDK Handlers
  // ============================================================================

  private async handleClaudeStart(
    message: Message<ClaudeStartRequestPayload>,
    peerAddress: string,
  ): Promise<Message<ClaudeStartResponsePayload>> {
    const { prompt, cwd: payloadCwd, agent, allowedTools, systemPrompt, model, permissionMode, sandboxed, reasoningEffort, contextWindow, attachmentIds } = message.payload;
    const legacyProvider = (message.payload as { provider?: 'claude-cli' | 'claude-sdk' | 'codex-mcp' }).provider;
    const cwd = payloadCwd || this.getClientRepoPath(peerAddress);
    const resolvedAgent = agent ?? (legacyProvider === 'codex-mcp' ? 'codex' : legacyProvider ? 'claude-code' : undefined);
    // Coerce a Codex model the user's account doesn't actually support
    // (e.g. they kept `claude-opus-4-7` selected before switching to a
    // ChatGPT-account Codex session). Without this, codex would 400 on
    // turn/start with `BadRequest`. Pass-through for non-codex agents and
    // when the cache hasn't loaded yet.
    const validatedModel = this.validateCodexModel(model, resolvedAgent ?? 'claude-code');
    console.log(`[agent:start] agent=${resolvedAgent ?? 'default'} model=${validatedModel ?? 'default'}${validatedModel !== model ? ` (coerced from ${model})` : ''} cwd=${cwd} prompt=${prompt.slice(0, 80)}${sandboxed ? ' [sandboxed]' : ''}${attachmentIds && attachmentIds.length > 0 ? ` [+${attachmentIds.length} attachments]` : ''}`);

    let attachments: ReturnType<AttachmentStaging['consume']> | undefined;
    if (attachmentIds && attachmentIds.length > 0) {
      try {
        attachments = this.attachmentStaging.consume(peerAddress, attachmentIds);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'attachment_error';
        const text = error instanceof Error ? error.message : 'attachment resolve failed';
        const response = createMessage<ClaudeStartResponsePayload>(
          'claude:start:response',
          { success: false, error: `${code}: ${text}` },
        );
        response.id = message.id;
        return response;
      }
    }

    try {
      const sessionId = await this.claudeService.startSession({
        prompt,
        cwd,
        agent: resolvedAgent,
        allowedTools,
        systemPrompt,
        model: validatedModel,
        permissionMode,
        sandboxed,
        reasoningEffort,
        contextWindow,
        attachments,
      });

      console.log(`[agent:start] session created: ${sessionId} agent=${resolvedAgent ?? 'default'}`);

      // Register in session history
      const now = Date.now();
      getEventStore().record({
        type: 'prompt_sent',
        sessionId,
        cwd,
        time: now,
        data: { kind: 'start', promptLength: prompt.length, model, agent: resolvedAgent },
      });
      const registry = getSessionRegistry();
      const gitBranch = await this.getGitBranchQuiet(cwd);
      const actualAgent = this.claudeService.getSessionAgent(sessionId, cwd);
      registry.upsertEntry({
        sessionId, cwd,
        agent: actualAgent,
        repoName: basename(cwd),
        gitBranch,
        firstPrompt: prompt.slice(0, 100),
        createdAt: now,
        lastAccessedAt: now,
        permissionMode,
        sandboxed: sandboxed || undefined,
        model,
        reasoningEffort,
        contextWindow,
      });
      this.onHistoryUpdated?.(cwd, registry.getEntry(cwd, sessionId)!, 'upsert');

      const response = createMessage<ClaudeStartResponsePayload>(
        'claude:start:response',
        { success: true, sessionId }
      );
      response.id = message.id;
      return response;
    } catch (error) {
      console.error(`[agent:start] error:`, error);
      const response = createMessage<ClaudeStartResponsePayload>(
        'claude:start:response',
        { success: false, error: error instanceof Error ? error.message : 'Failed to start session' }
      );
      response.id = message.id;
      return response;
    }
  }

  private async handleClaudeResume(
    message: Message<ClaudeResumeRequestPayload>,
    peerAddress: string,
  ): Promise<Message<ClaudeResumeResponsePayload>> {
    const { sessionId: requestedId, prompt, cwd: payloadCwd, agent, attachmentIds } = message.payload;
    const legacyProvider = (message.payload as { provider?: 'claude-cli' | 'claude-sdk' | 'codex-mcp' }).provider;
    const cwd = payloadCwd || this.getClientRepoPath(peerAddress);
    const resolvedAgent = agent ?? (legacyProvider === 'codex-mcp' ? 'codex' : legacyProvider ? 'claude-code' : undefined);
    const activeCfg = this.claudeService.getSessionConfig(requestedId);
    console.log(`[agent:resume] session=${requestedId} agent=${resolvedAgent ?? 'stored'} model=${(activeCfg.model as string | undefined) ?? 'default'} cwd=${cwd} prompt=${prompt.slice(0, 80)}${attachmentIds && attachmentIds.length > 0 ? ` [+${attachmentIds.length} attachments]` : ''}`);

    let attachments: ReturnType<AttachmentStaging['consume']> | undefined;
    if (attachmentIds && attachmentIds.length > 0) {
      try {
        attachments = this.attachmentStaging.consume(peerAddress, attachmentIds);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'attachment_error';
        const text = error instanceof Error ? error.message : 'attachment resolve failed';
        const response = createMessage<ClaudeResumeResponsePayload>(
          'claude:resume:response',
          { success: false, error: `${code}: ${text}` },
        );
        response.id = message.id;
        return response;
      }
    }

    try {
      const actualSessionId = await this.claudeService.resumeSession({
        sessionId: requestedId,
        prompt,
        cwd,
        agent: resolvedAgent,
        attachments,
      });

      console.log(`[agent:resume] session resumed: ${actualSessionId}`);

      getEventStore().record({
        type: 'prompt_sent',
        sessionId: actualSessionId,
        cwd,
        data: { kind: 'resume', promptLength: prompt.length, agent: resolvedAgent },
      });

      // Update session history
      const registry = getSessionRegistry();
      const existing = registry.getEntry(cwd, requestedId) ?? registry.getEntry(cwd, actualSessionId);
      const gitBranch = await this.getGitBranchQuiet(cwd);
      const actualAgent = this.claudeService.getSessionAgent(actualSessionId, cwd);
      registry.upsertEntry({
        ...(existing ?? { sessionId: actualSessionId, cwd, repoName: basename(cwd), createdAt: Date.now() }),
        sessionId: actualSessionId,
        agent: actualAgent,
        lastAccessedAt: Date.now(),
        gitBranch,
      });
      this.onHistoryUpdated?.(cwd, registry.getEntry(cwd, actualSessionId)!, 'upsert');

      const response = createMessage<ClaudeResumeResponsePayload>(
        'claude:resume:response',
        { success: true, sessionId: actualSessionId }
      );
      response.id = message.id;
      return response;
    } catch (error) {
      console.error(`[agent:resume] error:`, error);
      const response = createMessage<ClaudeResumeResponsePayload>(
        'claude:resume:response',
        { success: false, error: error instanceof Error ? error.message : 'Failed to resume session' }
      );
      response.id = message.id;
      return response;
    }
  }

  private async handleClaudeCancel(
    message: Message<ClaudeCancelRequestPayload>
  ): Promise<Message<ClaudeCancelResponsePayload>> {
    const { sessionId } = message.payload;
    const success = await this.claudeService.cancelSession(sessionId);
    if (success) {
      getEventStore().record({ type: 'session_cancelled', sessionId });
    }
    const response = createMessage<ClaudeCancelResponsePayload>(
      'claude:cancel:response',
      { success, error: success ? undefined : 'Session not found or already ended' }
    );
    response.id = message.id;
    return response;
  }

  private handleClaudeClose(
    message: Message<ClaudeCloseRequestPayload>
  ): Message<ClaudeCloseResponsePayload> {
    const { sessionId } = message.payload;
    const success = this.claudeService.closeSession(sessionId);
    console.log(`[agent:close] session=${sessionId} success=${success}`);
    const response = createMessage<ClaudeCloseResponsePayload>(
      'claude:close:response',
      { success, error: success ? undefined : 'Session not found or already closed' }
    );
    response.id = message.id;
    return response;
  }

  /**
   * End Task: archive the session's registry entry, then terminate the live
   * CLI process. Order matters — closeSession emits a session-updated whose
   * `archived` flag is derived from "no in-memory entry AND no active
   * registry entry". Archiving first ensures that emit carries archived=true,
   * which the PWA reads as the "navigate away" signal.
   *
   * cwd lookup: prefer the live in-memory entry; fall back to the registry
   * so users can still archive a stale active entry whose CLI has already
   * exited (cold-closed sessions still appear in the drawer).
   */
  private handleClaudeEndTask(
    message: Message<ClaudeEndTaskRequestPayload>
  ): Message<ClaudeEndTaskResponsePayload> {
    const { sessionId } = message.payload;
    const cwd = this.claudeService.getSessionCwd(sessionId)
      ?? getSessionRegistry().findBySessionId(sessionId)?.cwd;

    let archived = false;
    if (cwd) {
      const updated = getSessionRegistry().updateEntry(cwd, sessionId, { archived: true });
      if (updated) {
        archived = true;
        this.onHistoryUpdated?.(cwd, updated, 'upsert');
      }
    }

    const closed = this.claudeService.closeSession(sessionId);

    // Drop persisted attachment bytes for this session — fire-and-forget;
    // a stuck rm shouldn't block the response.
    removeSessionAttachments(sessionId).catch((err) => {
      console.error(`[agent:end-task] removeSessionAttachments failed session=${sessionId}:`, err);
    });

    const success = closed || archived;
    console.log(
      `[agent:end-task] session=${sessionId} closed=${closed} archived=${archived} cwd=${cwd ?? 'unknown'}`,
    );
    const response = createMessage<ClaudeEndTaskResponsePayload>(
      'claude:end-task:response',
      { success, error: success ? undefined : 'Session not found' },
    );
    response.id = message.id;
    return response;
  }

  private handleClaudeUserInputResponse(
    message: Message<ClaudeUserInputResponsePayload>
  ): Message {
    const resolved = this.claudeService.resolveUserInput(message.payload);
    console.log(`[agent:user-input-response] requestId=${message.payload.requestId} action=${message.payload.action} resolved=${resolved}`);
    // No dedicated response type — just acknowledge
    const response = createMessage('claude:user-input-response', { success: resolved });
    response.id = message.id;
    return response;
  }

  private async handleClaudeGetCards(
    message: Message<ClaudeGetMessagesRequestPayload>,
    peerAddress: string
  ): Promise<Message<CardHistoryResponse>> {
    const { sessionId, cwd: payloadCwd, offset = 0, limit = 50 } = message.payload;
    const cwd = payloadCwd || this.getClientRepoPath(peerAddress);

    try {
      const result = await this.claudeService.getCards(sessionId, cwd, offset, limit);
      const response = createMessage<CardHistoryResponse>('claude:get-cards:response', result);
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<CardHistoryResponse>(
        'claude:get-cards:response',
        {
          cards: [],
          total: 0,
          hasMore: false,
          error: error instanceof Error ? error.message : 'Failed to get cards',
        }
      );
      response.id = message.id;
      return response;
    }
  }

  private handleSetPreferences(message: Message<ClaudeSetPreferencesRequestPayload>): Message<ClaudeSetPreferencesResponsePayload> {
    const applied = this.claudeService.setPreferences(message.payload.preferences);
    const response = createMessage<ClaudeSetPreferencesResponsePayload>(
      'claude:set-preferences:response',
      { success: true, preferences: applied },
    );
    response.id = message.id;
    return response;
  }

  private async handleSetSessionPermission(message: Message<ClaudeSetSessionPermissionRequestPayload>): Promise<Message<ClaudeSetSessionPermissionResponsePayload>> {
    const { sessionId, permissionMode } = message.payload;
    let success = false;
    try {
      success = await this.claudeService.setPermissionLevel(sessionId, permissionMode);
    } catch {
      success = false;
    }
    const response = createMessage<ClaudeSetSessionPermissionResponsePayload>(
      'claude:set-session-permission:response',
      { success, sessionId, permissionMode },
    );
    response.id = message.id;
    return response;
  }

  private async handleSetSessionConfig(message: Message<SessionSetConfigRequestPayload>): Promise<Message<SessionSetConfigResponsePayload>> {
    const { sessionId, key } = message.payload;
    let { value } = message.payload;
    // Same coercion as handleClaudeStart: if the PWA pushed a model the
    // current Codex account can't run, swap it for the account default
    // before the override hits the next turn/start. The `agent` lookup
    // tolerates inactive sessions (returns the registry-stored agent or
    // falls back to the default provider).
    if (key === 'model' && typeof value === 'string') {
      const agentId = this.claudeService.getSessionAgent(sessionId);
      const coerced = this.validateCodexModel(value, agentId);
      if (coerced !== value) {
        console.log(`[agent:set-config] coerced model "${value}" → "${coerced}" for session=${sessionId.slice(0, 8)}`);
        value = coerced ?? value;
      }
    }
    console.log(`[agent:set-config] session=${sessionId.slice(0, 8)} ${key}=${String(value)}`);
    try {
      const config = await this.claudeService.setSessionConfig(sessionId, key, value);
      const response = createMessage<SessionSetConfigResponsePayload>(
        'session:set-config:response',
        { success: true, sessionId, config },
      );
      response.id = message.id;
      return response;
    } catch (err) {
      const config = this.claudeService.getSessionConfig(sessionId);
      const response = createMessage<SessionSetConfigResponsePayload>(
        'session:set-config:response',
        {
          success: false,
          sessionId,
          config,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      response.id = message.id;
      return response;
    }
  }

  private async handleControlRequest(
    message: Message<SessionControlRequestPayload>,
  ): Promise<Message<SessionControlRequestResponsePayload>> {
    const { sessionId, subtype, params } = message.payload;
    console.log(`[agent:control-request] session=${sessionId.slice(0, 8)} subtype=${subtype} params=${JSON.stringify(params ?? {})}`);
    try {
      const result = await this.claudeService.sendControlRequest(sessionId, subtype, params);
      const response = createMessage<SessionControlRequestResponsePayload>(
        'session:control-request:response',
        { success: true, sessionId, response: result },
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[agent:control-request] error:`, errMsg);
      const response = createMessage<SessionControlRequestResponsePayload>(
        'session:control-request:response',
        { success: false, sessionId, error: errMsg },
      );
      response.id = message.id;
      return response;
    }
  }

  // ── Session Registry (History) ──────────────────────────────────────

  private handleUpdateHistory(
    message: Message<SessionUpdateHistoryRequestPayload>,
  ): Message<SessionUpdateHistoryResponsePayload> {
    const { sessionId, cwd, updates } = message.payload;
    const entry = getSessionRegistry().updateEntry(cwd, sessionId, updates);
    const response = createMessage<SessionUpdateHistoryResponsePayload>(
      'session:update-history:response',
      entry ? { success: true, entry } : { success: false, error: 'Entry not found' },
    );
    response.id = message.id;
    if (entry) {
      this.onHistoryUpdated?.(cwd, entry, 'upsert');
    }
    return response;
  }

  private handleDeleteHistory(
    message: Message<SessionDeleteHistoryRequestPayload>,
  ): Message<SessionDeleteHistoryResponsePayload> {
    const { sessionId, cwd } = message.payload;
    const entry = getSessionRegistry().getEntry(cwd, sessionId);
    const success = getSessionRegistry().deleteEntry(cwd, sessionId);
    const response = createMessage<SessionDeleteHistoryResponsePayload>(
      'session:delete-history:response',
      { success, error: success ? undefined : 'Entry not found' },
    );
    response.id = message.id;
    if (success && entry) {
      this.onHistoryUpdated?.(cwd, entry, 'delete');
    }
    return response;
  }

  private handleListArchived(
    message: Message<SessionListArchivedRequestPayload>,
  ): Message<SessionListArchivedResponsePayload> {
    const { cwd, offset = 0, limit = 20 } = message.payload;
    const { entries, total } = getSessionRegistry().listArchivedEntriesPage(cwd, offset, limit);
    const response = createMessage<SessionListArchivedResponsePayload>(
      'session:list-archived:response',
      { entries: entries.map(enrichEntry), total, offset, limit },
    );
    response.id = message.id;
    return response;
  }

  /**
   * Stamp `lastReadAt` on a registry entry and broadcast the update so every
   * connected PWA client converges on the same read state. The "unread" mark
   * lives server-side under the user's group identity (see
   * `docs/guidelines/sync-security.en.md`) — there's no per-device scoping,
   * so reading on the phone clears the badge on the desktop too.
   *
   * Idempotent: late-arriving / out-of-order viewedAt values that are older
   * than the persisted timestamp are dropped (max-wins) so a slow tab can't
   * undo a fresh read from a faster one.
   */
  private handleMarkRead(
    message: Message<SessionMarkReadRequestPayload>,
  ): Message<SessionMarkReadResponsePayload> {
    const { sessionId, cwd, viewedAt } = message.payload;
    const stamp = typeof viewedAt === 'number' ? viewedAt : Date.now();
    const existing = getSessionRegistry().getEntry(cwd, sessionId);
    if (!existing) {
      const failed = createMessage<SessionMarkReadResponsePayload>(
        'session:mark-read:response',
        { success: false, error: 'Entry not found' },
      );
      failed.id = message.id;
      return failed;
    }
    const nextLastReadAt = Math.max(existing.lastReadAt ?? 0, stamp);
    let entry = existing;
    if (nextLastReadAt !== existing.lastReadAt) {
      const updated = getSessionRegistry().updateEntry(cwd, sessionId, { lastReadAt: nextLastReadAt });
      if (updated) entry = updated;
      // Broadcast on /sessions/history so other PWA clients see the new
      // read state immediately. /sessions/active is also re-emitted via
      // sessionManager so the live-stats path stays consistent.
      this.onHistoryUpdated?.(cwd, entry, 'upsert');
      this.claudeService.emitSessionUpdate(sessionId);
    }
    const response = createMessage<SessionMarkReadResponsePayload>(
      'session:mark-read:response',
      { success: true, lastReadAt: entry.lastReadAt },
    );
    response.id = message.id;
    return response;
  }

  private handleListProjectSummaries(
    message: Message,
  ): Message<ProjectListSummariesResponsePayload> {
    const allEntries = getSessionRegistry().getEntriesForProject();

    // Group by cwd
    const byCwd = new Map<string, SessionRegistryEntry[]>();
    for (const entry of allEntries) {
      let group = byCwd.get(entry.cwd);
      if (!group) {
        group = [];
        byCwd.set(entry.cwd, group);
      }
      group.push(entry);
    }

    // Build active session set from session manager
    const activeSessions = this.claudeService.getActiveSessions();
    const activeCwds = new Set<string>();
    for (const s of activeSessions) {
      activeCwds.add(s.cwd);
    }

    const projects: ProjectSummary[] = [];
    for (const [cwd, entries] of byCwd) {
      // entries are already sorted by lastAccessedAt desc from getEntriesForProject
      const latest = entries[0];
      projects.push({
        cwd,
        sessionCount: entries.length,
        lastActivityAt: latest.lastAccessedAt,
        lastSessionTitle: latest.title ?? latest.firstPrompt?.slice(0, 100),
        hasActiveSession: activeCwds.has(cwd),
        isGitRepo: existsSync(join(cwd, '.git')),
      });
    }

    // Include managed coding paths that have no sessions so the PWA can show them
    // in the project list. Without this, a freshly-added workspace with no sessions
    // would be pruned from the PWA's knownCodingPaths on next connect.
    for (const cwd of this.codingPaths.keys()) {
      if (byCwd.has(cwd)) continue;
      projects.push({
        cwd,
        sessionCount: 0,
        lastActivityAt: 0,
        hasActiveSession: false,
        isGitRepo: existsSync(join(cwd, '.git')),
      });
    }

    // Sort by lastActivityAt desc
    projects.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    const response = createMessage<ProjectListSummariesResponsePayload>(
      'project:list-summaries:response',
      { projects },
    );
    response.id = message.id;
    return response;
  }

  private async handleListProjectRepos(
    message: Message<ProjectListReposRequestPayload>,
  ): Promise<Message<ProjectListReposResponsePayload>> {
    const { cwd } = message.payload;
    const repos: ProjectRepo[] = [];
    const seen = new Set<string>();

    try {
      // 1. Check if cwd itself is a git repo. Use the cheap fs check rather
      // than spawning `git branch -a` so a transient git failure (EAGAIN
      // under daemon load, refs being rewritten by a concurrent fetch/gc,
      // detached HEAD returning empty `current`) doesn't drop the root
      // and make the PWA's Git section flash empty. Branch + dirty are
      // filled in best-effort below; undefined just means "unknown".
      const isRootRepo = existsSync(join(cwd, '.git'));
      if (isRootRepo) {
        repos.push({
          path: cwd,
          name: basename(cwd),
          currentBranch: (await this.getGitBranchQuiet(cwd)) || undefined,
          hasChanges: await this.getGitDirtyQuiet(cwd),
        });
        seen.add(cwd);
      }

      // 2. Find submodules via git
      if (isRootRepo) {
        try {
          const git = new GitOperations(cwd);
          const submodules = await git.getSubmodules();
          for (const sub of submodules) {
            const subPath = join(cwd, sub.path);
            if (seen.has(subPath)) continue;
            seen.add(subPath);
            const branch = await this.getGitBranchQuiet(subPath);
            repos.push({
              path: subPath,
              name: sub.path,
              currentBranch: branch || undefined,
              isSubmodule: true,
              hasChanges: await this.getGitDirtyQuiet(subPath),
            });
          }
        } catch {
          // git submodule may fail — ignore
        }
      }

      // 3. Scan for nested git repos (depth-limited, skips node_modules etc.)
      const MAX_DEPTH = 3;
      const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '__pycache__']);
      const scan = async (dir: string, depth: number) => {
        if (depth > MAX_DEPTH) return;
        let names: string[];
        try {
          names = await readdir(dir) as string[];
        } catch { return; }
        for (const name of names) {
          if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
          const full = join(dir, name);
          try {
            const s = await stat(full);
            if (!s.isDirectory()) continue;
          } catch { continue; }
          if (existsSync(join(full, '.git')) && !seen.has(full)) {
            seen.add(full);
            const branch = await this.getGitBranchQuiet(full);
            repos.push({
              path: full,
              name: full.slice(cwd.length + 1),
              currentBranch: branch || undefined,
              hasChanges: await this.getGitDirtyQuiet(full),
            });
          }
          await scan(full, depth + 1);
        }
      };
      await scan(cwd, 0);
    } catch (error) {
      const response = createMessage<ProjectListReposResponsePayload>(
        'project:list-repos:response',
        { repos: [], error: error instanceof Error ? error.message : 'Failed to scan repos' },
      );
      response.id = message.id;
      return response;
    }

    const response = createMessage<ProjectListReposResponsePayload>(
      'project:list-repos:response',
      { repos },
    );
    response.id = message.id;
    return response;
  }

  /**
   * Hide a project without touching the filesystem. Closes every live
   * Claude session under `cwd` (so a stray resume can't re-materialize an
   * active registry entry — see note below), archives every registry entry
   * under `cwd` (each archive fires `/sessions/history` so PWAs drop the
   * sessions from their live view), and removes the cwd from managed
   * coding paths so it stops surfacing as an empty workspace. Archived
   * session JSON stays on disk and can be restored individually.
   *
   * Why close live sessions first: `handleClaudeResume` builds a fresh
   * active registry entry when `getEntry` returns undefined (archived
   * entries aren't in memory). Without this step, any subsequent resume
   * of a still-running session re-creates the active entry and the
   * project reappears on the next project:list-summaries.
   */
  private handleDeleteProject(
    message: Message<ProjectDeleteRequestPayload>,
  ): Message<ProjectDeleteResponsePayload> {
    const { cwd } = message.payload;
    const registry = getSessionRegistry();

    const liveHere = this.claudeService.getActiveSessions().filter((s) => s.cwd === cwd);
    for (const s of liveHere) {
      this.claudeService.closeSession(s.sessionId);
    }

    const active = registry.getEntriesForProject(cwd);
    let archivedCount = 0;
    for (const entry of active) {
      const updated = registry.updateEntry(cwd, entry.sessionId, { archived: true });
      if (updated) {
        archivedCount++;
        this.onHistoryUpdated?.(cwd, updated, 'upsert');
      }
    }

    const hadCodingPath = this.codingPaths.has(cwd);
    if (hadCodingPath) {
      this.codingPaths.delete(cwd);
      removeManagedCodingPath(cwd);
    }

    console.log(
      `[project:delete] cwd=${cwd} closedSessions=${liveHere.length} archived=${archivedCount} removedCodingPath=${hadCodingPath}`,
    );

    const response = createMessage<ProjectDeleteResponsePayload>(
      'project:delete:response',
      { success: true, archivedCount },
    );
    response.id = message.id;
    return response;
  }

  private async getGitBranchQuiet(cwd: string): Promise<string | undefined> {
    try {
      const git = new GitOperations(cwd);
      const { current } = await git.getBranches();
      return current || undefined;
    } catch {
      return undefined;
    }
  }

  private async getGitDirtyQuiet(cwd: string): Promise<boolean | undefined> {
    try {
      const git = new GitOperations(cwd);
      const status = await git.getStatus();
      return (
        status.staged.length > 0 ||
        status.unstaged.length > 0 ||
        status.untracked.length > 0
      );
    } catch {
      return undefined;
    }
  }

  private async handlePushSubscriptionOffer(
    message: Message<PushSubscriptionOfferPayload>,
  ): Promise<Message<PushSubscriptionOfferResponsePayload>> {
    const client = this.pushClient;
    let payload: PushSubscriptionOfferResponsePayload;
    if (!client) {
      payload = { success: false, error: 'push-not-configured' };
    } else {
      const { subscription, relayHttpUrl } = message.payload;
      const result = await client.register(subscription, relayHttpUrl);
      if (!result.ok) {
        console.warn(`[push] register failed status=${result.status}${result.error ? ` error=${result.error}` : ''}`);
      }
      payload = result.ok ? { success: true } : { success: false, error: result.error ?? `http-${result.status}` };
    }
    const response = createMessage<PushSubscriptionOfferResponsePayload>('push:subscription-offer:response', payload);
    response.id = message.id;
    return response;
  }

  // ── Terminal (PTY) handlers ──────────────────────────────────────────────
  private async handleTerminalCreate(
    message: Message<TerminalCreateRequestPayload>,
  ): Promise<Message<TerminalCreateResponsePayload>> {
    let payload: TerminalCreateResponsePayload;
    try {
      const summary = await getTerminalManager().create(message.payload);
      payload = { success: true, terminal: summary };
    } catch (err) {
      payload = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const response = createMessage<TerminalCreateResponsePayload>('terminal:create:response', payload);
    response.id = message.id;
    return response;
  }

  private async handleTerminalInput(
    message: Message<TerminalInputRequestPayload>,
  ): Promise<Message<TerminalInputResponsePayload>> {
    let payload: TerminalInputResponsePayload;
    try {
      getTerminalManager().write(message.payload.terminalId, message.payload.data);
      payload = { success: true };
    } catch (err) {
      payload = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const response = createMessage<TerminalInputResponsePayload>('terminal:input:response', payload);
    response.id = message.id;
    return response;
  }

  private async handleTerminalResize(
    message: Message<TerminalResizeRequestPayload>,
  ): Promise<Message<TerminalResizeResponsePayload>> {
    let payload: TerminalResizeResponsePayload;
    try {
      getTerminalManager().resize(
        message.payload.terminalId,
        message.payload.cols,
        message.payload.rows,
      );
      payload = { success: true };
    } catch (err) {
      payload = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const response = createMessage<TerminalResizeResponsePayload>('terminal:resize:response', payload);
    response.id = message.id;
    return response;
  }

  private async handleTerminalClose(
    message: Message<TerminalCloseRequestPayload>,
  ): Promise<Message<TerminalCloseResponsePayload>> {
    let payload: TerminalCloseResponsePayload;
    try {
      getTerminalManager().close(message.payload.terminalId, message.payload.force ?? false);
      payload = { success: true };
    } catch (err) {
      payload = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const response = createMessage<TerminalCloseResponsePayload>('terminal:close:response', payload);
    response.id = message.id;
    return response;
  }

  private async handleTerminalRename(
    message: Message<TerminalRenameRequestPayload>,
  ): Promise<Message<TerminalRenameResponsePayload>> {
    let payload: TerminalRenameResponsePayload;
    try {
      const summary = getTerminalManager().rename(
        message.payload.terminalId,
        message.payload.title,
      );
      payload = { success: true, terminal: summary };
    } catch (err) {
      payload = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const response = createMessage<TerminalRenameResponsePayload>('terminal:rename:response', payload);
    response.id = message.id;
    return response;
  }

  // ── File browser handlers ────────────────────────────────────────────────
  private async handleFilesList(
    message: Message<FilesListRequestPayload>,
  ): Promise<Message<FilesListResponsePayload>> {
    const payload = await getFileBrowser().list(message.payload);
    const response = createMessage<FilesListResponsePayload>('files:list:response', payload);
    response.id = message.id;
    return response;
  }

  private async handleFilesRead(
    message: Message<FilesReadRequestPayload>,
  ): Promise<Message<FilesReadResponsePayload>> {
    const payload = await getFileBrowser().read(message.payload);
    const response = createMessage<FilesReadResponsePayload>('files:read:response', payload);
    response.id = message.id;
    return response;
  }

  // ── Attachment staging handlers ──────────────────────────────────────────
  /** Exposed so other agent paths (sessionManager) can resolve staged ids. */
  getAttachmentStaging(): AttachmentStaging {
    return this.attachmentStaging;
  }

  private handleAttachmentUpload(
    message: Message<AttachmentUploadRequestPayload>,
    peerAddress: string,
  ): Message {
    try {
      const result = this.attachmentStaging.acceptChunk(peerAddress, message.payload);
      const response = createMessage<AttachmentUploadResponsePayload>('attachment:upload:response', result);
      response.id = message.id;
      return response;
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'attachment_error';
      const text = error instanceof Error ? error.message : 'attachment upload failed';
      return this.createErrorResponse(message.id, code, text);
    }
  }

  private handleAttachmentCancel(
    message: Message<AttachmentCancelRequestPayload>,
    peerAddress: string,
  ): Message<AttachmentCancelResponsePayload> {
    const removed = this.attachmentStaging.cancel(peerAddress, message.payload.attachmentId);
    const response = createMessage<AttachmentCancelResponsePayload>('attachment:cancel:response', { removed });
    response.id = message.id;
    return response;
  }

  private async handleAttachmentFetch(
    message: Message<AttachmentFetchRequestPayload>,
  ): Promise<Message> {
    const { sessionId, attachmentId } = message.payload;
    const attachment = await loadAttachment(sessionId, attachmentId);
    if (!attachment) {
      return this.createErrorResponse(message.id, 'attachment_not_found', `attachment ${attachmentId} not on disk for session ${sessionId}`);
    }
    const response = createMessage<AttachmentFetchResponsePayload>('attachment:fetch:response', { attachment });
    response.id = message.id;
    return response;
  }

  private createErrorResponse(id: string, code: string, message: string): Message<ErrorPayload> {
    const response = createMessage<ErrorPayload>('error', { code, message });
    response.id = id;
    return response;
  }
}
