# Service Daemon

**Date:** 2026-04-04
**Status:** Partially Implemented

Related reference:

- `docs/research/2026-04-05-service-daemon-external-reference.md`

## Implementation Status (2026-04-06)

> **Key divergence from original design:** The original design proposed detached worker processes that survive daemon restarts, communicating via IPC socket. The actual implementation uses the Claude Agent SDK V2 API (`unstable_v2_createSession`), which spawns session processes as **direct children of the daemon** communicating via stdin/stdout pipes. This means daemon death kills all session processes. This is consistent with how the VS Code extension operates — it is the standard SDK pattern, not a limitation we need to work around.
>
> **Session recovery:** When the daemon restarts, sessions are recovered via `unstable_v2_resumeSession`, which re-spawns a new process and replays the session JSONL (including compaction summaries). The context window is fully restored. Pending tool calls (e.g. `AskUserQuestion` awaiting user input) are detectable from the JSONL — the last message is a `tool_use` with no following `tool_result`.
>
> **History storage:** The SDK writes an append-only JSONL per session at `~/.claude/projects/{project-hash}/{session-id}.jsonl`. This is the single source of truth for message history. We do not maintain a separate JSONL — the SDK's is complete, un-truncated, and includes compaction entries.
>
> **Event architecture:** `ClaudeCodeService` extends `EventEmitter` and emits `stream`, `stream:end`, `user-input-request`, `user-input-resolved`, and `session-updated` events. `run.ts` subscribes and calls `connection.broadcast()` to push events to all connected PWA peers. No callbacks are bound to specific connections — stale-callback issues are eliminated.
>
> **Sections marked `[DEFERRED]` below describe the original detached-worker design. They are preserved for reference but are not implemented and not currently planned.**

### Tool Permission Model (Implemented 2026-04-07)

Permission control is handled **entirely in our `canUseTool` callback**, not by the SDK's `allowedTools` or `permissionMode`. This allows runtime permission level changes without restarting the session.

**Architecture:**
- SDK `permissionMode` is set to `'default'` (most restrictive) so all tool calls reach `canUseTool`.
- SDK `allowedTools` only contains `['Read', 'Glob', 'Grep']` — read-only tools that never need prompting.
- SDK `settingSources: ['user', 'project', 'local']` — respects `.claude/settings*.json` allow/deny rules. These run **before** `canUseTool` (SDK layer: hooks → deny → mode → allow → canUseTool).
- Our `canUseTool` checks the session's `permissionLevel` against an `AUTO_APPROVE` map.
- `setPermissionLevel(sessionId, level)` changes the level at runtime — next tool call uses the new level immediately.

**Permission matrix:**

| Tool | `bypassPermissions` | `acceptEdits` | `default` | `plan` |
|---|---|---|---|---|
| Read, Glob, Grep | SDK auto | SDK auto | SDK auto | SDK auto |
| Edit, Write, NotebookEdit | auto | auto | **prompt** | **prompt** |
| Bash | auto | **prompt** | **prompt** | **prompt** |
| WebFetch, WebSearch | auto | **prompt** | **prompt** | **prompt** |
| Skill, ToolSearch, Config | auto | **prompt** | **prompt** | **prompt** |
| Agent, TodoWrite, Worktree | auto | auto | auto | **prompt** |
| AskUserQuestion | interactive UI | interactive UI | interactive UI | interactive UI |

- **SDK auto**: Tool is in SDK `allowedTools`, bypasses `canUseTool` entirely.
- **auto**: Our `canUseTool` returns `{ behavior: 'allow' }` immediately.
- **prompt**: Our `canUseTool` emits `user-input-request`, waits for user Allow/Deny via PWA.
- **interactive UI**: `AskUserQuestion` always renders the structured question UI regardless of permission level.

**Precedence order** (first match wins):
1. `.claude/settings*.json` deny rules → blocked
2. `.claude/settings*.json` allow rules (e.g. `Bash(npx vitest run:*)`) → auto-approved
3. SDK `allowedTools` (`Read`, `Glob`, `Grep`) → auto-approved
4. Our `AUTO_APPROVE[session.permissionLevel]` → auto-approved
5. Our `canUseTool` → prompt user via PWA

**TODO:** Implement a PWA UI for users to manage their own per-tool allow rules (similar to `.claude/settings.local.json` but through the UI).

## Problem

The current `quicksave` agent is a foreground CLI process. It owns the signaling connection, prints the QR code, runs Claude sessions in-process, and exits on `Ctrl+C`.

That model breaks down once we want `quicksave` to behave like a service:

- There is no reliable singleton; a second `quicksave` invocation can create a second process and a second signaling connection.
- There is no background lifecycle; the service only exists while a terminal stays open.
- Claude session state lives inside the foreground process, so session supervision, cancellation, and crash recovery are weak.
- Repository configuration is passed at startup rather than managed as daemon-owned state.

## Goals

- Exactly one daemon per local user profile owns the machine identity and signaling connection.
- Any `quicksave` CLI invocation can attach to the existing daemon instead of creating another connection.
- Long-lived Claude sessions are supervised by the daemon instead of being tied to a terminal.
- Bare `quicksave` keeps a familiar UX: show status, pairing info, and live activity, but `Ctrl+C` only detaches.
- Default startup is zero-friction: commands that need the agent auto-start it if needed.
- The design leaves room for future session flavors beyond Claude.

## Non-Goals

- No relay protocol change in the first cut.
- No PWA protocol rewrite in the first cut.
- No attempt to auto-restart interactive Claude sessions after a crash; interrupted sessions can be resumed explicitly.
- No system-wide root service; daemon scope is per logged-in OS user.

## Constraints

- `agent.json` already persists identity, signaling server, license, and Anthropic credentials in `~/.quicksave`.
- The current PWA model already supports multiple peers talking to one agent.
- Git operations are already repo-scoped and can remain inside the main daemon process.
- Claude integration currently uses `@anthropic-ai/claude-agent-sdk` (`query()`) and must keep streaming responses.
- Anthropic policy (as of 2026-02-19) prohibits subscription OAuth tokens (`sk-ant-oat01-`) in the Agent SDK. Subscription OAuth is only permitted for Claude Code CLI and Claude.ai. Third-party apps (including quicksave) must use API keys (`sk-ant-api03-`) if calling the Agent SDK directly.

## Design

### Approach

Use a VS Code-style singleton for the machine service and a Happy-style supervisor model for long-lived AI sessions:

- Singleton daemon is enforced with an exclusive lock plus local IPC endpoint.
- New CLI invocations attach to the daemon over local IPC instead of starting a second signaling connection.
- Claude work runs in SDK-spawned child processes of the daemon (not detached workers — see Implementation Status).
- Default startup is on-demand; optional OS login autostart can be added on top.

### Process Model

`quicksave` splits into three roles:

- `quicksave service run`
  Runs the long-lived daemon. This is the background entrypoint and not the normal human-facing command.
- `quicksave`
  Ensures the daemon is running, then attaches to it and renders pairing info, status, and live events.
- `quicksave service <subcommand>`
  Control plane for `start`, `stop`, `status`, `info`, `install`, and `uninstall`.

At runtime there is exactly one daemon process per user:

- The daemon owns `AgentConnection`, machine identity, peer session map, repo registry, and session supervisor.
- Local CLI processes are stateless clients. They can attach, tail events, and issue control commands.
- Each Claude session runs as a child process of the daemon via SDK V2 (`unstable_v2_createSession`). Daemon restart requires cold resume via `unstable_v2_resumeSession`.

### Single Daemon Ownership

The daemon is identified by a local runtime directory under `~/.quicksave`:

- `~/.quicksave/run/service.lock`
- `~/.quicksave/run/service.sock` on Unix
- `\\.\pipe\quicksave-service-<uid>` on Windows
- `~/.quicksave/state/service.json`
- `~/.quicksave/state/sessions/<session-id>/` (per-session directory: `state.json`, `events.jsonl`, `config.json`) — **Superseded:** session history is read directly from SDK JSONL at `~/.claude/projects/{project-hash}/{session-id}.jsonl`
- `~/.quicksave/logs/service.log`

Boot sequence:

1. Acquire `service.lock` exclusively.
2. Start local IPC server.
3. Load config and managed repos.
4. Start the single `AgentConnection`.
5. Persist ready state to `service.json`.

Attach sequence (`ensureDaemon()`) for any new CLI invocation:

1. Read `service.json` for socket path. Quick pre-check: if PID is dead, skip to step 4.
2. Connect to socket, send `hello`. This is both liveness check and version exchange.
3. Inspect `HelloResult` for version compatibility (`ipcVersion` + `buildId` in dev mode, see Version Management). If compatible, attach. If restart needed, proceed to step 4.
4. If stale or version mismatch, remove stale runtime files (including `service.sock`), and start a new daemon.
5. If lock acquisition fails (another CLI is already spawning), retry attach with backoff (up to 3 attempts, 500ms base delay).

