// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import { clsx } from 'clsx';
import { useClaudeStore } from '../stores/claudeStore';
import { useConnectionStore } from '../stores/connectionStore';
import type {
  ClaudeSessionSummary,
  ClaudeUserInputResponsePayload,
  ConfigValue,
  SessionControlRequestResponsePayload,
} from '@sumicom/quicksave-shared';
import { CardRenderer } from './chat/CardRenderer';
import { SessionList } from './chat/SessionList';
import { NewSessionEmptyState } from './chat/NewSessionEmptyState';
import { SessionStatusBar } from './chat/SessionStatusBar';
import { SessionStatsBar } from './chat/SessionStatsBar';
import { StreamingReconnectIndicator } from './chat/StreamingReconnectIndicator';
import { ToolCallGroupPlaceholder } from './chat/ToolCallGroupPlaceholder';
import { ToolCallVisibilityChip } from './chat/ToolCallVisibilityChip';
import { AttachmentTray } from './AttachmentTray';
import { useUiPrefsStore } from '../stores/uiPrefsStore';
import { getAgentType } from '../lib/claudePresets';
import type { AttachmentMetadata } from '@sumicom/quicksave-shared';
import {
  startUpload,
  cancelUpload,
  forgetUpload,
  useAttachmentUploadStore,
  type PendingAttachment,
} from '../lib/attachmentUploader';
import { attachmentsFromDataTransfer, inspectPaste, processPasteInspection } from '../lib/attachments';

type StartSessionOpts = { agent?: 'claude-code' | 'codex'; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; sandboxed?: boolean; reasoningEffort?: string; contextWindow?: number; attachmentIds?: string[]; attachmentMetadata?: AttachmentMetadata[] };
type ResumeSessionOpts = { attachmentIds?: string[]; attachmentMetadata?: AttachmentMetadata[] };

interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

interface ClaudePanelProps {
  onSelectSession?: (sessionId: string) => void;
  sessionId?: string;
  newSession?: boolean;
  cwd?: string;
  onGetSessionCards: (sessionId: string, offset?: number, limit?: number) => Promise<void>;
  onSetSessionConfig?: (sessionId: string, key: string, value: ConfigValue) => void;
  onSendControlRequest?: (
    sessionId: string,
    subtype: string,
    params?: Record<string, unknown>,
  ) => Promise<SessionControlRequestResponsePayload>;
  onStartSession: (prompt: string, opts?: StartSessionOpts) => Promise<void>;
  onResumeSession: (sessionId: string, prompt: string, opts?: ResumeSessionOpts) => Promise<void>;
  onRespondToUserInput?: (response: ClaudeUserInputResponsePayload) => void;
  onUnsubscribeSession?: (sessionId: string) => void;
  onNewSession?: () => void;
}

