// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';
import type { ConnectionState, Repository, CodingPath, CodexModelInfo } from '@sumicom/quicksave-shared';

export type ConnectionStep = 'signaling' | 'waiting-for-agent' | 'key-exchange' | 'handshake';

/** Per-agent connection state for multi-agent tracking */
export interface AgentConnectionState {
  state: ConnectionState;
  repoPath: string | null;
  availableRepos: Repository[];
  availableCodingPaths: CodingPath[];
  isPro: boolean;
  agentVersion: string | null;
  devBuild: boolean;
  /** OS the agent reported in the handshake-ack. `undefined` means the agent
   *  is older than the platform-aware build; treat as "unknown — hide
   *  platform-specific UI to be safe". */
  platform?: 'linux' | 'darwin' | 'win32' | 'other';
  connectedAt: number | null;
  error: string | null;
  /** Relay's view of whether the agent is reachable.
   *  undefined = unknown; true/false = last known. Flips to false when the
   *  relay loses the agent WebSocket even while this peer's WebRTC stays up. */
  online?: boolean;
}

interface ConnectionStore {
  // Active-agent connection state. Mirrors `agentConnections[activeAgentId]`
  // for hooks/components that don't take an agentId. Multi-agent fan-out lives
  // in `agentConnections` below.
  state: ConnectionState;
  agentId: string | null;
  signalingServer: string;
  repoPath: string | null;
  pendingRepoPath: string | null;
  availableRepos: Repository[];
  availableCodingPaths: CodingPath[];
  connectedAt: number | null;
  error: string | null;
  isPro: boolean;
  agentVersion: string | null;
  latestVersion: string | null;
  codexModels: CodexModelInfo[];
  reconnectAttempt: number | null;
  maxReconnectAttempts: number | null;
  connectionStep: ConnectionStep | null;
  keyExchangeAttempt: number | null;
  agentOnline: boolean | null;

  // Multi-agent connection tracking
  agentConnections: Record<string, AgentConnectionState>;

  // Active-agent actions (mirror writes; per-agent versions live below)
  setConnecting: (agentId: string) => void;
  setSignaling: () => void;
  setConnected: (repoPath: string, isPro: boolean, availableRepos?: Repository[], availableCodingPaths?: CodingPath[], agentVersion?: string, latestVersion?: string) => void;
  setAgentVersion: (version: string) => void;
  setLatestVersion: (version: string) => void;
  setCodexModels: (models: CodexModelInfo[]) => void;
  setRepoPath: (repoPath: string) => void;
  setPendingRepoPath: (repoPath: string | null) => void;
  setAvailableRepos: (repos: Repository[]) => void;
  setAvailableCodingPaths: (paths: CodingPath[]) => void;
  setDisconnected: () => void;
  setReconnecting: (attempt: number, maxAttempts: number) => void;
  setError: (error: string) => void;
  setSignalingServer: (server: string) => void;
  setConnectionStep: (step: ConnectionStep, attempt?: number) => void;
  setAgentOnline: (online: boolean) => void;
  reset: () => void;

  // Multi-agent actions
  setAgentConnecting: (agentId: string) => void;
  setAgentConnected: (agentId: string, repoPath: string, isPro: boolean, availableRepos?: Repository[], availableCodingPaths?: CodingPath[], agentVersion?: string, devBuild?: boolean, platform?: 'linux' | 'darwin' | 'win32' | 'other') => void;
  setAgentDisconnected: (agentId: string) => void;
  setAgentError: (agentId: string, error: string) => void;
  setAgentOnlineFor: (agentId: string, online: boolean) => void;
  addAgentCodingPath: (agentId: string, codingPath: CodingPath) => void;
  addAgentRepo: (agentId: string, repo: Repository) => void;
  getAgentState: (agentId: string) => AgentConnectionState | undefined;
  isAgentConnected: (agentId: string) => boolean;
}