The retry loop in step 5 handles the race where two CLI processes both detect a missing daemon and try to spawn simultaneously. The lock file ensures only one wins; the loser falls back to attaching once the winner's daemon is ready.

The daemon state file stores:

- `pid`
- `version` (semver, e.g. `"0.3.0"`)
- `ipcVersion` (integer, e.g. `1`)
- `buildId` (build output content hash, e.g. `"a3f8c2"`)
- `startedAt`
- `lastHeartbeatAt` (updated every 30s by daemon)
- `socketPath` or pipe name
- `agentId`
- `publicKey`
- `signalingServer`
- `connectionState`
- `peerCount`

Decision:

- Use lock file plus IPC health check, not PID file alone.
- Only the daemon may own the signaling connection.
- A second `quicksave` process becomes an attach client, never another agent runtime.

### Local IPC

The daemon exposes a local-only control API over Unix domain socket or Windows named pipe. We do not open a localhost TCP port.

#### Wire Format

IPC uses **JSON-RPC 2.0** over **newline-delimited** transport (each JSON-RPC message terminated by `\n`).

This deliberately differs from the PWA `Message<T>` protocol. PWA is a remote encrypted channel; IPC is a local trust boundary. Separate formats keep the boundaries clear and avoid polluting the shared `MessageType` union with internal methods.

JSON-RPC request example:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": {} }
```

JSON-RPC response example:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "version": "0.3.0", "ipcVersion": 1, "buildId": "a3f8c2" } }
```

JSON-RPC error example:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32600, "message": "Daemon shutting down" } }
```

JSON-RPC notification (server-pushed event, no `id`):

```json
{ "jsonrpc": "2.0", "method": "event.sessionStarted", "params": { "sessionId": "s1" } }
```

The `subscribe-events` method is a normal request that returns an ack. After the ack, the daemon pushes events as JSON-RPC notifications on the same connection. A per-client event buffer cap (configurable, default 1024 messages) prevents backpressure buildup; overflow drops oldest events.

#### Connection Handshake `[DEFERRED]`

> **Not implemented.** The daemon currently communicates with the PWA via WebSocket relay (encrypted `Message<T>` protocol), not local IPC. The `hello`/`HelloResult` handshake, `role: "worker"` distinction, and version negotiation are not implemented. Session worker processes do not connect via IPC — they are direct children managed through SDK V2 stdin/stdout.

Every client sends `hello` as its first message after connecting. This establishes the client role and enables the daemon to set up appropriate event routing.

```typescript
// hello params
interface HelloParams {
  role: "cli" | "worker";
  version: string;       // client's package version
  ipcVersion: number;    // client's expected IPC protocol version
  buildId: string;       // content hash of build output (dev mode staleness check)
  // Worker-only:
  sessionId?: string;    // daemon-assigned session ID
  workerPid?: number;
}

// hello result
interface HelloResult {
  daemonVersion: string;
  daemonIpcVersion: number;
  daemonBuildId: string;   // daemon's build output hash
  daemonPid: number;
}
```

`hello` always succeeds and returns `HelloResult` with the daemon's version fields. The daemon does not reject on version mismatch — the client inspects `daemonIpcVersion` and `daemonBuildId` and decides whether to restart, warn, or proceed (see Version Management).

#### Common Types `[PARTIALLY DEFERRED]`

> **Actual implementation** uses `ClaudeSessionSummary` (in `packages/shared/src/types.ts`) enriched by `ClaudeCodeService.listAvailableSessions()` with `isActive`, `isStreaming`, and `hasPendingInput` (detected from SDK JSONL). The `workerPid`, `workerConnected`, `backend`, and `WorkerStreamEvent` types below are not implemented.

```typescript
// Session metadata returned in list/status responses
interface SessionInfo {
  sessionId: string;
  providerSessionId?: string;
  forkedFrom?: string;
  repoPath: string;
  flavor: "claude";
  backend: "sdk" | "cli";
  status: "starting" | "running" | "cancelling" | "completed"
        | "failed" | "interrupted" | "expired";
  permissionMode: "interactive" | "sandboxed" | "read-only";
  model?: string;
  startedAt: string;          // ISO 8601
  lastActivityAt?: string;
  workerPid?: number;
  workerConnected: boolean;   // is the worker's IPC connection live?
}

// Normalized stream event from worker (backend-agnostic)
type WorkerStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; toolUseId: string; toolName: string }
  | { type: "tool_input_delta"; toolUseId: string; partialJson: string }
  | { type: "tool_result"; toolUseId: string; output: string; isError?: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; stopReason: string; usage?: UsageInfo }
  | { type: "result"; text: string; costUsd?: number; usage?: UsageInfo };

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Permission types
interface PermissionRequestParams {
  requestId: string;       // SDK's toolUseID
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  agentId?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  suggestions?: Array<{
    type: string;
    tool?: string;
    prefix?: string;
  }>;
}

type PermissionResponse =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

interface PendingPermissionRequest extends PermissionRequestParams {
  createdAt: string;       // ISO 8601
}
```

#### Methods: Any Client → Daemon

**`ping`** — Liveness check.

```
→ { "method": "ping", "params": {} }
← { "result": { "version": "0.3.0", "ipcVersion": 1, "buildId": "a3f8c2", "uptime": 3600 } }
```

**`status`** — Daemon status summary.

```
→ { "method": "status", "params": {} }
← { "result": {
     "version": "0.3.0", "pid": 12345, "uptime": 3600,
     "connectionState": "connected", "peerCount": 2,
     "activeSessions": 1, "managedRepos": 3
   } }
```

#### Methods: CLI → Daemon

**`subscribe-events`** — Start receiving push notifications on this connection.

```
→ { "method": "subscribe-events", "params": { "filter"?: ["session.*", "connection.*"] } }
← { "result": { "subscribed": true } }
```

After the ack, the daemon pushes event notifications (see Event Notifications below). An optional `filter` array limits which event prefixes are delivered. If omitted, all events are sent. The attach client uses these events to render the same human-facing output that the foreground CLI prints today.

**`get-pairing-info`** — Get pairing info for PWA connection.

```
→ { "method": "get-pairing-info", "params": {} }
← { "result": {
     "pairingUrl": "http://localhost:5173/pair#...",
     "agentId": "agent-abc123",
     "connectionState": "connected", "peerCount": 2
   } }
```

**`shutdown`** — Request daemon shutdown.

```
→ { "method": "shutdown", "params": {} }
← { "result": { "ok": true } }
```

**`restart`** — Request daemon restart (for version upgrades).

```
→ { "method": "restart", "params": { "killSessions"?: false } }
← { "result": { "ok": true } }
```

**`list-repos`** / **`add-repo`** / **`remove-repo`** — Manage tracked repositories.

```
→ { "method": "list-repos", "params": {} }
← { "result": { "repos": [{ "path": "/path/to/repo", "valid": true }] } }

→ { "method": "add-repo", "params": { "path": "/path/to/repo" } }
← { "result": { "added": true } }

→ { "method": "remove-repo", "params": { "path": "/path/to/repo" } }
← { "result": { "removed": true } }
```

**`list-sessions`** — List all known sessions.

```
→ { "method": "list-sessions", "params": {
     "status"?: ["running", "interrupted"],
     "repoPath"?: "/path/to/repo"
   } }
← { "result": { "sessions": SessionInfo[] } }
```

**`start-session`** — Start a new Claude session.

```
→ { "method": "start-session", "params": {
     "repoPath": "/path/to/repo",
     "prompt": "Fix the login bug",
     "model"?: "opus",
     "permissionMode"?: "interactive",
     "systemPrompt"?: "...",
     "appendSystemPrompt"?: "...",
     "allowedTools"?: ["Read", "Edit", "Bash"],
     "maxBudgetUsd"?: 5.0,
     "maxTurns"?: 10
   } }
← { "result": { "sessionId": "qs-abc123" } }
```

**`resume-session`** — Resume (fork) an existing session.

```
→ { "method": "resume-session", "params": {
     "providerSessionId": "claude-xyz789",
     "repoPath": "/path/to/repo",
     "prompt"?: "Continue from where we left off",
     "model"?: "opus",
     "permissionMode"?: "interactive"
   } }
← { "result": { "sessionId": "qs-def456", "forkedFrom": "claude-xyz789" } }
```

**`send-message`** — Send a user message to an active session (next turn).

```
→ { "method": "send-message", "params": {
     "sessionId": "qs-abc123",
     "message": "Now add tests for it"
   } }
← { "result": { "accepted": true } }
```

**`cancel-session`** — Request session cancellation.

```
→ { "method": "cancel-session", "params": { "sessionId": "qs-abc123" } }
← { "result": { "ok": true } }
```

**`list-pending-permissions`** — Get all pending permission requests.

```
→ { "method": "list-pending-permissions", "params": { "sessionId"?: "qs-abc123" } }
← { "result": { "requests": PendingPermissionRequest[] } }
```

**`respond-permission`** — Approve or deny a pending permission request.

```
→ { "method": "respond-permission", "params": {
     "requestId": "tool-use-id-123",
     "behavior": "allow",
     "updatedInput"?: { ... }
   } }