export function ClaudePanel({
  onSelectSession,
  sessionId: urlSessionId,
  newSession,
  cwd,
  onGetSessionCards,
  onSetSessionConfig,
  onSendControlRequest,
  onStartSession,
  onResumeSession,

  onRespondToUserInput,
  onUnsubscribeSession,
  onNewSession,
}: ClaudePanelProps) {
  const {
    sessions,
    activeSessionId,
    isStreaming,
    streamError,
    cards,
    historyHasMore,
    isLoadingHistory,
    historyError,
    promptInput,
    selectedAgent,
    selectedModel,
    selectedPermissionMode,
    selectedReasoningEffort,
    selectedContextWindow,
    sandboxEnabled,
    setPromptInput,
    setActiveSession,
    clearCards,
  } = useClaudeStore();

  const hideToolCalls = useUiPrefsStore((s) => s.hideToolCalls);

  // ── Attachment composer state ────────────────────────────────────────────
  // `pendingAttachments` is the set of chips currently displayed; the upload
  // manager (Zustand store) tracks per-id progress separately. Send is
  // gated until every chip's status is `ready`.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pastedTextCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachmentToast, setAttachmentToast] = useState<string | null>(null);
  const uploadStates = useAttachmentUploadStore((s) => s.uploads);
  const allUploadsReady = pendingAttachments.every((p) => uploadStates[p.id]?.status === 'ready');
  const anyUploadInFlight = pendingAttachments.some((p) => {
    const s = uploadStates[p.id]?.status;
    return s === 'queued' || s === 'uploading';
  });

  const ingestAttachments = useCallback((accepted: PendingAttachment[], rejected: { message: string }[]) => {
    if (accepted.length > 0) {
      setPendingAttachments((prev) => [...prev, ...accepted]);
      for (const a of accepted) startUpload(a);
    }
    if (rejected.length > 0) {
      setAttachmentToast(rejected.map((r) => r.message).join('\n'));
      window.setTimeout(() => setAttachmentToast(null), 4000);
    }
  }, []);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((p) => p.id !== id));
    void cancelUpload(id);
    forgetUpload(id);
  }, []);

  const handleFilePick = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const dt = new DataTransfer();
    for (let i = 0; i < files.length; i++) {
      const f = files.item(i);
      if (f) dt.items.add(f);
    }
    const result = await attachmentsFromDataTransfer(dt, pendingAttachments.length);
    ingestAttachments(result.accepted, result.rejected);
  }, [pendingAttachments.length, ingestAttachments]);

  const [isDraggingFile, setIsDraggingFile] = useState(false);

  // Per-group override: when global hide is on, individual groups can be
  // expanded by clicking their placeholder; the entry is keyed by the group's
  // first card id. Cleared whenever the global flag flips so the new default
  // applies cleanly.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const handleToggleVisibility = useCallback(() => {
    setExpandedGroups(new Set());
  }, []);
  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Build the display sequence: when tool calls are hidden, fold each run of
  // consecutive tool_call cards into a single placeholder so other message
  // types stay in their original order. Per-group expansion replaces the
  // placeholder with a "hide" chip followed by the individual cards.
  const displayItems = useMemo(() => {
    type Item =
      | { kind: 'card'; card: typeof cards[number] }
      | { kind: 'tool_group_collapsed'; key: string; groupId: string; count: number }
      | { kind: 'tool_group_expanded_header'; key: string; groupId: string; count: number };
    if (!hideToolCalls) {
      return cards.map<Item>((card) => ({ kind: 'card', card }));
    }
    const out: Item[] = [];
    let runCards: typeof cards = [];
    let runStartId: string | null = null;
    const flushRun = () => {
      if (!runStartId || runCards.length === 0) return;
      const groupId = runStartId;
      // Force the group open when any tool call inside has a pending
      // permission/question — the user can't make a decision they can't see.
      // No header chip in this mode: collapsing wouldn't take effect until the
      // request resolves, so the affordance would be misleading.
      const hasPendingInput = runCards.some((c) => c.pendingInput);
      if (hasPendingInput) {
        for (const c of runCards) out.push({ kind: 'card', card: c });
      } else if (expandedGroups.has(groupId)) {
        out.push({
          kind: 'tool_group_expanded_header',
          key: `tgh:${groupId}`,
          groupId,
          count: runCards.length,
        });
        for (const c of runCards) out.push({ kind: 'card', card: c });
      } else {
        out.push({
          kind: 'tool_group_collapsed',
          key: `tgc:${groupId}`,
          groupId,
          count: runCards.length,
        });
      }
      runCards = [];
      runStartId = null;
    };
    for (const card of cards) {
      if (card.type === 'tool_call') {
        if (runStartId === null) runStartId = card.id;
        runCards.push(card);
      } else {
        flushRun();
        out.push({ kind: 'card', card });
      }
    }
    flushRun();
    return out;
  }, [cards, hideToolCalls, expandedGroups]);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const isInactiveRaw = !!activeSessionId && !!activeSession && activeSession.isActive === false;
  // Stabilize: only update isInactive when the session is actually found in the list.
  // Prevents flicker during session list refresh (where activeSession is briefly undefined).
  const isInactiveRef = useRef(false);
  if (activeSession !== undefined || !activeSessionId) {
    isInactiveRef.current = isInactiveRaw;
  }
  const isInactive = isInactiveRef.current;
  // True during the window between setStreaming(true) and setActiveSession() — new session spinning up
  const isStartingNewSession = isStreaming && !activeSessionId;
  // True during cold resume: set when resuming an inactive session, cleared on first card event.
  const [isResuming, setIsResuming] = useState(false);

  // Clear isResuming when first non-user card arrives (Claude started responding)
  useEffect(() => {
    if (isResuming && cards.length > 0) {
      const last = cards[cards.length - 1];
      if (last.type !== 'user') setIsResuming(false);
    }
  }, [isResuming, cards]);

  const selectedAgentType = getAgentType(selectedAgent);

  // View is determined by URL: sessionId present = chat, ?new = new session, absent = sessions list
  const isChat = !!urlSessionId || !!newSession;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Per-session draft persistence
  const draftKey = urlSessionId ? `qs_draft_${urlSessionId}` : newSession ? 'qs_draft_new' : null;

  // Restore draft when session changes
  useEffect(() => {
    if (!draftKey) return;
    const saved = localStorage.getItem(draftKey) ?? '';
    setPromptInput(saved);
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const el = inputRef.current;
        el.style.height = 'auto';
        const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20;
        el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5)}px`;
      }
    });
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const connectionState = useConnectionStore((s) => s.state);
  const agentOnline = useConnectionStore((s) => s.agentOnline);

  // Load session messages when navigating to a different session (or away from one)
  useEffect(() => {
    if (urlSessionId === activeSessionId) return;
    if (activeSessionId) {
      console.log(`[sub:panel] switching session: unsub ${activeSessionId.slice(0, 8)} → sub ${urlSessionId?.slice(0, 8) ?? 'null'}`);
      onUnsubscribeSession?.(activeSessionId);
    }
    setActiveSession(urlSessionId ?? null);
    clearCards();
    if (urlSessionId) {
      isAtBottomRef.current = true;
      onGetSessionCards(urlSessionId);
    }
  }, [urlSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-subscribe after agent reconnect: the relay drops all pubsub subscriptions
  // when the agent's WebSocket disconnects. When the agent comes back online and
  // key exchange completes, we must call getCards (which re-subscribes the peer).
  // This covers both full PWA reconnects (connectionState change) and agent-only
  // relay blips (agentOnline flips false→true while connectionState stays 'connected').
  const prevOnlineRef = useRef(agentOnline);
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = agentOnline;
    if (!urlSessionId || connectionState !== 'connected') return;
    // Agent came back online (was offline or null → true)
    if (agentOnline === true && wasOnline === false) {
      console.log(`[sub:panel] agent reconnected: re-subscribe session=${urlSessionId.slice(0, 8)}`);
      onGetSessionCards(urlSessionId);
    }
    // Initial load: no cards yet
    if (agentOnline === true && wasOnline === null && cards.length === 0) {
      console.log(`[sub:panel] initial load: subscribe session=${urlSessionId.slice(0, 8)}`);
      onGetSessionCards(urlSessionId);
    }
  }, [agentOnline, connectionState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsubscribe when leaving session view (navigating to session list)
  useEffect(() => {
    if (!isChat && activeSessionId) {
      console.log(`[sub:panel] leaving chat view: unsub session=${activeSessionId.slice(0, 8)}`);
      onUnsubscribeSession?.(activeSessionId);
    }
  }, [isChat]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll: stick to bottom unless user has scrolled up
  const isAtBottomRef = useRef(true);
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      isAtBottomRef.current = distFromBottom < 80;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    if (isAtBottomRef.current) {
      // If the last card has a pending request, scroll to its top so the user sees it fully
      const lastCard = cards[cards.length - 1];
      if (lastCard?.pendingInput) {
        const el = container.querySelector(`[data-card-id="${lastCard.id}"]`);
        if (el) {
          el.scrollIntoView({ block: 'start' });
          return;
        }
      }
      container.scrollTop = container.scrollHeight;
    }
  }, [cards, isStreaming]);


  const handleSelectSession = useCallback(async (session: ClaudeSessionSummary) => {
    if (onSelectSession) {
      onSelectSession(session.sessionId);
    } else {
      setActiveSession(session.sessionId);
      clearCards();
      await onGetSessionCards(session.sessionId);
    }
  }, [onSelectSession, setActiveSession, clearCards, onGetSessionCards]);

  const handleNewSession = useCallback(() => {
    if (activeSessionId) {
      console.log(`[sub:panel] new session: unsub session=${activeSessionId.slice(0, 8)}`);
      onUnsubscribeSession?.(activeSessionId);
    }
    setActiveSession(null);
    clearCards();
    if (onNewSession) {
      onNewSession();
    }
  }, [activeSessionId, setActiveSession, clearCards, onNewSession, onUnsubscribeSession]);

  const handleSend = useCallback(async () => {
    const prompt = promptInput.trim();
    // A turn is sendable if there's prompt text OR at least one ready attachment.
    const hasContent = prompt.length > 0 || pendingAttachments.length > 0;
    if (!hasContent) return;
    if (!allUploadsReady) return;

    isAtBottomRef.current = true;
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }

    // Snapshot the chip set for this turn, then clear composer state. The
    // upload manager is forgotten *after* the send fires so primeUploaded
    // (called inside useClaudeOperations) can still read local bytes.
    const turnAttachments = pendingAttachments;
    const attachmentIds = turnAttachments.map((p) => p.id);
    const attachmentMetadata: AttachmentMetadata[] = turnAttachments.map((p) => ({
      id: p.id,
      kind: p.kind,
      mimeType: p.mimeType,
      name: p.name,
      size: p.bytes.byteLength,
    }));

    setPromptInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setPendingAttachments([]);
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    if (draftKey) localStorage.removeItem(draftKey);

    try {
      if (activeSessionId) {
        if (isInactive) setIsResuming(true);
        await onResumeSession(activeSessionId, prompt, {
          ...(attachmentIds.length > 0 ? { attachmentIds, attachmentMetadata } : {}),
        });
      } else {
        await onStartSession(prompt, {
          agent: selectedAgent,
          model: selectedModel,
          permissionMode: selectedPermissionMode,
          sandboxed: sandboxEnabled || undefined,
          // Claude CLI honors contextWindow via CLAUDE_CODE_AUTO_COMPACT_WINDOW;
          // Codex ignores it. Send for both — agent layer narrows.
          ...(selectedContextWindow ? { contextWindow: selectedContextWindow } : {}),
          // Both providers honor reasoningEffort: Codex via SDK
          // `modelReasoningEffort`, Claude via CLI `--effort` / SDK
          // `Options.effort`. Enums differ (Codex: minimal/low/medium/high/xhigh;
          // Claude: low/medium/high/xhigh/max) — agent validates per provider.
          ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
          ...(selectedAgentType.allowedTools !== undefined ? { allowedTools: selectedAgentType.allowedTools } : {}),
          ...(selectedAgentType.systemPrompt ? { systemPrompt: selectedAgentType.systemPrompt } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds, attachmentMetadata } : {}),
        });
      }
    } finally {
      // Clean up the upload manager state for the chips that just shipped.
      for (const id of attachmentIds) forgetUpload(id);
    }
  }, [promptInput, pendingAttachments, allUploadsReady, isStreaming, activeSessionId, isInactive, selectedAgent, selectedModel, selectedPermissionMode, sandboxEnabled, selectedReasoningEffort, selectedContextWindow, selectedAgentType, setPromptInput, onResumeSession, onStartSession, draftKey]);

  /**
   * Send a fixed prompt without using the composer input. Used by inline
   * action cards (recovery_suggested → `/compact`). Resume-only — these
   * actions are always invoked on an active session, never to start a new
   * one. Skips the attachment / draft / streaming-state machinery since
   * there's no composer state to consume.
   */
  const handleSendQuickPrompt = useCallback(async (prompt: string) => {
    if (!prompt) return;
    if (!activeSessionId) return;
    if (isInactive) setIsResuming(true);
    await onResumeSession(activeSessionId, prompt, {});
  }, [activeSessionId, isInactive, onResumeSession]);

  const handleRespondToInput = useCallback((requestId: string, action: 'allow' | 'deny', response?: string, allowPattern?: string) => {
    if (!onRespondToUserInput) return;
    // Read cards from the live store rather than the closure so this
    // callback reference stays stable across re-renders — required for
    // CardRenderer's memoization to actually skip re-renders on keystrokes.
    const card = useClaudeStore.getState().cards.find((c) => c.pendingInput?.requestId === requestId);
    if (!card?.pendingInput) return;
    onRespondToUserInput({
      sessionId: card.pendingInput.sessionId,
      requestId,
      action: action === 'allow' ? (response ? 'respond' : 'allow') : 'deny',
      response,
      allowPattern,
    });
  }, [onRespondToUserInput]);

  const handleLoadMore = useCallback(async () => {
    // Read isLoadingHistory from live store state (not stale closure) to prevent
    // the IntersectionObserver from firing duplicate requests before React re-renders.
    if (!activeSessionId || useClaudeStore.getState().isLoadingHistory || !historyHasMore) return;
    const container = chatContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    await onGetSessionCards(activeSessionId, cards.length);
    // Restore scroll position so the viewport doesn't jump to top
    if (container) {
      container.scrollTop = container.scrollHeight - prevScrollHeight;
    }
  }, [activeSessionId, historyHasMore, cards.length, onGetSessionCards]);

  // Auto-load older messages when sentinel scrolls into view
  const topSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel || !historyHasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) handleLoadMore(); },
      { root: chatContainerRef.current, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyHasMore, handleLoadMore]);

  // ── Slash-command autocomplete ──
  // Source: `reload_plugins` control_request → `commands: [{name, description, argumentHint}]`.
  // Cached per active session (the list is per-CLI-process and rarely changes). New-session
  // view has no CLI to ask, so the popover stays dormant until the session starts.
  const [slashCommands, setSlashCommands] = useState<SlashCommand[] | null>(null);
  const slashCommandsSessionIdRef = useRef<string | null>(null);
  const slashCommandsFetchingRef = useRef(false);
  const [slashIndex, setSlashIndex] = useState(0);

  const slashQuery = useMemo(() => {
    const m = /^\s*\/(\w*)$/.exec(promptInput);
    return m ? m[1] : null;
  }, [promptInput]);
  const slashOpen = slashQuery !== null;

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null || !slashCommands) return [];
    const q = slashQuery.toLowerCase();
    if (!q) return slashCommands;
    return slashCommands.filter((c) => c.name.toLowerCase().includes(q));
  }, [slashQuery, slashCommands]);

  // Reset selection whenever the filtered list changes shape.
  useEffect(() => { setSlashIndex(0); }, [slashQuery, filteredSlashCommands.length]);

  // Keep the highlighted row visible when navigating with arrow keys.
  const slashListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!slashOpen) return;
    const el = slashListRef.current?.children[slashIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashOpen]);

  // Lazy-fetch the command list the first time the popover opens for a session.
  useEffect(() => {
    if (!slashOpen) return;
    if (!activeSessionId || !onSendControlRequest) return;
    if (slashCommandsSessionIdRef.current === activeSessionId && slashCommands) return;
    if (slashCommandsFetchingRef.current) return;
    slashCommandsFetchingRef.current = true;
    onSendControlRequest(activeSessionId, 'reload_plugins')
      .then((resp) => {
        if (!resp.success) return;
        const commands = (resp.response as { commands?: SlashCommand[] } | undefined)?.commands;
        if (Array.isArray(commands)) {
          slashCommandsSessionIdRef.current = activeSessionId;
          setSlashCommands(commands);
        }
      })
      .catch((err) => {
        console.warn('[slash] reload_plugins failed:', err);
      })
      .finally(() => {
        slashCommandsFetchingRef.current = false;
      });
  }, [slashOpen, activeSessionId, onSendControlRequest, slashCommands]);

  // Drop the cache when switching sessions; the new session has its own command set.
  useEffect(() => {
    if (slashCommandsSessionIdRef.current && slashCommandsSessionIdRef.current !== activeSessionId) {
      slashCommandsSessionIdRef.current = null;
      setSlashCommands(null);
    }
  }, [activeSessionId]);

  const insertSlashCommand = useCallback((cmd: SlashCommand) => {
    setPromptInput(`/${cmd.name} `);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const pos = el.value.length;
      el.setSelectionRange(pos, pos);
      el.style.height = 'auto';
      const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20;
      el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5)}px`;
    });
  }, [setPromptInput]);

  const isMobile = 'ontouchstart' in window;
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Slash-command popover swallows nav keys before send/newline handling.
    if (slashOpen && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        const cmd = filteredSlashCommands[slashIndex];
        if (cmd) insertSlashCommand(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPromptInput('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isMobile) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, isMobile, slashOpen, filteredSlashCommands, slashIndex, insertSlashCommand, setPromptInput]);

  // Debounced draft save (3s)
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveDraft = useCallback((value: string) => {
    if (!draftKey) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      if (value) {
        localStorage.setItem(draftKey, value);
      } else {
        localStorage.removeItem(draftKey);
      }
    }, 3000);
  }, [draftKey]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setPromptInput(value);
    saveDraft(value);
    const el = e.target;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5)}px`;
  }, [saveDraft, setPromptInput]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {isChat ? (
        <>
          {/* Messages */}
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 select-text overscroll-contain">
            {historyHasMore && (
              <div ref={topSentinelRef} className="flex justify-center py-2 h-8">
                {isLoadingHistory && (
                  <svg className="w-5 h-5 text-slate-500 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                )}
              </div>
            )}
            {/* Initial history loading spinner (before any cards arrive) */}
            {!newSession && cards.length === 0 && isLoadingHistory && !historyError && (
              <div className="flex items-center justify-center py-12">
                <svg className="w-6 h-6 text-slate-500 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              </div>
            )}
            {/* History load error with retry */}
            {historyError && cards.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <p className="text-sm text-slate-400">{historyError}</p>
                <button
                  onClick={() => urlSessionId && onGetSessionCards(urlSessionId)}
                  className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}
            {(() => {
              const lastCardId = cards[cards.length - 1]?.id;
              return displayItems.map((item) => {
                if (item.kind === 'tool_group_collapsed' || item.kind === 'tool_group_expanded_header') {
                  return (
                    <ToolCallGroupPlaceholder
                      key={item.key}
                      count={item.count}
                      expanded={item.kind === 'tool_group_expanded_header'}
                      onToggle={() => toggleGroup(item.groupId)}
                    />
                  );
                }
                const card = item.card;
                return (
                  <div key={card.id} data-card-id={card.id}>
                    <CardRenderer
                      card={card}
                      isLast={card.id === lastCardId}
                      sessionId={activeSessionId}
                      onRespondToInput={handleRespondToInput}
                      onSendQuickPrompt={handleSendQuickPrompt}
                    />
                  </div>
                );
              });
            })()}
            {streamError && (
              <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                {streamError}
              </div>
            )}
            {(() => {
              // Show bounce dots when in "thinking" state (blue indicator):
              // streaming (from either local state or agent push), not pending permission, not resuming.
              // While the link's status is uncertain (reconnecting / agent
              // offline / fully dropped), swap to StreamingReconnectIndicator
              // so the user sees we're waiting on connectivity rather than on
              // the model — without prematurely tearing down the in-flight
              // stream, which would happen if we treated WS blips as
              // "session ended."
              const sessionStreaming = isStreaming || !!activeSession?.isStreaming;
              const showDots = sessionStreaming && !isResuming && !activeSession?.hasPendingInput;
              if (!showDots) return null;
              const linkUncertain = connectionState !== 'connected' || agentOnline === false;
              return linkUncertain ? (
                <StreamingReconnectIndicator />
              ) : (
                <div className="flex items-center gap-1.5 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </div>
              );
            })()}
            {/* New session empty state — inside scrollable container */}
            {newSession && cards.length === 0 && (
              <NewSessionEmptyState cwd={cwd} />
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Session status banner */}
          {(isStartingNewSession || isResuming || isInactive) && (
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-700/50 border-t border-slate-700 text-xs text-slate-400">
              {(isStartingNewSession || isResuming || (isInactive && isStreaming)) ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  {isStartingNewSession ? 'Starting task...' : 'Resuming task...'}
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0" />
                  Task inactive — send a message to resume
                </>
              )}
            </div>
          )}

          {/* Input */}
          <div className="border-t border-slate-700 px-4 pt-3 flex-shrink-0 bg-slate-900 safe-area-bottom-input touch-none">
            {activeSessionId && (
              <SessionStatusBar
                sessionId={activeSessionId}
                onSetSessionConfig={onSetSessionConfig}
              >
                <ToolCallVisibilityChip onChange={handleToggleVisibility} />
                <SessionStatsBar
                  sessionId={activeSessionId}
                  onCompact={() => onResumeSession(activeSessionId, '/compact')}
                  onClear={handleNewSession}
                />
              </SessionStatusBar>
            )}
            <AttachmentTray pending={pendingAttachments} onRemove={removePendingAttachment} />
            {attachmentToast && (
              <div className="mb-1.5 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 whitespace-pre-line">
                {attachmentToast}
              </div>
            )}
            {/* iOS Safari refuses to open the picker for `display: none`
                inputs and is finicky about programmatic `.click()`; using
                a `<label htmlFor>` with an `sr-only` input is the native,
                gesture-friendly path. */}
            <input
              id="qs-attach-input"
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,text/*,application/json,application/xml"
              className="sr-only"
              onChange={(e) => {
                void handleFilePick(e.target.files);
                e.target.value = '';
              }}
            />
            <div
              className={clsx(
                'relative flex items-end gap-2 rounded-lg transition-colors',
                isDraggingFile && 'ring-2 ring-blue-400/60 bg-blue-500/5',
              )}
              onDragOver={(e) => {
                if (e.dataTransfer?.types?.includes('Files')) {
                  e.preventDefault();
                  setIsDraggingFile(true);
                }
              }}
              onDragLeave={(e) => {
                if (e.target === e.currentTarget) setIsDraggingFile(false);
              }}
              onDrop={async (e) => {
                if (!e.dataTransfer?.types?.includes('Files')) return;
                e.preventDefault();
                setIsDraggingFile(false);
                const result = await attachmentsFromDataTransfer(e.dataTransfer, pendingAttachments.length);
                ingestAttachments(result.accepted, result.rejected);
              }}
            >
              {slashOpen && filteredSlashCommands.length > 0 && (
                <div ref={slashListRef} className="absolute left-0 right-0 bottom-full mb-2 max-h-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 shadow-lg z-10">
                  {filteredSlashCommands.map((cmd, i) => (
                    <button
                      key={cmd.name}
                      type="button"
                      onPointerDown={(e) => { e.preventDefault(); insertSlashCommand(cmd); }}
                      onMouseEnter={() => setSlashIndex(i)}
                      className={clsx(
                        'w-full text-left px-3 py-1.5 flex items-baseline gap-2 text-sm',
                        i === slashIndex ? 'bg-slate-700' : 'hover:bg-slate-700/60',
                      )}
                    >
                      <span className="font-mono text-blue-300 shrink-0">/{cmd.name}</span>
                      {cmd.argumentHint && (
                        <span className="font-mono text-slate-500 shrink-0 text-xs">{cmd.argumentHint}</span>
                      )}
                      {cmd.description && (
                        <span className="text-slate-400 truncate text-xs">— {cmd.description}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <label
                htmlFor="qs-attach-input"
                className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 flex-shrink-0 cursor-pointer flex items-center justify-center"
                title="Attach files"
                aria-label="Attach files"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              </label>
              <textarea
                ref={inputRef}
                value={promptInput}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={(e) => {
                  // iOS Safari completes paste insertion the moment this
                  // handler returns, so preventDefault MUST happen
                  // synchronously — `inspectPaste` snapshots files + text
                  // off `clipboardData` while it's still valid, and we
                  // hand the snapshot to the async processor.
                  const inspection = inspectPaste(e.nativeEvent.clipboardData);
                  if (inspection.mode === 'passthrough') return;
                  e.preventDefault();
                  const opts = {
                    existingCount: pendingAttachments.length,
                    pastedTextIndex: pastedTextCountRef.current + 1,
                  };
                  if (inspection.mode === 'long-text') pastedTextCountRef.current += 1;
                  void processPasteInspection(inspection, opts).then((result) => {
                    if (result.accepted.length > 0 || result.rejected.length > 0) {
                      ingestAttachments(result.accepted, result.rejected);
                    }
                  });
                }}
                placeholder=""
                className="flex-1 bg-slate-700 rounded-lg px-3 py-2 text-sm resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-blue-500"
                rows={1}
              />
              <button
                onPointerDown={(e) => { e.preventDefault(); handleSend(); }}
                disabled={(!promptInput.trim() && pendingAttachments.length === 0) || anyUploadInFlight}
                className={clsx(
                  'p-2 rounded-lg transition-colors flex-shrink-0',
                  (promptInput.trim() || pendingAttachments.length > 0) && !anyUploadInFlight
                    ? 'bg-blue-600 hover:bg-blue-500'
                    : 'bg-slate-600 text-slate-400'
                )}
                title={anyUploadInFlight ? 'Waiting for uploads…' : 'Send'}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
                </svg>
              </button>
            </div>
          </div>
        </>
      ) : (
        <SessionList
          sessions={Object.values(sessions).filter((s) => s.cwd === cwd)}
          onSelect={handleSelectSession}
          onNewSession={handleNewSession}
        />
      )}
    </div>
  );
}