const getDefaultSignalingServer = () => {
  if (import.meta.env.QUICKSAVE_SIGNALING_URL) {
    return import.meta.env.QUICKSAVE_SIGNALING_URL;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostname = window.location.hostname || 'localhost';
  const port = window.location.port || (protocol === 'wss:' ? '443' : '80');
  return `${protocol}//${hostname}:${port}`;
};

const DEFAULT_SIGNALING_SERVER = getDefaultSignalingServer();

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  // Initial state
  state: 'disconnected',
  agentId: null,
  signalingServer: DEFAULT_SIGNALING_SERVER,
  repoPath: null,
  pendingRepoPath: null,
  availableRepos: [],
  availableCodingPaths: [],
  connectedAt: null,
  error: null,
  isPro: false,
  agentVersion: null,
  latestVersion: null,
  codexModels: [],
  reconnectAttempt: null,
  maxReconnectAttempts: null,
  connectionStep: null,
  keyExchangeAttempt: null,
  agentOnline: null,
  agentConnections: {},

  // Active-agent actions
  setConnecting: (agentId) =>
    set({
      state: 'connecting',
      agentId,
      error: null,
    }),

  setSignaling: () =>
    set({
      state: 'connecting',
    }),

  setConnected: (repoPath, isPro, availableRepos, availableCodingPaths, agentVersion, latestVersion) =>
    set({
      state: 'connected',
      repoPath: repoPath || null,
      availableRepos: availableRepos || [],
      availableCodingPaths: availableCodingPaths || [],
      connectedAt: Date.now(),
      isPro,
      agentVersion: agentVersion || null,
      latestVersion: latestVersion || null,
      error: null,
      connectionStep: null,
      keyExchangeAttempt: null,
    }),

  setAgentVersion: (version) =>
    set({ agentVersion: version }),

  setLatestVersion: (version) =>
    set({ latestVersion: version }),

  setCodexModels: (models) =>
    set({ codexModels: models }),

  setRepoPath: (repoPath) =>
    set({ repoPath }),

  setPendingRepoPath: (repoPath) =>
    set({ pendingRepoPath: repoPath }),

  setAvailableRepos: (repos) =>
    set({ availableRepos: repos }),

  setAvailableCodingPaths: (paths) =>
    set({ availableCodingPaths: paths }),

  setDisconnected: () =>
    set({
      state: 'disconnected',
      connectedAt: null,
      reconnectAttempt: null,
      maxReconnectAttempts: null,
      connectionStep: null,
      keyExchangeAttempt: null,
      agentOnline: null,
    }),

  setReconnecting: (attempt, maxAttempts) =>
    set({
      state: 'reconnecting',
      reconnectAttempt: attempt,
      maxReconnectAttempts: maxAttempts,
    }),

  setError: (error) =>
    set({
      state: 'error',
      error,
    }),

  setSignalingServer: (server) =>
    set({ signalingServer: server }),

  setConnectionStep: (step, attempt) =>
    set({
      connectionStep: step,
      ...(attempt !== undefined ? { keyExchangeAttempt: attempt } : {}),
    }),

  setAgentOnline: (online) =>
    set({ agentOnline: online }),

  reset: () =>
    set({
      state: 'disconnected',
      agentId: null,
      repoPath: null,
      pendingRepoPath: null,
      availableRepos: [],
      availableCodingPaths: [],
      connectedAt: null,
      error: null,
      isPro: false,
      agentVersion: null,
      latestVersion: null,
      codexModels: [],
      reconnectAttempt: null,
      maxReconnectAttempts: null,
      connectionStep: null,
      keyExchangeAttempt: null,
      agentOnline: null,
    }),

  // Multi-agent actions
  setAgentConnecting: (agentId) =>
    set((state) => ({
      agentConnections: {
        ...state.agentConnections,
        [agentId]: {
          state: 'connecting',
          repoPath: null,
          availableRepos: [],
          availableCodingPaths: [],
          isPro: false,
          agentVersion: null,
          devBuild: false,
          connectedAt: null,
          error: null,
        },
      },
    })),

  setAgentConnected: (agentId, repoPath, isPro, availableRepos, availableCodingPaths, agentVersion, devBuild, platform) =>
    set((state) => ({
      agentConnections: {
        ...state.agentConnections,
        [agentId]: {
          state: 'connected',
          repoPath: repoPath || null,
          availableRepos: availableRepos || [],
          availableCodingPaths: availableCodingPaths || [],
          isPro,
          agentVersion: agentVersion || null,
          devBuild: devBuild || false,
          platform,
          connectedAt: Date.now(),
          error: null,
        },
      },
    })),

  setAgentDisconnected: (agentId) =>
    set((state) => {
      const { [agentId]: _, ...rest } = state.agentConnections;
      return { agentConnections: rest };
    }),

  setAgentError: (agentId, error) =>
    set((state) => ({
      agentConnections: {
        ...state.agentConnections,
        [agentId]: {
          ...(state.agentConnections[agentId] || {
            state: 'error', repoPath: null, availableRepos: [],
            availableCodingPaths: [], isPro: false, agentVersion: null, devBuild: false, connectedAt: null,
          }),
          state: 'error',
          error,
        },
      },
    })),

  setAgentOnlineFor: (agentId, online) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      if (!existing) return state;
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: { ...existing, online },
        },
      };
    }),

  addAgentCodingPath: (agentId, codingPath) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      if (!existing) return state;
      if (existing.availableCodingPaths.some((p) => p.path === codingPath.path)) return state;
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: {
            ...existing,
            availableCodingPaths: [...existing.availableCodingPaths, codingPath],
          },
        },
      };
    }),

  addAgentRepo: (agentId, repo) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      if (!existing) return state;
      if (existing.availableRepos.some((r) => r.path === repo.path)) return state;
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: {
            ...existing,
            availableRepos: [...existing.availableRepos, repo],
          },
        },
      };
    }),

  getAgentState: (agentId) => get().agentConnections[agentId],

  isAgentConnected: (agentId) => get().agentConnections[agentId]?.state === 'connected',
}));