← { "result": { "ok": true } }

→ { "method": "respond-permission", "params": {
     "requestId": "tool-use-id-123",
     "behavior": "deny",
     "message": "User denied bash command"
   } }
← { "result": { "ok": true } }
```

**`get-session-messages`** — Full session transcript from SDK (local disk read, no API call).

```
→ { "method": "get-session-messages", "params": { "sessionId": "qs-abc123" } }
← { "result": { "messages": SDKMessage[] } }
```

**`get-session-history`** — Recent events from daemon ring buffer (fast catch-up).

```
→ { "method": "get-session-history", "params": {
     "sessionId": "qs-abc123",
     "since"?: "2026-04-05T10:00:00Z",
     "limit"?: 100
   } }
← { "result": { "events": Array<{ seq: number; timestamp: string; event: WorkerStreamEvent }> } }
```

#### Methods: Worker → Daemon `[DEFERRED]`

> **Not implemented.** The SDK V2 API uses stdin/stdout pipes for session communication, not IPC sockets. There are no separate worker processes that register with the daemon. Session lifecycle is managed directly by `ClaudeCodeService` calling SDK V2 APIs. Permission requests are handled via the SDK's `canUseTool` callback in-process.

Workers use two patterns:
- **Requests** (need response): `worker.register`, `worker.sync`, `worker.permissionRequest`, `worker.heartbeat`
- **Notifications** (fire-and-forget): `worker.started`, `worker.ready`, `worker.stream`, `worker.result`, `worker.error`

**`worker.register`** — First message after `hello`. Re-sent on reconnect to a new daemon. Carries the worker's current state so the daemon can determine what sync is needed.

```
→ { "method": "worker.register", "params": {
     "sessionId": "qs-abc123",
     "workerPid": 12345,
     "backend": "sdk",
     "repoPath": "/path/to/repo",
     "providerSessionId"?: "claude-xyz789",
     "workerStatus": "streaming" | "waiting_permission" | "ready",
     "lastSeq": 42,
     "pendingPermission"?: PermissionRequestParams
   } }
← { "result": {
     "registered": true,
     "permissionMode": "interactive",
     "model": "opus",
     "lastConfirmedSeq": 0,
     "pendingMessages"?: ["Now add tests for it"]
   } }
```

Key fields for sync:
- `workerStatus`: What the worker is currently doing. The daemon uses this to restore its internal session state.
- `lastSeq`: Highest seq number the worker has generated. Compared with `lastConfirmedSeq` to determine replay range.
- `pendingPermission`: If the worker is blocked on a permission request, includes the full request so the daemon can re-present it to the PWA.
- `lastConfirmedSeq` (response): The highest seq the daemon has received for this session. `0` means the daemon is fresh (restart) and needs full replay.
- `pendingMessages` (response): User messages that arrived at the daemon while the worker was disconnected.

**`worker.sync`** — Replay events the daemon missed. Sent after `worker.register` when `lastConfirmedSeq < lastSeq`.

```
→ { "method": "worker.sync", "params": {
     "sessionId": "qs-abc123",
     "events": [
       { "seq": 5, "timestamp": "2026-04-05T10:01:00Z", "event": WorkerStreamEvent },
       { "seq": 6, "timestamp": "2026-04-05T10:01:01Z", "event": WorkerStreamEvent },
       ...
     ]
   } }
← { "result": { "synced": true, "lastConfirmedSeq": 42 } }
```

The worker replays events from `lastConfirmedSeq + 1` through `lastSeq`. In practice this is a small tail — the daemon pre-populates from the worker's event JSONL on disk before the worker reconnects, so `lastConfirmedSeq` is typically close to `lastSeq`. Only events generated after the JSONL's last flush need IPC sync.

After sync, the daemon:
1. Appends the replayed events to its ring buffer.
2. Forwards them to any connected PWA clients (so they catch up too).
3. If `pendingPermission` was set in `worker.register`, pushes `event.permissionRequest` to the PWA.

This means normal operation resumes seamlessly — the PWA sees the events it missed and can present the pending permission prompt.

**`worker.permissionRequest`** — Tool needs approval. Blocks until resolved.

```
→ { "method": "worker.permissionRequest", "params": PermissionRequestParams }
← { "result": PermissionResponse }
```

The worker's `canUseTool` callback has a `signal` (AbortSignal) from the SDK. If aborted before the daemon responds, the worker cancels the pending IPC request via JSON-RPC cancel (send a request with same `id` set to null — or simply disconnect/reconnect).

**`worker.started`** — Upstream session established (notification).

```
→ { "method": "worker.started", "params": {
     "sessionId": "qs-abc123",
     "providerSessionId": "claude-xyz789"
   } }
```

**`worker.ready`** — Turn complete, waiting for next message (notification).

```
→ { "method": "worker.ready", "params": { "sessionId": "qs-abc123" } }
```

**`worker.stream`** — Streaming event (notification).

```
→ { "method": "worker.stream", "params": {
     "sessionId": "qs-abc123",
     "seq": 42,
     "event": WorkerStreamEvent
   } }
```

`seq` is per-session monotonically increasing. The daemon uses it for ordering and gap detection.

**`worker.result`** — Session/turn completed (notification).

```
→ { "method": "worker.result", "params": {
     "sessionId": "qs-abc123",
     "text": "I've fixed the login bug...",
     "costUsd": 0.12,
     "usage": UsageInfo
   } }
```

**`worker.error`** — Worker-level error (notification).

```
→ { "method": "worker.error", "params": {
     "sessionId": "qs-abc123",
     "code": "PROVIDER_ERROR",
     "message": "Rate limited",
     "fatal": false
   } }
```

If `fatal: true`, the worker will exit after sending this.

**`worker.heartbeat`** — Periodic liveness, every 15s (request). Also serves as the seq ack mechanism.

```
→ { "method": "worker.heartbeat", "params": {
     "sessionId": "qs-abc123",
     "status": "running",
     "lastSeq": 42
   } }
← { "result": {
     "ok": true,
     "lastConfirmedSeq": 42
   } }
