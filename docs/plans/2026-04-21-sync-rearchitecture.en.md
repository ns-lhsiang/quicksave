# 2026-04-21 Sync Re-architecture Plan

## Summary

Switch to a "single shared `masterSecret` + multi-slot pairing mailbox + QR/URL + SAS" model, and add TOFU + tombstone self-destruct on the agent side.

**Design doc**: `docs/guidelines/sync-security.en.md`

**Migration**: The only user is the developer himself, who will re-pair on his own. **No in-place migration**; the new version directly overwrites the old protocol.

**Ordering**: PWA UI/UX first (can demo standalone with MockRelay) → relay backend → agent TOFU → cleanup.

## Progress Legend

- `[ ]` not started
- `[~]` in progress
- `[x]` done

---

## Stage A — PWA (UI + client crypto, mocked network)

Goal: the PWA can demo the full pairing flow **without any real relay involvement** (two browser tabs talking via a MockRelay singleton).

### A1. Shared crypto helper extensions

- [x] `sasEncode(hmacOutput: Uint8Array, chars: number): string`, 32-symbol alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
- [x] `sasBucket(now: number, windowMs = 60_000): number`
- [x] `sasCompute(pubkey: Uint8Array, bucket: number): string`, wraps the HMAC computation (implemented with SHA-512 + domain separation)
- [x] `deriveSharedKeys(masterSecret: Uint8Array)` → `{ x25519: KeyPair, ed25519: SigningKeyPair }`, domain-separated SHA-512 seed → `nacl.box.keyPair.fromSecretKey` + `nacl.sign.keyPair.fromSeed`
- [x] **Files**: `packages/shared/src/crypto.ts`, `packages/shared/src/crypto.test.ts`
- [x] **Delegate tests**: 46 new tests produced by a subagent, all green (75 tests total in crypto.test.ts)

### A2. Pairing client lib (interface + MockRelay impl)

- [x] Define the `PairTransport` interface: `postSlot / getSlots / deleteMailbox / subscribeToMailbox`
- [x] `MockRelay` implementation (module-level singleton, BroadcastChannel cross-tab, 64-slot cap, TTL GC, BC can be disabled in tests)
- [x] `PairClient` class:
  - A side: `createInvite({ baseUrl, masterSecret, ttlMs?, sasWindowMs?, sasChars? })` → `{ pairUrl, qrData, eA_pubB64, addr, expiresAt, onCandidate, submitSAS, cancel }`
  - B side: `acceptInvite({ pairUrl? | eA_pubB64? })` → `{ sas, bucket, sasExpiresAt, eB_pubB64, onSecret, cancel }`
- [x] Slot decryption + SAS filter logic (three paths for 0/1/2+ matches; SAS tolerates ±1 bucket of clock drift)
- [x] Cancel / TTL expiry automatically clears subscriptions
- [x] Pair URL switched to HashRouter format `/#/pair?k=<base64url>` (`k=` still in fragment, never sent to the server)
- [x] **Files**: `apps/pwa/src/lib/pairClient.ts`, `apps/pwa/src/lib/pairClient.test.ts` (40 tests, all green)

### A3. Pairing UI / routing / state machine

- [x] Deep-link route `/pair` (added to all three `<Routes>`, uses HashRouter `useSearchParams` to parse `k=`)
- [x] PWA manifest `url_handlers` declaration (`localhost:5173`, `localhost`)
- [x] `PairDeviceModal.tsx` (A side): QR display (`qrcode` produces a data URL) + copyable URL + SAS input + TTL countdown + candidate count
- [x] `JoinGroupPage.tsx` (B side): route-level page, parses `k` from search params, large SAS display + 60s countdown + success/error states
- [x] Error UX: 0 match "no matching device", 2+ match "suspicious collision detected" (red abort), loading / error messages
- [x] `ScanToJoinModal.tsx` (B side camera entry): uses `html5-qrcode` to scan A's QR, on success `navigate('/pair?k=...')` hands off to JoinGroupPage
- [x] Settings section refactor: split the single button into two buttons "Invite new device" + "Link to existing device", each with its own sub-text
- [x] **Files**: `apps/pwa/src/routes/JoinGroupPage.tsx`, `apps/pwa/src/components/PairDeviceModal.tsx`, `apps/pwa/src/components/ScanToJoinModal.tsx`, `apps/pwa/src/App.tsx` (three Routes locations), `apps/pwa/src/components/SettingsPage.tsx` (two trigger buttons), `apps/pwa/vite.config.ts` (manifest url_handlers)