```

The daemon responds with `lastConfirmedSeq` — the highest seq it has received (via IPC or JSONL read). The worker uses this to trim its **in-memory tail buffer** (events at or below `lastConfirmedSeq` don't need to be held in RAM since the daemon already has them). The full history remains on disk in the event JSONL regardless.

#### Methods: Daemon → Worker `[DEFERRED]`

> **Not implemented.** Same rationale as Worker → Daemon above. The daemon controls sessions directly via SDK V2 `session.send()` and `session.stream()`, not via IPC messages.

All daemon-to-worker messages are JSON-RPC **requests** (expect a response ack). This confirms the worker received and acted on the command.

**`worker.sendMessage`** — New user message for next turn.

```
→ { "method": "worker.sendMessage", "params": { "message": "Now add tests for it" } }
← { "result": { "accepted": true } }
```

**`worker.cancel`** — Graceful cancellation.

```
→ { "method": "worker.cancel", "params": { "reason"?: "User requested" } }
← { "result": { "ok": true } }
```

**`worker.shutdown`** — Immediate shutdown.

```
→ { "method": "worker.shutdown", "params": {} }
← { "result": { "ok": true } }
```

**`worker.setPermissionMode`** — Change permission mode mid-session.

```
→ { "method": "worker.setPermissionMode", "params": { "mode": "sandboxed" } }
← { "result": { "ok": true, "requiresRestart": false } }
```

If `requiresRestart: true` (CLI backend can't change mode mid-session), the daemon must re-spawn the worker.

**`worker.setModel`** — Change model mid-session.

```
→ { "method": "worker.setModel", "params": { "model": "sonnet" } }
← { "result": { "ok": true, "requiresRestart": true } }
```

Model changes require tearing down the current `query()` and starting a new one with `resume`. The worker returns `requiresRestart: true` to indicate it will restart its backend internally.

#### Event Notifications: Daemon → Subscribed CLI Clients

Pushed as JSON-RPC notifications (no `id`) to clients that called `subscribe-events`.

**`event.daemonStatus`** — Daemon state changed.
```json
{ "method": "event.daemonStatus", "params": {
  "connectionState": "connected", "peerCount": 2, "activeSessions": 1
} }
```

**`event.connectionStatus`** — Signaling connection state changed.
```json
{ "method": "event.connectionStatus", "params": {
  "state": "connected", "reason": null
} }
```

`state` is `"connected"` | `"connecting"` | `"disconnected"`.

**`event.peerConnected`** / **`event.peerDisconnected`** — PWA peer lifecycle.
```json
{ "method": "event.peerConnected", "params": { "peerId": "peer-abc", "userAgent": "..." } }
{ "method": "event.peerDisconnected", "params": { "peerId": "peer-abc", "reason": "..." } }
```

**`event.sessionUpdate`** — Session status changed (started, completed, failed, etc.).
```json
{ "method": "event.sessionUpdate", "params": { "session": SessionInfo } }
```

**`event.sessionStream`** — Forwarded stream event from a session worker.
```json
{ "method": "event.sessionStream", "params": {
  "sessionId": "qs-abc123", "seq": 42, "event": WorkerStreamEvent
} }
```

**`event.permissionRequest`** — New pending permission request.
```json
{ "method": "event.permissionRequest", "params": PendingPermissionRequest }
```

**`event.permissionResolved`** — Permission request resolved.
```json
{ "method": "event.permissionResolved", "params": {
  "requestId": "tool-use-id-123", "behavior": "allow", "resolvedAt": "..."
} }
```

**`event.log`** — Daemon log entry (for debugging).
```json
{ "method": "event.log", "params": {
  "level": "info", "message": "...", "timestamp": "..."
} }
```

#### Error Codes

Standard JSON-RPC 2.0 errors plus application-specific:

| Code | Name | When |
|------|------|------|
| `-32700` | Parse error | Malformed JSON |
| `-32600` | Invalid request | Missing required JSON-RPC fields |
| `-32601` | Method not found | Unknown method |
| `-32602` | Invalid params | Missing or wrong parameter types |
| `-32002` | Session not found | Unknown `sessionId` |
| `-32003` | Session not active | Session exists but wrong state for this command |
| `-32004` | Worker disconnected | Worker's IPC connection is down |
| `-32005` | Permission timeout | Permission request cancelled (AbortSignal) |
| `-32006` | Daemon shutting down | Rejecting new work during shutdown |

### CLI UX

Bare `quicksave` changes from "start foreground agent" to "ensure daemon and attach":

- If no daemon exists, start one and wait until it is ready.
- Print current pairing info and QR code unless `--no-qr` is set.
- Stream daemon events until the user presses `Ctrl+C`.
- `Ctrl+C` detaches the local client but leaves the daemon running.

New subcommands:

- `quicksave service start`
- `quicksave service stop`
- `quicksave service status`
- `quicksave service info`

There is no dedicated `quicksave service attach` command in the first cut. The attach behavior lives behind bare `quicksave`.

Later, after the daemon API is stable, we may add:

- `quicksave service install`
- `quicksave service uninstall`

Repository configuration becomes daemon-owned state:

- Add `managedRepos` to persisted config.
- `quicksave --repo <path>` becomes a convenience wrapper that upserts repos in config before attach.
- Daemon validates managed repos at boot and on config mutation.

### Signaling Connection Ownership

`AgentConnection` remains the one owner of the PWA signaling session, but it moves behind the daemon boundary.

Rules:

- There is exactly one live signaling connection per daemon.
- Reconnects happen inside the daemon with exponential backoff.
- Attach clients observe connection state through IPC events rather than touching signaling directly.
- PWA traffic still terminates at the daemon and uses the existing encrypted peer-session model.

This keeps remote behavior stable while making local lifecycle predictable.

### Session Supervision `[DEFERRED]`

> **Not implemented as designed.** The actual implementation keeps `ClaudeCodeService` as the session manager running in the daemon process. Sessions are SDK V2 child processes (stdin/stdout pipes), not IPC-connected workers. There is no `SessionSupervisor` class. Session lifecycle (start, resume, cancel, close) is handled directly by `ClaudeCodeService` methods. Stream events are forwarded to the PWA via WebSocket relay.
>
> **Crash recovery** is handled by detecting the last message in the SDK JSONL: if it's a `tool_use` with no following `tool_result`, the session is marked as pending. The PWA can resume via `unstable_v2_resumeSession`, which re-spawns the CLI process and restores context from JSONL (including compaction summaries).

Claude sessions move from `ClaudeCodeService` running in-process to a daemon-owned `SessionSupervisor`.

Supervisor responsibilities:

- Allocate a daemon session record before spawn.
- Spawn a session worker with a dedicated IPC channel.
- Track `pid`, `repoPath`, `flavor`, `startedBy`, `createdAt`, and upstream provider session ID once known.
- Fan out worker stream events to PWA peers and local attach clients.
- Handle graceful cancellation and hard termination.
- Persist resumable session metadata.

Session states:

- `starting`
- `running`
- `cancelling`
- `completed`
- `failed`
- `interrupted`
- `expired` (upstream provider session no longer resumable)

The supervisor is provider-agnostic. The first implementation supports `flavor: "claude"`, but the same interface should support future `codex` or `gemini` workers.

### Authentication & Runtime Backends

The session worker supports two Claude runtime backends. The choice is a deployment-time configuration, not a code fork — both backends produce the same normalized stream events to the supervisor.

#### Backend A: Agent SDK (`@anthropic-ai/claude-agent-sdk`)

This is the current implementation. The worker calls `query()` in-process and consumes the `AsyncGenerator` directly.

- **Auth:** Requires an Anthropic API key (`ANTHROPIC_API_KEY` / `sk-ant-api03-`). Pay-per-token billing via console.anthropic.com.
- **Pros:** Direct programmatic control, typed message objects, in-process `AbortController` cancellation, access to `listSessions()` / `getSessionMessages()`.
- **Cons:** Cannot use a Claude Pro/Max subscription. API key cost is usage-based.

#### Backend B: Claude Code CLI wrapper

The worker spawns `claude -p` as a child process with `--output-format stream-json --verbose --include-partial-messages` and parses the newline-delimited JSON event stream from stdout.

- **Auth:** Uses the user's existing Claude Code OAuth login (`sk-ant-oat01-`). This is permitted because the CLI itself is Claude Code — we are wrapping it, not reimplementing it. Zero marginal cost within the subscription quota.
- **Pros:** Free under Pro/Max subscription, no API key needed, inherits Claude Code's built-in tools and permissions, session persistence managed by the CLI.
- **Cons:** Indirect control (must parse stdout JSON), cancellation via `SIGTERM` to child process, CLI version updates may change event format, `--bare` mode skips CLAUDE.md and hooks (which may or may not be desired).

**Note on SDK local functions:** The Agent SDK's `listSessions()` and `getSessionMessages()` are purely local disk reads — they do not make any API calls to Anthropic. The CLI backend can (and should) still use these SDK functions for session listing and message retrieval, regardless of the OAuth policy. Only `query()` hits the cloud API, and that is the single call path the CLI backend replaces.

#### CLI Event Format

The CLI with `--output-format stream-json --verbose --include-partial-messages` emits newline-delimited JSON. Each line has a `type` field:

| Event type | When | Key fields |
|---|---|---|
| `system` (subtype `init`) | Once at start | `session_id` |
| `system` (subtype `api_retry`) | On retryable API error | `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` |
| `stream_event` | Per token/block | `event` (raw Claude API streaming event: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) |
| `assistant` | Per completed turn | `message.content[]` (text, tool_use blocks), `message.stop_reason`, `message.usage` |
| `result` | Once at end | `result` (final text), `session_id`, `cost_usd`, `usage`, `structured_output` |

The `stream_event` contains nested Claude API events. Relevant delta types:

- `text_delta` → `event.delta.text` (streaming text)
- `input_json_delta` → `event.delta.partial_json` (streaming tool input)
- `content_block_start` with `content_block.type == "tool_use"` → tool call beginning

#### CLI Flags Reference (for worker spawn)

| Flag | Purpose |
|---|---|
| `-p <prompt>` | Non-interactive print mode |
| `--output-format stream-json` | Newline-delimited JSON output |
| `--verbose` | Include full turn-by-turn output |
| `--include-partial-messages` | Emit `stream_event` for per-token streaming |
| `--resume <session_id>` | Resume an existing session |
| `--model <alias>` | Model selection (e.g. `sonnet`, `opus`) |
| `--allowed-tools "Read,Edit,..."` | Restrict available tools |
| `--system-prompt <text>` | Replace system prompt |
| `--append-system-prompt <text>` | Append to default system prompt |
| `--max-budget-usd <n>` | Cost cap per invocation |
| `--max-turns <n>` | Turn limit |
| `--permission-mode dontAsk` | No interactive permission prompts |
| `--bare` | Skip hooks, plugins, MCP, CLAUDE.md for faster startup |
| `--no-session-persistence` | Don't persist session to disk |

#### Backend Selection

The active backend is a daemon-level config in `agent.json`:

```json
{
  "claudeBackend": "sdk" | "cli",
  "claudeModel": "opus"
}
```

Default is `"sdk"` for backward compatibility. Users who want to use their Claude subscription set `"claudeBackend": "cli"`.

The supervisor passes the backend choice to each worker at spawn time. Both backends normalize their output to the same `WorkerEvent` union before sending to the supervisor, so the rest of the daemon (supervisor, IPC fanout, PWA relay) is backend-agnostic.

### Claude Worker Process Model `[DEFERRED]`

> **Not implemented.** The SDK V2 API (`unstable_v2_createSession`) spawns Claude Code CLI as a **direct child process** of the daemon, communicating via stdin/stdout pipes. These are **not** detached — daemon exit kills all session processes. This matches the VS Code extension's behavior and is the standard SDK pattern.
>
> **Actual process hierarchy:**
> ```
> Daemon (quicksave agent)
>   ├─ WebSocket relay connection
>   ├─ Claude session A (child process, stdin/stdout pipe)
>   │    └─ SDK JSONL: ~/.claude/projects/{hash}/{session-id}.jsonl
>   └─ Claude session B (child process, stdin/stdout pipe)
>        └─ SDK JSONL: ~/.claude/projects/{hash}/{session-id}.jsonl
> ```
>
> **Recovery:** On daemon restart, `listSessions()` discovers all sessions from SDK JSONL. Active sessions are cold-resumed via `unstable_v2_resumeSession` on demand (when the user opens a session in the PWA). Pending tool calls are detected from JSONL tail.

Each Claude session runs in a **detached, long-lived session process** that survives daemon restarts. This is the key architectural departure from the initial `child_process.fork()` design.

#### Why detached session processes

The daemon (parent) is the component most likely to be updated — new features, bug fixes, protocol changes. If sessions are child processes tied to the daemon's lifetime, every daemon update kills all active sessions.

Happy Coder has this exact problem: sessions are spawned `detached: true` so they survive `happy daemon stop`, but after daemon restart the new daemon has **no knowledge** of surviving sessions. The `pidToTrackedSession` map starts empty and `listDaemonSessions()` warns: "No active sessions this daemon is aware of."

Quicksave solves this by making session processes:

1. **Detached (`nohup`-style)** — session processes do not die when the daemon exits.
2. **Self-describing** — each session process writes its own state file to a known location.
3. **Re-connectable** — sessions connect to the daemon via the same IPC socket that CLI clients use, so a new daemon can discover and manage pre-existing sessions.

This means the session worker code should be **stable and minimal** — it owns the Claude SDK/CLI integration and streams events, but the daemon handles all business logic (permission UI, message routing, PWA relay). The session worker is a "dumb pipe" that rarely needs updating.

#### Process hierarchy

```
Daemon (quicksave service run)
  ├─ IPC socket: ~/.quicksave/run/service.sock
  │
  ├─ Session Worker A (detached, nohup)
  │    ├─ Connects to daemon IPC socket as a client
  │    ├─ Runs SDK query() or CLI subprocess
  │    └─ Session dir: ~/.quicksave/state/sessions/<id>/
  │         ├─ state.json, events.jsonl, config.json
  │
  └─ Session Worker B (detached, nohup)
       ├─ Connects to daemon IPC socket as a client
       ├─ Runs SDK query() or CLI subprocess
       └─ Session dir: ~/.quicksave/state/sessions/<id>/
            ├─ state.json, events.jsonl, config.json