### A4. Stage A acceptance

- [x] Headless E2E (`pairClient.test.ts` happy path): A creates invite, B accepts, A receives candidate, submitSAS → `{ status: 'sent' }`, B onSecret receives raw masterSecret bytes
- [x] 0 match / 2+ match / case-insensitive / wrong-length SAS, cancel idempotent, ciphertext not decryptable by a third party — all auto-tested
- [x] All Stage A tests pass: `packages/shared` 97 tests, `apps/pwa` pairClient 40 tests
- [ ] **User action**: `pnpm dev:pwa`, manual UI acceptance with two tabs (A = Settings → Add new device (SAS); B = open `#/pair?k=...` URL)

---

## Stage B — Relay backend + wire up to real network

### B1. Multi-slot pair mailbox

- [x] `PairSlot` / `PairMailbox` data structures (append-only, cap 64, TTL 5 min, activity extends TTL)
- [x] Garbage collector (`startGc` uses setInterval, `.unref()` so it doesn't block Node exit)
- [x] Error types: `PairStoreFullError`, `PairStoreTooLargeError`
- [x] **Files**: `apps/relay/src/pairStore.ts`, `apps/relay/src/pairStore.test.ts` (33 tests by subagent), `apps/relay/src/pairRoutes.test.ts` (17 HTTP/SSE integration tests) — entire relay suite 92/92 green

### B2. Pair HTTP routes

- [x] `POST /pair-requests/{addr}` appends a slot (returns `{id, mailboxExpiresAt}`, 201)
- [x] `GET /pair-requests/{addr}` returns `{slots}`
- [x] `DELETE /pair-requests/{addr}` → 204
- [x] `GET /pair-requests/{addr}/subscribe` SSE (with 25s ping, teardown on close)
- [x] Per-IP sliding-window rate-limit (60s / 120 req, shared between pair + sync)
- [x] Dev: `apps/pwa/vite-plugin-relay.ts` adds inline equivalent routes supporting `vite dev`
- [x] **Files**: `apps/relay/src/index.ts`, `apps/pwa/vite-plugin-relay.ts`

### B3. Pubsub topic extensions

- [x] `pair:{addr}` topic: implemented as the SSE in B2 (`PairStore.subscribe` + `/subscribe` endpoint)
- [x] `tombstone:{hash}` topic: WS push channel (`tombstone-subscribe`/`-unsubscribe`/`-event`) + `syncRoutes` `onTombstone` callback + agent 180s catch-up GET fallback
- [x] **Files**: `apps/relay/src/tombstoneSubs.ts` (new), `apps/relay/src/syncRoutes.ts`, `apps/relay/src/index.ts`, `apps/agent/src/connection/relay.ts`, `apps/agent/src/connection/connection.ts`

### B4. Signed sync envelope + per-mailbox mutex

- [x] `SignedSyncEnvelope` schema + Ed25519 verify on PUT/DELETE `/sync/*` (shared `verifySignedRequest`, `extra=[keyHash, ciphertextHash]`; `ciphertextHash=''` on lock-release)
- [x] Per-mailbox in-flight mutex (`SyncStore.tryAcquireLock/releaseLock`, 10s TTL auto-expiry; `stats.locks` exposes diagnostics)
- [x] HTTP 409 + `Retry-After` header + client-side exponential backoff (150ms base, max 4 retries, max 5s, with jitter, and respects server-returned `retryAfterMs`)
- [x] Cancel route `DELETE /sync/{hash}/lock` (envelope action `sync-lock-release`, ciphertext forbidden)
- [x] Extract handlers into `apps/relay/src/syncRoutes.ts` (`createSyncRouter`); prod index.ts and tests share the same copy to avoid drift
- [x] `apps/pwa/vite-plugin-relay.ts` dev middleware also supports the new envelope and `/lock` (dev mode does no signature verification, only strips the envelope)
- [x] `apps/pwa/src/lib/syncClient.ts` new API: `pushToDevice / postTombstone / releaseLock` all require a `SyncSignKeyPair`; `rotateIdentity` returns the old signing keypair so a tombstone can be posted
- [x] **Tests**: 47 shared envelope unit tests + 12 SyncStore lock unit tests + 18 syncRoutes HTTP integration tests (covers bad-sig / replay / tampered / stale / future / 413 / 409)
- [x] **Flake cleanup**: while we were at it, switched `pairRoutes.test.ts` from a fixed port to `port: 0` (OS picks a free port, avoids TIME_WAIT flake)
- [x] **Files**: `apps/relay/src/syncStore.ts`, `apps/relay/src/syncRoutes.ts` (new), `apps/relay/src/index.ts`, `apps/relay/src/syncRoutes.test.ts` (new), `apps/relay/src/syncLocks.test.ts` (new), `apps/pwa/src/lib/syncClient.ts`, `apps/pwa/src/stores/identityStore.ts`, `apps/pwa/src/App.tsx`, `apps/pwa/src/components/DevicePairingSection.tsx`, `apps/pwa/vite-plugin-relay.ts`, `packages/shared/src/syncEnvelope.ts`, `packages/shared/src/syncEnvelope.test.ts` (new)

### B5. Replace MockRelay

- [x] `HttpPairTransport`: `apps/pwa/src/lib/httpPairTransport.ts` (fetch + EventSource)
- [x] `getDefaultPairTransport()`: pulls the signaling URL from connectionStore, returns an HttpPairTransport
- [x] `PairDeviceModal` / `JoinGroupPage` switched away from `getSharedMockRelay`
- [ ] E2E test: two PWAs successfully pair through a real relay
- [ ] Manual verification: desktop Chrome + phone PWA real-device pair

### B6. Stage B acceptance

- [ ] All pairing flow E2E tests pass
- [ ] Two PWAs successfully sync `masterSecret` and machine list
- [ ] 409 backoff converges correctly under artificially induced contention

---

## Stage C — Agent TOFU + tombstone self-destruct

Can run in parallel with Stage B (different app, different files).

### C1. Agent config schema

- [x] `peerPWAPublicKey: string | null`, `peerPWASignPublicKey: string | null` added to `AgentConfig`
- [x] Config migration: an old config that reads as `null` is treated as unpaired (`getOrCreateConfig` auto-normalizes and writes back)
- [x] Add `isPaired() / pinPeerPWA(pk, signPk) / clearPeerPWA()` helpers. `pinPeerPWA` throws if a different pair is already pinned; `clearPeerPWA` also rotates `keyPair` so old session DEKs can no longer be decrypted
- [x] Config tests grew from 31 to 43 (12 new tests covering TOFU + pin/clear/idempotency/error paths); 836 agent tests all green
- [x] **Files**: `apps/agent/src/config.ts`, `apps/agent/src/config.test.ts`

### C2. Handshake signature verification

- [x] V2 handshake extended with `sigPubkey` + `signature` fields (canonical body `key-exchange-v2|agentId|sigPubkey|encryptedDEK|ts`)
- [x] Added `packages/shared/src/keyExchange.ts`: `canonicalKeyExchangeV2Body / signKeyExchangeV2 / verifyKeyExchangeV2Signature`
- [x] Agent `handleKeyExchange`: timestamp check → grab sigPubkey/signature → verify → read config → when paired, require sigPubkey === pinned; when unpaired, `pinPeerPWA` performs TOFU write
- [x] PWA `WebSocketClient` adds a `SigningKeyPairProvider` callback; `initiateKeyExchange` becomes async, signs the envelope after fetching the signing keypair; App.tsx wires up the provider
- [x] Test coverage: `connection.test.ts` adds 6 TOFU tests (pin-first, mismatch reject, match accept, missing sigPubkey reject, missing signature reject, verify fail reject); the helpers in `connection.edge.test.ts` + `ai/edgeCases.test.ts` are also patched with sig fields
- [x] 836 agent tests all green (including new TOFU tests)
- [x] **Files**: `packages/shared/src/keyExchange.ts` (new), `packages/shared/src/types.ts` (KeyExchangeV2 extension), `packages/shared/src/index.ts`, `apps/agent/src/connection/connection.ts`, `apps/pwa/src/lib/websocket.ts`, `apps/pwa/src/App.tsx`, `apps/agent/src/connection/connection.test.ts`, `apps/agent/src/connection/connection.edge.test.ts`, `apps/agent/src/ai/edgeCases.test.ts`

### C3. Tombstone pubsub subscription + self-destruct

- [x] **v1 uses catch-up GET** (no new relay endpoint added): on every signaling `'connected'` (including first connect and every reconnect), automatically run `GET /sync/{hash(peerPWAPublicKey)}`; 410 → parse tombstone → verify signature → self-destruct
- [x] Added `apps/agent/src/tombstoneCheck.ts`: `hashPublicKey / signalingServerToHttp / checkTombstone`, returns `{ absent | tombstoned | verify-failed | error }`; `oldPublicKey` must match the pinned pubkey, otherwise it's rejected as a replay
- [x] `AgentConnection` adds a public `runTombstoneCheck()` method + a private `handleVerifiedTombstone()`: clear all peer sessions → `clearPeerPWA()` (which rotates the agent's own X25519 keypair) → emit a `'tombstoned'` event up to the caller
- [x] The signaling transport does not actively disconnect — let the daemon keep running in the unpaired state so a fresh PWA TOFU can connect right away ("closed" state is reserved for C4)
- [x] **Tests**: `tombstoneCheck.test.ts` adds 22 tests (hash / URL scheme / HTTP 404/200/410/500 / signature verify positive and negative / malformed / network error / bad pinned pk); `connection.test.ts` adds 7 tests (unpaired no-op, absent no-emit, tombstoned full self-destruct, verify-failed ignored, error ignored, connected event auto-runs check). 871 agent tests all green
- [x] **Caveat**: v1 has no server push; tombstone detection requires a signaling reconnect. In practice once the PWA rotates, the agent inevitably receives a bye (PWA switches identity) → signaling reconnects → check runs. Push with <1s latency would require extending the `@sumicom/ws-relay` protocol (left for v2)
- [x] **Files**: `apps/agent/src/tombstoneCheck.ts` (new), `apps/agent/src/tombstoneCheck.test.ts` (new), `apps/agent/src/connection/connection.ts`, `apps/agent/src/connection/connection.test.ts`

### C4. Self-locked mode + CLI unlock

- [x] Agent state gains explicit `'unpaired' | 'paired' | 'closed'` states (`AgentPairState` type + `AgentConnection.getState()` + runtime-only `tombstonedClosed` flag)
- [x] `AgentConnection.unlockPairing()` clears the closed flag; `handleKeyExchange` outright rejects in the closed state and emits an error (test-covered)
- [x] New IPC methods: `get-agent-state` (returns `AgentStateResult`: state/agentId/publicKey/signPublicKey/peerPWA*/peerCount/connectionState), `unlock-pairing` (returns `{previousState, state}`)
- [x] `quicksave status` top-level CLI: calls `get-agent-state` and prints the current state + connection info; if `closed`, hints that the next step is `quicksave pair`
- [x] `quicksave pair` top-level CLI: calls `unlock-pairing` (closed → unpaired), then calls `get-pairing-info` to display the connection URL + QR
- [x] **Tests**: `connection.test.ts` adds 7 C4 tests (getState unpaired/paired/closed, unlockPairing clears flag, closed blocks handleKeyExchange, TOFU works after unlockPairing, unlockPairing no-op when not closed). 878 agent tests all green
- [x] **Files**: `apps/agent/src/connection/connection.ts` (`AgentPairState`, `tombstonedClosed`, `getState`, `unlockPairing`, closed gate, `handleVerifiedTombstone` sets flag), `apps/agent/src/service/types.ts` (`AgentPairState`/`AgentStateResult`/`UnlockPairingResult`), `apps/agent/src/service/run.ts` (two new IPC methods), `apps/agent/src/index.ts` (`status` + `pair` top-level commands), `apps/agent/src/connection/connection.test.ts` (+7 C4 tests)

### C5. Stage C acceptance

- [ ] A fresh agent runs `quicksave pair`, one PWA connects, and `peerPWA*` is written to config
- [ ] A second PWA (with a keypair derived from the same masterSecret) can connect (signing pubkey is identical)
- [ ] Run rotate-keys on the PWA → the agent automatically goes into closed and rejects connections
- [ ] After `quicksave pair` the agent can re-enter paired

---

## Stage D — Cleanup + docs

### D1. Remove the old per-PWA identity code ✅

- [x] `identityStore.ts` now only stores `publicKey` (derived from `masterSecret`); deleted `pairedDevices` / `isSource` / `addPairedDevice` / `removePairedDevice` / `setIsSource`
- [x] Changed App.tsx's "per-device fan-out sync" to "shared-mailbox pull-merge-push"
- [x] Renamed `syncClient.pushToDevice` to `pushToMailbox` and updated docs
- [x] Rewrote `DevicePairingSection.tsx`: removed the manual paired-device list UI, kept only Group Public Key + Rotate Identity
- [x] Deleted the `IDENTITY_KEY` / `SIGNING_KEY` constants and the `getIdentityKeyPair` / `saveIdentityKeyPair` / `getSigningKeyPair` / `saveSigningKeyPair` / `clearIdentityKeys` functions from `secureStorage.ts`
- [x] Deleted the `PairedDevice` interface from `packages/shared/src/types.ts`
- [x] PWA `tsc --noEmit` green; shared 144/144 + agent 878/878 tests green
- **Files**: `apps/pwa/src/stores/identityStore.ts`, `apps/pwa/src/App.tsx`, `apps/pwa/src/lib/syncClient.ts`, `apps/pwa/src/components/DevicePairingSection.tsx`, `apps/pwa/src/lib/secureStorage.ts`, `packages/shared/src/types.ts`

### D2. Documentation sync ✅

- [x] `docs/references/quicksave-architecture.en.md` §三 adds two new subsections "PWA group sync (shared-mailbox)" + "Agent TOFU + Tombstone catch-up"
- [x] `docs/references/quicksave-architecture.en.md` §六 updates the identityStore shape and API
- [x] `CLAUDE.md` doc-sync table adds a row: PWA↔PWA sync mailbox / TOFU / tombstone → `sync-security.en.md` + `architecture.md` §三
- [x] `docs/guidelines/sync-security.en.md` drift fixes:
  - TOFU updated from "the current implementation does not persist the peer pubkey" to "implemented in connection.ts + config.ts"
  - The entire Tombstone Pubsub Subscription section replaced with Tombstone Catch-up GET + AgentPairState state machine + CLI status/pair
  - The "Relay pubsub push" line removed from the Files Map; the IPC unlock path switched to `get-agent-state` / `unlock-pairing`
  - Open Questions §2 (tombstone pubsub reliability) marked resolved, using catch-up GET

### D3. Verification path (manual)

**Migration note**: the changes in Stage B–D **do not require a DB wipe**. Existing PWAs' `masterSecret` remains valid (`deriveSharedKeys` will derive the same shared pubkey), the orphan `IDENTITY_KEY` / `SIGNING_KEY` rows in IndexedDB are harmless, and two PWAs sharing the same `masterSecret` will automatically converge on the new shared mailbox and LWW-merge on the first push. **The only user action required** is to run `quicksave pair` once on each agent to re-TOFU-pin (C2 makes the handshake mandatorily signed; old unsigned ones won't pass; this exactly matches the Group Reset cost in `sync-security.en.md`).

**In-place upgrade path (recommended)**:
- [ ] An existing PWA loads the new code directly; verify `masterSecret` is still in IndexedDB, the `machines` list still shows up, and the next sync push successfully PUTs to the new shared mailbox
- [ ] Run `quicksave pair` on each agent and complete the TOFU pin by scanning the QR with the PWA
- [ ] Run `quicksave status` to see state = `paired` and that the peerPWA pubkey matches the PWA's Group Public Key

**Cold-start verification (optional, for incompatible scenarios)**:
- [ ] Wipe the dev agent's `~/.quicksave/`
- [ ] Wipe the dev PWA's IndexedDB / localStorage
- [ ] Run a full bootstrap once more (PWA generates a new `masterSecret` → agent `quicksave pair` → second PWA goes through pair flow to fetch the `masterSecret`) to confirm the fresh-state flow works

---

## Risk / Watch-out

1. **PWA `url_handlers` support**: Safari / Firefox have weak `url_handlers` support, so deep links may still need to fall back to the web pair route. When building the UI in Stage A3, test all three browsers.
2. **Limitations of using BroadcastChannel for MockRelay**: only crosses same-origin tabs, not cross-origin. Good enough for the Stage A demo, but don't treat it as the integration-test baseline.
3. **Handshake protocol compatibility**: Stage C2 changes V2 key-exchange. Old PWAs (only V2 without signatures) connecting to a new agent will fail — this is currently a breaking change, but since there's only one user who will re-pair himself, it's acceptable.
4. **Per-mailbox mutex behavior after a relay restart**: all in-flight state is lost; the client must be able to make stateless forward progress from 409 / 200. Stage B4 tests this.
5. **Tombstone pubsub misses**: tombstone events are missed when the agent is offline. The first version accepts "actively check the old mailbox state once on reconnect" as catch-up (open `GET /sync/{hash}` and self-destruct on 410).

---

## Suggested starting point

**A1 + A3 in parallel**:
- A1 is pure functions, can be TDD'd independently; handing a spec to a subagent to generate tests is a perfect fit
- A3 can start with a static mockup (no state machine wired up) to nail down the UI look and routing

The two converge at A2.