```

Session workers are **IPC clients** of the daemon, just like CLI attach processes. The daemon does not need `child_process.fork()` IPC channels — all communication goes through the Unix socket.

#### Session state file

Each session worker maintains its own directory at `~/.quicksave/state/sessions/<session-id>/` containing `state.json`, `events.jsonl`, and `config.json`.

```json
{
  "daemonSessionId": "qs-abc123",
  "providerSessionId": "claude-xyz789",
  "workerPid": 12345,
  "socketPath": "~/.quicksave/run/service.sock",
  "backend": "sdk",
  "repoPath": "/Users/jimmy/workspace/quicksave",
  "flavor": "claude",
  "status": "running",
  "startedAt": "2026-04-05T10:00:00Z",
  "lastHeartbeatAt": "2026-04-05T10:05:00Z"
}
```

The `state.json` file is:
- **Written by the session worker** (not the daemon) on startup and updated on heartbeat.
- **Read by the daemon** on startup to discover surviving sessions.
- **Cleaned up by the worker** on graceful exit (entire session directory is removed).
- **Cleaned up by the daemon** when the worker PID is no longer alive (stale detection — `state.json` removed, but `events.jsonl` preserved).

#### Session worker startup flow

1. Daemon creates `daemonSessionId`, creates the session directory `~/.quicksave/state/sessions/<id>/`, and writes `config.json` with spawn parameters (prompt, model, backend, repoPath, permissionMode, etc.).
2. Daemon spawns the worker as a **detached process**: `child_process.spawn("node", ["sessionWorker.js", "--session-dir", sessionDir], { detached: true, stdio: "ignore" })`. Config is passed via file (not argv) to avoid OS argument length limits with large prompts/system prompts.
3. Daemon calls `child.unref()` so the daemon can exit without waiting for the worker.
4. Worker reads `config.json` and writes `state.json` with `status: "starting"`.
5. Worker connects to the daemon IPC socket and registers itself: `{ method: "worker.register", params: { sessionId, pid } }`.
6. Worker initializes the selected backend:
   - **SDK backend:** calls `query()` with a `PushableAsyncIterable` prompt and consumes the `AsyncGenerator`.
   - **CLI backend:** spawns `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages` and parses stdout lines.
7. Once Claude returns a real upstream `session_id`, worker sends `worker.started` to the daemon.
8. Worker normalizes backend-specific events into `WorkerEvent` and sends them to the daemon over IPC.
9. On completion or error, worker sends a final event, cleans up its session directory, and exits.

#### Daemon restart and session re-registration

When the daemon starts (or restarts after an update):

1. Daemon scans `~/.quicksave/state/sessions/*/state.json` for existing session directories.
2. For each session, daemon reads `events.jsonl` from the same directory to pre-populate its in-memory ring buffer. This makes session history available to PWA clients immediately, before workers reconnect.
3. For each file, daemon checks `workerPid` — is the process alive? (`kill(pid, 0)`).
4. If alive: daemon waits for the worker to reconnect via IPC (the worker detects daemon restart when its existing IPC connection drops, and reconnects to the new socket). On reconnect, `worker.sync` only covers the small tail of events generated after the JSONL's last line.
5. If dead: daemon marks the session `interrupted`. The event JSONL is preserved (the daemon already loaded it in step 2). The stale `state.json` is cleaned up (but the session directory and `events.jsonl` are kept for inspection).

Worker reconnection logic:

- The worker keeps a persistent IPC connection to the daemon.
- If the connection drops (daemon restarted), the worker enters a **reconnect loop**: retry connecting to `~/.quicksave/run/service.sock` with exponential backoff (500ms → 1s → 2s → 4s, max 30s).
- On reconnect, the worker sends `worker.register` again. The new daemon picks up the session.
- If reconnection fails for more than 5 minutes, the worker logs a warning but keeps running — it continues processing the Claude session and buffering events. When a daemon eventually appears, buffered events are replayed.

This means:
- `quicksave service restart` can be instantaneous — no drain needed for active sessions.
- `npm update -g quicksave` + daemon restart does not interrupt Claude work.
- Sessions are truly independent of daemon lifecycle.

#### Event buffering and sync

Three layers of event storage ensure no data is lost regardless of which process crashes:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: SDK JSONL (disk)                                   │
│   ~/.claude/projects/.../sessions/<provider-id>.jsonl       │
│   Written by: Claude SDK/CLI directly                       │
│   Format: raw SDK messages (API-level)                      │
│   Lifetime: permanent, used for resume and full transcript  │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: Worker event JSONL (disk)                          │
│   ~/.quicksave/state/sessions/<session-id>/events.jsonl     │
│   Written by: session worker (append-only)                  │
│   Format: normalized WorkerStreamEvent with seq             │
│   Lifetime: session duration, cleaned up on graceful exit   │
├─────────────────────────────────────────────────────────────┤
│ Layer 1: In-memory ring buffers (RAM)                       │
│   Worker: hot tail for IPC sync (last N unconfirmed)        │
│   Daemon: hot cache for PWA catch-up (last 1000)            │
│   Lifetime: process lifetime                                │
└─────────────────────────────────────────────────────────────┘
```

**Layer 2: Worker event JSONL** (the new durable event log):

The worker appends every `WorkerStreamEvent` to a JSONL file as it generates them:

```
~/.quicksave/state/sessions/<session-id>/events.jsonl
```

Each line:
```jsonl
{"seq":1,"timestamp":"2026-04-05T10:00:00.000Z","event":{"type":"turn_start"}}
{"seq":2,"timestamp":"2026-04-05T10:00:00.100Z","event":{"type":"text_delta","text":"I'll fix"}}
{"seq":3,"timestamp":"2026-04-05T10:00:00.200Z","event":{"type":"tool_use_start","toolUseId":"tu_1","toolName":"Edit"}}
```

Write strategy:
- Append-only, one `fs.appendFile()` per event. No fsync on every write — the OS page cache provides sufficient durability for our use case (events are recoverable from the SDK JSONL as a last resort).
- File is created by the worker on session start, inside the session directory.
- Cleaned up by the worker on graceful exit (session completed normally).
- **Not cleaned up** on crash — the daemon reads it for recovery.

This file is the **sync source of truth**. It replaces the in-memory-only worker ring buffer as the primary replay mechanism.

**Layer 1: In-memory ring buffers** (hot caches):

- **Worker in-memory buffer**: Small tail buffer of events not yet confirmed by daemon. Used for fast `worker.sync` of the last few events that may not have been flushed to JSONL yet. Bounded at **200 events** (just the unconfirmed tail, not the full history).
- **Daemon in-memory buffer**: Ring buffer of **1000 events** per session. Populated from `worker.stream` notifications. Serves `get-session-history` requests for fast PWA catch-up without disk I/O.

**Daemon restart — sync from JSONL:**

When the daemon restarts, it no longer needs to wait for the worker to reconnect and replay via IPC. Instead:

```
Daemon (new)                         Worker (still running)
  │                                    │
  │  1. Scan session state files       │
  │  2. Read <id>.events.jsonl         │
  │     → populate ring buffer         │
  │     → knows lastConfirmedSeq       │
  │                                    │
  │←── hello { role: "worker" } ──────│  worker reconnects
  │──→ HelloResult ───────────────────│
  │                                    │
  │←── worker.register {               │
  │      lastSeq: 42,                  │
  │      pendingPermission: {...}      │
  │    } ─────────────────────────────│
  │                                    │
  │──→ { lastConfirmedSeq: 40 } ─────│  ← daemon already has seq 1-40 from JSONL
  │                                    │
  │←── worker.sync {                   │
  │      events: [seq 41, 42]          │  ← only the tail not yet on disk
  │    } ─────────────────────────────│
  │──→ { synced, lastConfirmedSeq:42 }│
  │                                    │
  │←── worker.stream { seq: 43 } ─────│  ← normal streaming resumes
```

Key improvement: the daemon pre-populates from JSONL **before** the worker reconnects. This means:
- PWA can already browse session history as soon as the daemon is up.
- `worker.sync` only needs to send the tiny tail (events between JSONL's last line and worker's current seq).
- If the worker never reconnects (also crashed), the daemon still has the full event log.

**Worker crash recovery:**

When the daemon detects a dead worker PID:

1. Read `events.jsonl` from the session directory → full event history available.
2. Populate daemon ring buffer from JSONL.
3. PWA can browse the complete session history via `get-session-history`.
4. Mark session `interrupted`. The JSONL file is preserved for inspection.
5. On resume, the new worker starts a fresh JSONL file (new session ID via fork).

This is the critical advantage over in-memory-only: **worker crash no longer means event loss**.

**Permission recovery:**

When the worker has an outstanding `worker.permissionRequest` that was lost (daemon died before responding):

The critical constraint: `canUseTool` returns a `Promise<PermissionResponse>`. If we reject it, the SDK treats it as a failure. We must **keep the Promise pending** through the entire disconnect → reconnect → re-issue cycle.

Worker-side implementation:

```typescript
async askDaemonForPermission(toolName, input, options): Promise<PermissionResponse> {
  const { signal } = options; // SDK's AbortSignal (fires on cancel)
  const params: PermissionRequestParams = {
    requestId: options.toolUseID,
    sessionId: this.sessionId,
    toolName, input, /* ...other fields */
  };

  while (true) {
    try {
      return await this.ipc.request('worker.permissionRequest', params);
    } catch (err) {
      if (signal?.aborted) throw err;  // session cancelled, let SDK handle
      if (err.code === 'IPC_DISCONNECTED') {
        this.pendingPermission = params;  // stash for worker.register
        await this.waitForReconnect(signal);  // blocks until IPC is back
        // After reconnect, worker.register already told daemon about
        // pendingPermission. Now re-issue the actual RPC to get the response.
        continue;
      }
      throw err;
    }
  }
}
```

The `while(true)` loop is the key — the Promise returned to the SDK stays pending through any number of daemon restarts. The only exits are:
- Daemon responds → return the response (allow/deny).
- SDK's `signal` fires (user cancelled) → throw, SDK handles cleanup.
- Fatal non-recoverable error → throw.

Full flow:

```
Worker                    Daemon (old)              PWA
  │                          │                       │
  │── permissionRequest ────→│                       │
  │                          │── event.permission ──→│  PWA shows prompt
  │                          │                       │
  │       ╳ daemon dies ╳    │                       │
  │                          │                       │
  │  (IPC error caught,      │                       │
  │   stash pending,         │                       │
  │   enter reconnect loop)  │                       │
  │                          │                       │
  │                    Daemon (new)                   │
  │                          │                       │
  │── worker.register ──────→│  (includes pendingPermission)
  │← { lastConfirmedSeq } ──│                       │
  │── worker.sync ──────────→│                       │
  │                          │── event.permission ──→│  PWA sees same requestId
  │── permissionRequest ────→│                       │  (dedup: same prompt)
  │                          │     (waiting...)      │
  │                          │                       │
  │                          │←── respond-permission │  user taps approve
  │← { behavior: "allow" } ─│                       │
  │                          │                       │
  │  (Promise resolves,      │                       │
  │   SDK continues)         │                       │
```

PWA deduplication: the daemon re-sends `event.permissionRequest` with the **same `requestId`** (SDK's `toolUseID`). The PWA should treat a permission request with an already-known `requestId` as an update/refresh rather than a new prompt. If the user already had the permission card open, nothing changes visually.

**JSONL vs SDK JSONL — why both:**

| | Worker event JSONL | SDK JSONL |
|---|---|---|
| Written by | Session worker | Claude SDK/CLI |
| Format | Normalized `WorkerStreamEvent` | Raw API messages |
| Purpose | Daemon sync, PWA catch-up | Session resume, full transcript |
| Granularity | Per-token deltas, tool events | Per-turn messages |
| Readable by | Daemon (our code) | SDK `getSessionMessages()` |
| Lifetime | Session duration | Permanent |

The SDK JSONL is the canonical transcript for Claude. Our event JSONL is the operational log for the daemon-worker sync protocol. They serve different consumers and have different granularity (streaming deltas vs completed turns).

#### Multi-turn communication

For SDK backend, multi-turn follows Happy's `PushableAsyncIterable` pattern:

- A single `query()` call with an `AsyncIterable<SDKUserMessage>` prompt.
- The worker holds the iterable open between turns.
- When the daemon (on behalf of the PWA) sends a new user message over IPC, the worker pushes it into the iterable.
- The SDK sees the new value and starts the next turn without a new `query()` call.
- When settings change (model, permission mode), the worker tears down the current `query()` and starts a new one with `resume` — same pattern as Happy's `claudeRemoteLauncher` mode-hash check.

For CLI backend, multi-turn is per-turn new process (the documented approach).

#### Permission handling

The session worker uses the SDK's `canUseTool` callback (official API, not Happy's custom reimplementation):

```typescript
canUseTool: async (toolName, input, options) => {
  // options includes: signal, suggestions, blockedPath, decisionReason, toolUseID, agentID
  return askDaemonForPermission(toolName, input, options);
}
```

The worker sends a `worker.permissionRequest` IPC message to the daemon. The daemon:

1. Evaluates the request against the active permission policy (see Permission Modes below).
2. If auto-approvable, returns immediately.
3. If user approval needed, forwards to the PWA and waits for the response.
4. Returns `{ behavior: "allow" | "deny", ... }` to the worker.

Unlike Happy's implementation, Quicksave preserves the full `suggestions`, `blockedPath`, `decisionReason`, and `description` metadata from the SDK. This allows the PWA to render rich permission prompts with context.

#### IPC message flow summary

See the **IPC Protocol Specification** (Local IPC section) for full message shapes. In summary:

- **Daemon → Worker** (requests): `worker.sendMessage`, `worker.cancel`, `worker.shutdown`, `worker.setPermissionMode`, `worker.setModel`
- **Worker → Daemon** (requests): `worker.register`, `worker.sync`, `worker.permissionRequest`, `worker.heartbeat`
- **Worker → Daemon** (notifications): `worker.started`, `worker.ready`, `worker.stream`, `worker.result`, `worker.error`

#### Cancellation policy

For **SDK backend**, the worker calls `AbortController.abort()` on the query. The SDK handles cleanup internally.

For **CLI backend**, the worker sends `SIGTERM` to the spawned `claude` child process.

If the worker itself needs to be killed (unresponsive):

1. Daemon sends `worker.cancel` over IPC.
2. Wait 5s for graceful exit.
3. Send `SIGTERM` to worker PID.
4. Wait 2s.
5. Send `SIGKILL` if still alive.

We do not auto-restart a failed interactive Claude worker. The supervisor marks the session `failed` or `interrupted`, persists metadata, and exposes explicit resume controls.

### Permission Modes

The daemon supports multiple permission modes that control how `canUseTool` requests are handled. Modes are set per-session and can be changed mid-session.

#### Mode 1: Interactive (default)

Every tool call requires explicit user approval from the PWA. This is the safest mode and matches the default Claude Code CLI experience.

Flow: worker → `worker.permissionRequest` → daemon → PWA → user approval → daemon → worker → `{ behavior: "allow" }`.

The PWA renders the full permission prompt with `toolName`, `input`, `description`, `blockedPath`, and `suggestions` from the SDK.

#### Mode 2: Sandboxed Auto-Approve

The agent runs in a restricted sandbox where tool calls are auto-approved because the sandbox enforces safety boundaries.

Sandbox constraints:
- **No network access** — the sandbox blocks all outbound connections.
- **Write access limited to `cwd` (excluding `.git/`)** — prevents modifying git history, other repos, or system files.
- **Read access to `cwd`** — unrestricted within the project.
- **No access to secrets** — env vars are scrubbed of credentials, API keys, etc.

The `canUseTool` callback auto-approves without asking the user:

```typescript
canUseTool: async (toolName, input, options) => {
  // Sandbox enforces safety, no user prompt needed
  return { behavior: "allow", updatedInput: input };
}
```

Implementation: the session worker wraps tool execution in a macOS `sandbox-exec` profile (or equivalent) that enforces the network and filesystem constraints. The sandbox is applied at the **process level** — the entire Claude CLI subprocess or SDK process runs inside it.

Sandbox profile sketch (macOS):
```scheme
(deny default)
(allow file-read* (subpath "<cwd>"))
(allow file-write* (subpath "<cwd>"))
(deny file-write* (subpath "<cwd>/.git"))
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/System"))
(allow process-exec)
(deny network*)
```

When to use: background tasks, automated refactoring, test runs — anything where the user trusts the agent to work within the project but doesn't want to approve every file edit.

#### Mode 3: Read-Only Networked Sub-Agent

A restricted sub-agent mode with read-only filesystem access but network access. This is for research tasks: fetching docs, searching the web, reading code without modifying it.

Constraints:
- **Network access allowed** — can fetch URLs, call APIs.
- **Read-only filesystem** — no `Edit`, `Write`, or destructive `Bash` commands.
- **Read scope defined at spawn time** — e.g., only `/Users/jimmy/workspace/quicksave/` and `/Users/jimmy/.claude/`.

Implementation: uses `allowedTools` to restrict tools to `['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']` and a `canUseTool` callback that denies anything outside the allowed read paths:

```typescript
allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
canUseTool: async (toolName, input, options) => {
  if (toolName === 'Bash') {
    // Only allow read-only commands (ls, cat, git log, etc.)
    // Deny anything with side effects
    return validateReadOnlyBash(input.command);
  }
  if (['Read', 'Glob', 'Grep'].includes(toolName)) {
    return isWithinAllowedPaths(input, allowedReadPaths)
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Path outside allowed scope' };
  }
  return { behavior: 'allow' }; // WebFetch, WebSearch
}
```

This mode could also use a sandbox, but with network allowed and filesystem mounted read-only.

#### Mode switching

The PWA can change the permission mode mid-session by sending a command through the daemon:
- Daemon sends `worker.setPermissionMode` to the worker.
- For SDK backend: the worker calls `query.setPermissionMode()` if the SDK supports it, or tears down and re-creates the query with the new mode.
- For CLI backend: not supported mid-session (requires re-spawn).

### Session Resume

Quicksave may resume sessions originally created in VS Code, Happy Coder, or the Claude Code CLI. Since the Claude Agent SDK provides no API to detect whether another process is actively using a session (no lock files, no `active` field, no process tracking), **quicksave always forks on resume** using `forkSession: true` (SDK) or `--fork-session` (CLI).

Decision rationale:

- The SDK's `listSessions()` returns only static metadata (`sessionId`, `summary`, `lastModified`). There is no `active`, `running`, or `pid` field.
- Session JSONL files have no file-level locks; two processes writing to the same session corrupt the transcript with interleaved entries.
- IDE lock files (`~/.claude/ide/*.lock`) track IDE instances, not individual sessions.
- Anthropic provides `forkSession` as the official concurrency solution — there is no documented way to detect an active session.
- We do not implement heuristic-based detection (e.g. checking `lastModified` recency or scanning process tables) because these depend on undocumented internals that may change across Claude Code releases.

Always-fork behavior:

- The forked session receives a **new session ID** with the full conversation history copied from the original.
- The original session in VS Code / Happy Coder is unaffected.
- From the user's perspective, the conversation continues seamlessly — context is preserved.
- The daemon tracks the fork relationship: `forkedFrom` in session metadata links back to the original session ID for auditability.

Stored fields for resume:

- `daemonSessionId`
- `providerSessionId`
- `forkedFrom` (original session ID, if this session was forked)
- `repoPath`
- `flavor`
- `lastActivityAt`
- `status`

Resume flow:

1. User or PWA requests resume for a known session.
2. Daemon validates the session is resumable (`interrupted` or `failed`, not `expired`).
3. Supervisor spawns a fresh worker with the stored provider session ID **and `forkSession: true`**.
4. Worker starts a forked session via the upstream provider.
5. If the provider returns session-not-found or equivalent, worker reports error and supervisor marks the session `expired`.
6. On success, the new forked session ID becomes the active `providerSessionId`; `forkedFrom` records the original.

For sessions originally owned by the daemon itself (not external), the daemon already knows whether the session is active (the supervisor tracks live workers). In this case, the daemon can skip forking and resume directly if the session is idle. Forking is only mandatory for external sessions where ownership cannot be determined.

If the daemon finds any `starting` or `running` session records during boot, it marks them `interrupted`. Users may later resume them (via fork) if upstream provider semantics allow it.

### History and Pending Permissions Interface

The PWA needs two capabilities: browsing session history (past messages) and managing pending permission requests (approve/deny tool calls in real-time).

#### Pending permission requests

The daemon maintains an in-memory map of pending permission requests:

```typescript
interface PendingPermissionRequest {
  requestId: string;         // SDK's toolUseID
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;      // SDK's description field
  blockedPath?: string;      // SDK's blockedPath field
  decisionReason?: string;   // SDK's decisionReason field
  suggestions?: PermissionUpdate[];
  createdAt: number;
}
```

IPC methods:

- `list-pending-permissions` → returns all pending requests across all sessions.
- `respond-permission { requestId, approved, reason?, allowTools?, mode? }` → resolves the request.

PWA protocol: the daemon pushes permission requests as `event.permissionRequest` notifications over the existing WebSocket channel. The PWA renders them as interactive cards (similar to Happy's approach). When the user taps approve/deny, the PWA sends the response back.

The daemon also tracks completed requests:

```typescript
interface CompletedPermissionRequest extends PendingPermissionRequest {
  completedAt: number;
  status: "approved" | "denied" | "canceled";
  mode?: string;
  allowTools?: string[];
}
```

Completed requests are kept in memory for the session duration (for the PWA to show history of approvals). They are not persisted to disk.

#### Session history

Two approaches, depending on whether the PWA has been connected since the session started:

**Live history (PWA connected):**

The daemon streams `event.sessionStream` events to the PWA in real-time. The PWA accumulates these in its local Zustand store. No separate history fetch needed.

**Catch-up history (PWA connects mid-session or reconnects):**

The PWA needs to fetch messages it missed. Two options:

1. **SDK session reader:** Use `getSessionMessages(sessionId)` from the Agent SDK (local disk read, no API call). This returns the full JSONL transcript. The daemon exposes this as an IPC method `get-session-messages { sessionId }`, and the PWA fetches on connect.

2. **Daemon event buffer:** The daemon maintains a bounded ring buffer of recent `WorkerEvent` messages per session (default: last 1000 events). When the PWA connects or reconnects, it requests `get-session-history { sessionId, since?: timestamp }` and receives the buffered events.

Recommended approach: **combine both**. Use the SDK session reader for full historical transcripts (loading past sessions from the session list). Use the daemon event buffer for fast catch-up on the current active session (avoids parsing the full JSONL on every reconnect).

IPC methods:

- `get-session-messages { sessionId }` → full transcript from SDK (JSONL parse).
- `get-session-history { sessionId, since? }` → recent events from daemon buffer.
- `list-sessions` → all known sessions with metadata (delegates to SDK `listSessions()`).

#### Message ordering

Following Happy's pattern, the daemon uses an ordered message queue for delivering events to the PWA:

- Each message gets a monotonically increasing sequence number.
- `assistant` messages containing `tool_use` blocks are delayed briefly (250ms) to allow tool results to arrive first — this prevents the PWA from showing a tool call with no result yet.
- When a `tool_result` arrives for a delayed tool call, the delay is released immediately.
- Messages are delivered in strict sequence order.
- On session abort, all in-flight tool calls get synthetic `tool_result` messages with `is_error: true` so the PWA never has dangling tool calls.

### Persistence

Durable config remains in `agent.json`. Additions:

- `managedRepos: string[]`
- optional service preferences such as `autoStartMode`

Durable service state lives separately from config:

- `service.json` stores current daemon identity and health
- `sessions/<id>/state.json` stores per-session metadata

Runtime-only artifacts:

- `service.lock`
- socket or pipe endpoint

Logs:

- Daemon writes to `logs/service.log`
- Attach clients subscribe to the in-memory event stream for live output

This keeps long-lived identity/config separate from crash-prone runtime state.

### Auto-Start

Default behavior is on-demand auto-start:

- Any CLI command that needs the agent first calls `ensureDaemon()`.
- If the daemon is absent or stale, CLI spawns `quicksave service run` in detached mode and waits for IPC readiness.

Optional login auto-start is a separate feature:

- `quicksave service install` registers the daemon as a per-user login service.
- macOS uses `launchd`.
- Linux uses a user `systemd` unit.
- Windows uses a per-user login entry or scheduled task.

Decision:

- On-demand auto-start is required in the first cut.
- OS-level install is optional and can land after the daemon API stabilizes.
- `install` / `uninstall` are not part of the initial daemon delivery milestone.

### Version Management

The daemon is long-lived but the CLI binary updates independently. Version mismatch must be detected and handled.

#### Version Fields

`service.json` and `ping` response carry three version fields:

- `version`: semver string (e.g. `"0.3.0"`), human-readable, matches the package version.
- `ipcVersion`: integer (e.g. `1`), bumped only on IPC protocol breaking changes. This is the machine-readable compatibility check — equal means compatible, not-equal means incompatible.
- `buildId`: short content hash of the build output (e.g. `"a3f8c2"`). Generated at build time by the bundler (vite/esbuild plugin). Changes on every rebuild. Used **only in dev mode** to detect stale daemons running old code.

Using an integer rather than semver for `ipcVersion` is intentional. IPC is an internal protocol; the only question is "can these two talk?" — a single integer equality check is sufficient.

`buildId` solves a development ergonomics problem: during development, a file watcher rebuilds the CLI/daemon bundle frequently. The daemon process continues running the old bundle. Without `buildId`, the developer must manually restart the daemon after every code change. With `buildId`, `ensureDaemon()` detects the mismatch and auto-restarts.

In production, `buildId` differences are ignored — only `ipcVersion` matters. This prevents unnecessary restarts when the user has a slightly different CLI version that is still IPC-compatible.

#### Mismatch Detection

`ensureDaemon()` performs a version check after connecting:

1. Connect and send `hello` (doubles as liveness check — if daemon is dead, connect fails).
2. Inspect `HelloResult`: compare `daemonIpcVersion` against `cli.expectedIpcVersion`.
3. If **ipcVersion mismatch** (`daemon.ipcVersion !== cli.expectedIpcVersion`):
   - If daemon is older: auto-restart the daemon, regardless of active sessions. Session workers are detached and will reconnect to the new daemon automatically (see Graceful Restart). The brief IPC disconnection (typically < 2s) is transparent to the user.
   - If CLI is older: warn the user: "CLI is outdated. Please update quicksave." Do not attempt to restart.
4. If **ipcVersion matches but buildId differs**:
   - In dev mode (`NODE_ENV=development`): auto-restart the daemon. This ensures the developer always runs the latest code without manual restarts.
   - In production: proceed normally. `buildId` mismatch is ignored.
5. If both match: proceed normally.

```typescript
function shouldRestartDaemon(daemon: HelloResult, cli: { ipcVersion: number; buildId: string }):
  "restart" | "warn_outdated" | "ok" {
  if (daemon.ipcVersion !== cli.ipcVersion) {
    return daemon.ipcVersion < cli.ipcVersion ? "restart" : "warn_outdated";
  }
  if (isDev() && daemon.buildId !== cli.buildId) {
    return "restart";
  }
  return "ok";
}
```

#### Graceful Restart

Because session workers are detached and self-describing, daemon restart is lightweight:

1. Send `restart` to daemon.
2. Daemon closes IPC server, cleans up state, exits.
3. CLI auto-starts a new daemon via `ensureDaemon()`.
4. Workers detect dropped IPC connection and enter reconnect loop.
5. New daemon scans session state files and waits for workers to reconnect.

**No drain needed.** Active sessions keep running — they just briefly lose their IPC connection and reconnect to the new daemon. This means `quicksave service restart` is fast and non-disruptive.

The only case where sessions might be interrupted is if the session worker code itself changes in a backward-incompatible way. In that case, a manual `quicksave service restart --kill-sessions` flag can be used to terminate surviving workers and let users resume later.

### Security

- Local IPC is only available to the current OS user.
- Unix socket permissions must be `0600`.
- Secret key material remains in `agent.json`; attach clients never read raw runtime secrets from the daemon.
- Child workers receive only the minimal config they need.
- Existing end-to-end encryption between PWA and agent remains unchanged.

### Migration from Current Code

Refactor direction:

- `src/index.ts`
  Keep Commander CLI, but turn the default action into `ensureDaemon() + attach`.
- `AgentConnection`
  Move under daemon runtime with minimal behavior change.
- `MessageHandler`
  Continue handling PWA protocol messages, but call daemon-owned services instead of owning foreground lifecycle.
- `ClaudeCodeService`
  Split into a provider-specific worker runtime plus a small supervisor-facing adapter.

New modules:

- `src/service/run.ts`
- `src/service/singleton.ts`
- `src/service/ipcServer.ts`
- `src/service/ipcClient.ts`
- `src/service/stateStore.ts`
- `src/service/sessionSupervisor.ts`
- `src/service/sessionWorker.ts`

## Rollout

1. Introduce singleton lock, IPC, and `quicksave service run`.
2. Change bare `quicksave` to ensure and attach instead of owning the runtime.
3. Persist `managedRepos` and move repo registration behind daemon config.
4. Move Claude session ownership behind `SessionSupervisor`.
5. Implement detached session worker with SDK backend and IPC reconnection.
6. Add permission handling: interactive mode first, then sandboxed auto-approve.
7. Add session history and pending permission request interface (IPC + PWA).
8. Add CLI backend as an alternative runtime for subscription OAuth users.
9. Add read-only networked sub-agent mode.
10. Optionally add `service install` / `service uninstall` for OS login autostart.

This ordering gets the daemon and detached workers running first (steps 1-5), then layers on permission modes and history (steps 6-7) which require PWA changes, then adds the CLI backend (step 8) as an alternative runtime.

## What Doesn't Change

- Relay server behavior stays the same.
- PWA request and response shapes stay the same in the first cut.
- Existing machine identity and key rotation stay in `agent.json`.
- Existing multi-peer encryption model in `AgentConnection` stays intact.
- Existing per-repo locking in `MessageHandler` still applies to mutating git operations.

## Files Changed

| File | Change |
|------|--------|
| `apps/agent/src/index.ts` | Default command becomes ensure-and-attach client, add `service` subcommands |
| `apps/agent/src/config.ts` | Persist `managedRepos` and optional service preferences |
| `apps/agent/src/connection/connection.ts` | No protocol rewrite; move ownership under daemon runtime |
| `apps/agent/src/handlers/messageHandler.ts` | Stop owning foreground Claude lifecycle directly; call daemon services |
| `apps/agent/src/ai/claudeCodeService.ts` | Extract provider runtime pieces into worker-facing implementation |
| `apps/agent/src/service/backends/sdkBackend.ts` | Worker backend using `@anthropic-ai/claude-agent-sdk` `query()` (current approach) |
| `apps/agent/src/service/backends/cliBackend.ts` | Worker backend spawning `claude -p --output-format stream-json` (subscription OAuth) |
| `apps/agent/src/service/run.ts` | New daemon entrypoint |
| `apps/agent/src/service/singleton.ts` | Lock file and stale-runtime recovery |
| `apps/agent/src/service/ipcServer.ts` | Local control API and event fanout |
| `apps/agent/src/service/ipcClient.ts` | CLI attach and control client |
| `apps/agent/src/service/stateStore.ts` | `service.json` and session metadata persistence |
| `apps/agent/src/service/sessionSupervisor.ts` | Child worker spawn, tracking, cancellation, and resume |
| `apps/agent/src/service/sessionWorker.ts` | Claude session detached worker runtime (stable, minimal) |
| `apps/agent/src/service/permissionPolicy.ts` | Permission mode evaluation (interactive, sandboxed, read-only) |
| `apps/agent/src/service/messageQueue.ts` | Ordered message delivery with tool_use delay and abort cleanup |
| `apps/agent/src/service/sandbox.ts` | macOS sandbox-exec profile generation and wrapper |

18 files changed or added, no relay changes. PWA needs permission request UI (cards for approve/deny).
