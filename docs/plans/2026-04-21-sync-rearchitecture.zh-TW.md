# 2026-04-21 Sync Re-architecture Plan

## Summary

切到「single shared `masterSecret` + multi-slot pairing mailbox + QR/URL + SAS」模型，並在 agent 端加上 TOFU + tombstone 自毀。

**Design doc**：`docs/guidelines/sync-security.zh-TW.md`

**Migration**：唯一使用者是開發者本人、會自行重 pair。**不做 in-place migration**，新版直接覆蓋舊 protocol。

**Ordering**：PWA UI/UX 先（可用 MockRelay 獨立 demo）→ relay backend → agent TOFU → 清理。

## Progress Legend

- `[ ]` 未開始
- `[~]` 進行中
- `[x]` 完成

---

## Stage A — PWA (UI + client crypto, mocked network)

目標：PWA 可以在**沒有真 relay 參與**的情境下 demo 完整 pairing 流程（兩個瀏覽器 tab 之間透過 MockRelay 單例對話）。

### A1. Shared crypto helper 擴充

- [x] `sasEncode(hmacOutput: Uint8Array, chars: number): string`，32 符號 alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
- [x] `sasBucket(now: number, windowMs = 60_000): number`
- [x] `sasCompute(pubkey: Uint8Array, bucket: number): string`，封裝 HMAC 計算（以 SHA-512 + domain separation 實作）
- [x] `deriveSharedKeys(masterSecret: Uint8Array)` → `{ x25519: KeyPair, ed25519: SigningKeyPair }`，domain-separated SHA-512 seed → `nacl.box.keyPair.fromSecretKey` + `nacl.sign.keyPair.fromSeed`
- [x] **Files**: `packages/shared/src/crypto.ts`, `packages/shared/src/crypto.test.ts`
- [x] **Delegate tests**：46 個新測試由 subagent 產出，全綠（75 tests total in crypto.test.ts）

### A2. Pairing client lib（interface + MockRelay impl）

- [x] 定義 `PairTransport` interface：`postSlot / getSlots / deleteMailbox / subscribeToMailbox`
- [x] `MockRelay` 實作（module-level singleton、BroadcastChannel 跨 tab、64 槽 cap、TTL GC、測試可關閉 BC）
- [x] `PairClient` 類別：
  - A 側：`createInvite({ baseUrl, masterSecret, ttlMs?, sasWindowMs?, sasChars? })` → `{ pairUrl, qrData, eA_pubB64, addr, expiresAt, onCandidate, submitSAS, cancel }`
  - B 側：`acceptInvite({ pairUrl? | eA_pubB64? })` → `{ sas, bucket, sasExpiresAt, eB_pubB64, onSecret, cancel }`
- [x] Slot 解密 + SAS 過濾邏輯（0/1/2+ match 三條路；SAS 容忍 ±1 bucket 時鐘漂移）
- [x] Cancel / TTL 到期自動清 subscriptions
- [x] Pair URL 改用 HashRouter 格式 `/#/pair?k=<base64url>`（`k=` 仍在 fragment，不送到 server）
- [x] **Files**: `apps/pwa/src/lib/pairClient.ts`、`apps/pwa/src/lib/pairClient.test.ts`（40 tests 全綠）

### A3. Pairing UI / 路由 / state machine

- [x] Deep-link 路由 `/pair`（三處 `<Routes>` 都加，走 HashRouter `useSearchParams` 解 `k=`）
- [x] PWA manifest `url_handlers` 宣告（`localhost:5173`、`localhost`）
- [x] `PairDeviceModal.tsx`（A 側）：QR 顯示（`qrcode` 產 data URL）+ 可複製 URL + SAS 輸入框 + TTL 倒數 + 候選計數
- [x] `JoinGroupPage.tsx`（B 側）：route-level 頁面、從 search params 解 `k`、大字 SAS 顯示 + 60s 倒數 + 成功/錯誤狀態
- [x] Error UX：0 match「沒有對上的裝置」、2+ match「偵測到可疑碰撞」（紅色 abort）、loading / 錯誤訊息
- [x] `ScanToJoinModal.tsx`（B 側相機入口）：用 `html5-qrcode` 掃 A 側 QR、成功後 `navigate('/pair?k=...')` 交給 JoinGroupPage
- [x] Settings 區塊重構：單顆按鈕拆成「邀請新裝置」+「連結到現有裝置」雙按鈕、各自配 sub-text
- [x] **Files**: `apps/pwa/src/routes/JoinGroupPage.tsx`、`apps/pwa/src/components/PairDeviceModal.tsx`、`apps/pwa/src/components/ScanToJoinModal.tsx`、`apps/pwa/src/App.tsx`（三處 Routes）、`apps/pwa/src/components/SettingsPage.tsx`（雙觸發按鈕）、`apps/pwa/vite.config.ts`（manifest url_handlers）

### A4. Stage A 驗收

- [x] Headless E2E（`pairClient.test.ts` happy path）：A 產 invite、B accept、A 收到 candidate、submitSAS → `{ status: 'sent' }`、B onSecret 收到原始 masterSecret bytes
- [x] 0 match / 2+ match / case-insensitive / wrong-length SAS、cancel idempotent、ciphertext 不可由第三者解 — 全部自動測
- [x] 所有 Stage A 測試通過：`packages/shared` 97 tests、`apps/pwa` pairClient 40 tests
- [ ] **User action**：`pnpm dev:pwa`、兩 tab 手動 UI 驗收（A = Settings → 加入新裝置（SAS）；B = 開 `#/pair?k=...` URL）

---

## Stage B — Relay backend + 串回真實網路

### B1. Multi-slot pair mailbox

- [x] `PairSlot` / `PairMailbox` 資料結構（append-only、cap 64、TTL 5 min、activity 延長 TTL）
- [x] Garbage collector（`startGc` 用 setInterval、`.unref()` 不阻塞 Node 退出）
- [x] 錯誤型別：`PairStoreFullError`、`PairStoreTooLargeError`
- [x] **Files**: `apps/relay/src/pairStore.ts`、`apps/relay/src/pairStore.test.ts`（33 tests by subagent）、`apps/relay/src/pairRoutes.test.ts`（17 HTTP/SSE integration tests）— 全 relay 套件 92/92 綠

### B2. Pair HTTP routes

- [x] `POST /pair-requests/{addr}` append slot（回 `{id, mailboxExpiresAt}`、201）
- [x] `GET /pair-requests/{addr}` 回 `{slots}`
- [x] `DELETE /pair-requests/{addr}` → 204
- [x] `GET /pair-requests/{addr}/subscribe` SSE（含 25s ping、teardown on close）
- [x] Per-IP sliding-window rate-limit（60s / 120 req，pair + sync 共用）
- [x] Dev: `apps/pwa/vite-plugin-relay.ts` 加 inline 對等路由 supporting `vite dev`
- [x] **Files**: `apps/relay/src/index.ts`、`apps/pwa/vite-plugin-relay.ts`

### B3. Pubsub topic extensions

- [x] `pair:{addr}` topic：實作在 B2 的 SSE（`PairStore.subscribe` + `/subscribe` endpoint）
- [x] `tombstone:{hash}` topic：WS push channel（`tombstone-subscribe`/`-unsubscribe`/`-event`）+ `syncRoutes` `onTombstone` callback + agent 180s catch-up GET fallback
- [x] **Files**: `apps/relay/src/tombstoneSubs.ts`（新）、`apps/relay/src/syncRoutes.ts`、`apps/relay/src/index.ts`、`apps/agent/src/connection/relay.ts`、`apps/agent/src/connection/connection.ts`

### B4. Signed sync envelope + per-mailbox mutex

- [x] `SignedSyncEnvelope` schema + Ed25519 verify on PUT/DELETE `/sync/*`（共用 `verifySignedRequest`，`extra=[keyHash, ciphertextHash]`；lock-release 的 `ciphertextHash=''`）
- [x] Per-mailbox in-flight mutex（`SyncStore.tryAcquireLock/releaseLock`，10s TTL 自動過期；`stats.locks` 暴露診斷）
- [x] HTTP 409 + `Retry-After` 標頭 + client 端指數退避（150ms base、max 4 retries、max 5s、抖動，並尊重 server 回的 `retryAfterMs`）
- [x] Cancel route `DELETE /sync/{hash}/lock`（envelope action `sync-lock-release`、禁帶 ciphertext）
- [x] 把 handler 抽到 `apps/relay/src/syncRoutes.ts`（`createSyncRouter`），prod index.ts 與 test 共用同一份，避免漂移
- [x] `apps/pwa/vite-plugin-relay.ts` dev middleware 也支援新 envelope 與 `/lock`（開發模式不做簽章驗證，只剝 envelope）
- [x] `apps/pwa/src/lib/syncClient.ts` 新 API：`pushToDevice / postTombstone / releaseLock` 全部要求 `SyncSignKeyPair`；`rotateIdentity` 回傳舊 signing keypair 以利 post tombstone
- [x] **Tests**：47 個 shared envelope 單元測試 + 12 個 SyncStore lock 單元測試 + 18 個 syncRoutes HTTP 整合測試（bad-sig / replay / tampered / stale / future / 413 / 409 均覆蓋）
- [x] **Flake 清理**：順手把 `pairRoutes.test.ts` 由固定 port 改成 `port: 0`（OS 挑空 port，避免 TIME_WAIT flake）
- [x] **Files**: `apps/relay/src/syncStore.ts`、`apps/relay/src/syncRoutes.ts`（新）、`apps/relay/src/index.ts`、`apps/relay/src/syncRoutes.test.ts`（新）、`apps/relay/src/syncLocks.test.ts`（新）、`apps/pwa/src/lib/syncClient.ts`、`apps/pwa/src/stores/identityStore.ts`、`apps/pwa/src/App.tsx`、`apps/pwa/src/components/DevicePairingSection.tsx`、`apps/pwa/vite-plugin-relay.ts`、`packages/shared/src/syncEnvelope.ts`、`packages/shared/src/syncEnvelope.test.ts`（新）

### B5. 換掉 MockRelay

- [x] `HttpPairTransport`：`apps/pwa/src/lib/httpPairTransport.ts`（fetch + EventSource）
- [x] `getDefaultPairTransport()`：從 connectionStore 抓 signaling URL、回 HttpPairTransport
- [x] `PairDeviceModal` / `JoinGroupPage` 切換掉 `getSharedMockRelay`
- [ ] E2E test：兩 PWA 透過真 relay pair 成功
- [ ] 手動驗證：桌機 Chrome + 手機 PWA 實機 pair

### B6. Stage B 驗收

- [ ] 所有 pairing flow E2E 測試通過
- [ ] 兩台 PWA 成功同步 `masterSecret` 與 machine list
- [ ] 409 退避在人為製造競爭下正確收斂

---

## Stage C — Agent TOFU + tombstone 自毀

可與 Stage B 並行（不同 app、不同檔案）。

### C1. Agent config schema

- [x] `peerPWAPublicKey: string | null`、`peerPWASignPublicKey: string | null` 加入 `AgentConfig`
- [x] Config migration：舊 config 讀到 `null` 視為 unpaired（`getOrCreateConfig` 自動 normalize + 寫回）
- [x] 新增 `isPaired() / pinPeerPWA(pk, signPk) / clearPeerPWA()` helpers。`pinPeerPWA` 對已 pin 不同對的情況會 throw；`clearPeerPWA` 會順便 rotate `keyPair` 讓舊 session DEK 不可解
- [x] Config tests 從 31 擴到 43 tests（新 12 個覆蓋 TOFU + pin/clear/idempotency/error paths），836 agent tests 全綠
- [x] **Files**: `apps/agent/src/config.ts`、`apps/agent/src/config.test.ts`

### C2. Handshake 驗簽

- [x] V2 handshake 擴充 `sigPubkey` + `signature` 欄位（canonical body `key-exchange-v2|agentId|sigPubkey|encryptedDEK|ts`）
- [x] 新增 `packages/shared/src/keyExchange.ts`：`canonicalKeyExchangeV2Body / signKeyExchangeV2 / verifyKeyExchangeV2Signature`
- [x] Agent `handleKeyExchange`：timestamp check → 拿 sigPubkey/signature → verify → 讀 config → paired 時要求 sigPubkey === pinned；unpaired 時 `pinPeerPWA` 做 TOFU 寫入
- [x] PWA `WebSocketClient` 新增 `SigningKeyPairProvider` callback；`initiateKeyExchange` 變成 async，拿到 signing keypair 後對 envelope 簽章；App.tsx 掛上 provider
- [x] 測試覆蓋：`connection.test.ts` 加 6 個 TOFU 測試（pin-first、mismatch reject、match accept、missing sigPubkey reject、missing signature reject、verify fail reject）；`connection.edge.test.ts` + `ai/edgeCases.test.ts` 的 helper 也補上 sig fields
- [x] 836 agent tests 全綠（含新 TOFU 測試）
- [x] **Files**: `packages/shared/src/keyExchange.ts`（新）、`packages/shared/src/types.ts`（KeyExchangeV2 擴充）、`packages/shared/src/index.ts`、`apps/agent/src/connection/connection.ts`、`apps/pwa/src/lib/websocket.ts`、`apps/pwa/src/App.tsx`、`apps/agent/src/connection/connection.test.ts`、`apps/agent/src/connection/connection.edge.test.ts`、`apps/agent/src/ai/edgeCases.test.ts`

### C3. Tombstone pubsub 訂閱 + 自毀

- [x] **v1 採 catch-up GET**（不加新 relay endpoint）：每次 signaling `'connected'`（含首次連線與每次 reconnect）自動跑 `GET /sync/{hash(peerPWAPublicKey)}`；410 → 解析 tombstone → 驗章 → 自毀
- [x] 新增 `apps/agent/src/tombstoneCheck.ts`：`hashPublicKey / signalingServerToHttp / checkTombstone`，回傳 `{ absent | tombstoned | verify-failed | error }`；`oldPublicKey` 必須與 pinned pubkey 一致，否則當作 replay 拒絕
- [x] `AgentConnection` 新增 `runTombstoneCheck()` public method + `handleVerifiedTombstone()` private：清所有 peer sessions → `clearPeerPWA()`（連帶 rotate 自己的 X25519 keypair）→ emit `'tombstoned'` 事件給上層
- [x] Signaling transport 不主動 disconnect —— 讓 daemon 繼續跑在 unpaired 狀態，後續新的 PWA TOFU 可以直接接上（"closed" state 留給 C4）
- [x] **Tests**：`tombstoneCheck.test.ts` 新增 22 測試（hash / URL scheme / HTTP 404/200/410/500 / 驗章正反 / malformed / network error / bad pinned pk）；`connection.test.ts` 新增 7 測試（unpaired no-op、absent no-emit、tombstoned 完整自毀、verify-failed ignored、error ignored、connected event 會自動跑 check）。871 agent tests 全綠
- [x] **Caveat**：v1 沒有 server push；tombstone 偵測到需要 signaling reconnect。實際使用上 PWA rotate 後 agent 必然收到 bye（PWA 切換 identity）→ signaling 重連 → check。若要 <1s latency 的推送需要擴 `@sumicom/ws-relay` 協議（留給 v2）
- [x] **Files**: `apps/agent/src/tombstoneCheck.ts`（新）、`apps/agent/src/tombstoneCheck.test.ts`（新）、`apps/agent/src/connection/connection.ts`、`apps/agent/src/connection/connection.test.ts`

### C4. 自閉模式 + CLI 解鎖

- [x] Agent state 新增 `'unpaired' | 'paired' | 'closed'` 明確狀態（`AgentPairState` type + `AgentConnection.getState()` + runtime-only `tombstonedClosed` flag）
- [x] `AgentConnection.unlockPairing()` 解除 closed flag；`handleKeyExchange` 在 closed 狀態直接拒絕 + emit error（測試覆蓋）
- [x] IPC 新方法：`get-agent-state`（回 `AgentStateResult`：state/agentId/publicKey/signPublicKey/peerPWA*/peerCount/connectionState）、`unlock-pairing`（回 `{previousState, state}`）
- [x] `quicksave status` top-level CLI：打 `get-agent-state` 印出當前 state + 連線資訊；若 `closed` 提示下一步該跑 `quicksave pair`
- [x] `quicksave pair` top-level CLI：打 `unlock-pairing`（closed → unpaired），再打 `get-pairing-info` 顯示連線 URL + QR
- [x] **Tests**：`connection.test.ts` 新增 7 個 C4 測試（getState unpaired/paired/closed、unlockPairing 清 flag、closed 擋 handleKeyExchange、unlockPairing 後可 TOFU、unlockPairing no-op when not closed）。878 agent tests 全綠
- [x] **Files**: `apps/agent/src/connection/connection.ts`（`AgentPairState`、`tombstonedClosed`、`getState`、`unlockPairing`、closed gate、`handleVerifiedTombstone` 設 flag）、`apps/agent/src/service/types.ts`（`AgentPairState`/`AgentStateResult`/`UnlockPairingResult`）、`apps/agent/src/service/run.ts`（兩個新 IPC 方法）、`apps/agent/src/index.ts`（`status` + `pair` 兩個 top-level command）、`apps/agent/src/connection/connection.test.ts`（+7 C4 tests）

### C5. Stage C 驗收

- [ ] 全新 agent 跑 `quicksave pair`，一台 PWA 接上、config 寫入 `peerPWA*`
- [ ] 第二台 PWA（用同 masterSecret 派生 keypair）能接上（signing pubkey 相同）
- [ ] PWA 端跑 rotate-keys → agent 自動進 closed、連線拒絕
- [ ] `quicksave pair` 後 agent 能重新進 paired

---

## Stage D — 清理 + 文件

### D1. 移除舊的 per-PWA identity 程式 ✅

- [x] `identityStore.ts` 改成只存 `publicKey`（從 `masterSecret` 派生）；刪除 `pairedDevices` / `isSource` / `addPairedDevice` / `removePairedDevice` / `setIsSource`
- [x] 把 App.tsx 的「per-device fan-out sync」改成「shared-mailbox pull-merge-push」
- [x] 把 `syncClient.pushToDevice` 重新命名為 `pushToMailbox` 並更新 doc
- [x] 重寫 `DevicePairingSection.tsx`：砍掉手貼 paired-device list UI，只留 Group Public Key + Rotate Identity
- [x] 刪除 `secureStorage.ts` 的 `IDENTITY_KEY` / `SIGNING_KEY` 常數與 `getIdentityKeyPair` / `saveIdentityKeyPair` / `getSigningKeyPair` / `saveSigningKeyPair` / `clearIdentityKeys` 函式
- [x] 從 `packages/shared/src/types.ts` 刪除 `PairedDevice` interface
- [x] PWA `tsc --noEmit` 綠；shared 144/144 + agent 878/878 tests 綠
- **Files**: `apps/pwa/src/stores/identityStore.ts`、`apps/pwa/src/App.tsx`、`apps/pwa/src/lib/syncClient.ts`、`apps/pwa/src/components/DevicePairingSection.tsx`、`apps/pwa/src/lib/secureStorage.ts`、`packages/shared/src/types.ts`

### D2. 文件同步 ✅

- [x] `docs/references/quicksave-architecture.zh-TW.md` §三 新增「PWA 群組同步 (shared-mailbox)」+「Agent TOFU + Tombstone catch-up」兩個子節
- [x] `docs/references/quicksave-architecture.zh-TW.md` §六 更新 identityStore 形狀與 API
- [x] `CLAUDE.md` 文件同步表格新增一行：PWA↔PWA sync mailbox / TOFU / tombstone → `sync-security.zh-TW.md` + `architecture.md` §三
- [x] `docs/guidelines/sync-security.zh-TW.md` 修正 drift：
  - TOFU 從「現行實作不持久化 peer pubkey」更新為「已實作於 connection.ts + config.ts」
  - 把 Tombstone Pubsub Subscription 整節替換為 Tombstone Catch-up GET + AgentPairState 狀態機 + CLI status/pair
  - Files Map「Relay pubsub 推送」那一行移除；IPC 解鎖路徑改用 `get-agent-state` / `unlock-pairing`
  - Open Questions §2（tombstone pubsub 可靠性）標記為已解，採 catch-up GET

### D3. 驗證路徑（manual）

**遷移性質說明**：Stage B–D 的改動**不需要 DB wipe**。現有 PWA 的 `masterSecret` 繼續有效（`deriveSharedKeys` 會派生出相同的共用 pubkey），IndexedDB 裡 orphan 的 `IDENTITY_KEY` / `SIGNING_KEY` rows 無害；兩台同 `masterSecret` 的 PWA 會在第一次 push 時自動聚到新的共用 mailbox 並 LWW 合併。**唯一需要使用者動作**的是每台 agent 跑一次 `quicksave pair` 重新 TOFU-pin（C2 把 handshake 改成強制簽章，舊 unsigned 不通過；這正好符合 `sync-security.zh-TW.md` 的 Group Reset 代價）。

**就地升級路徑（推薦）**：
- [ ] 既有 PWA 直接 load 新版 code；自檢 IndexedDB 裡 `masterSecret` 還在、`machines` 列表仍顯示、下一次 sync push 能成功 PUT 到新的共用 mailbox
- [ ] 每台 agent 跑 `quicksave pair`，用 PWA 掃 QR 完成 TOFU pin
- [ ] 跑 `quicksave status` 看 state = `paired`、peerPWA pubkey 與 PWA 的 Group Public Key 一致

**冷啟動驗證（選擇性，不相容的情境用）**：
- [ ] 清空 dev agent 的 `~/.quicksave/`
- [ ] 清空 dev PWA 的 IndexedDB / localStorage
- [ ] 重跑一次完整 bootstrap（PWA 產生新 `masterSecret` → agent `quicksave pair` → 第二台 PWA 走 pair flow 拿 `masterSecret`），確認 fresh state 流程可走

---

## Risk / Watch-out

1. **PWA `url_handlers` 支援度**：Safari / Firefox 對 `url_handlers` 支援弱，deep link 可能仍需 fallback 到網頁版 pair route。Stage A3 做 UI 時要測三個瀏覽器。
2. **BroadcastChannel 做 MockRelay 的限制**：只跨同源 tab，不跨 origin。夠做 Stage A demo，但別把它當整合測試基準。
3. **Handshake 協議改動相容性**：Stage C2 會動 V2 key-exchange。舊的 PWA（只會 V2 無簽章）連上新 agent 會失敗——目前是 breaking change，但使用者只有一人、會自己重 pair，可接受。
4. **Per-mailbox mutex 在 relay restart 後的行為**：In-flight 狀態全失，client 端要能從 409 / 200 無狀態地往前走。Stage B4 測這個。
5. **Tombstone pubsub 遺漏**：agent 離線時 tombstone 事件會錯過。第一版接受「重連時主動查一次舊 mailbox 狀態」作為 catch-up（開 `GET /sync/{hash}` 取 410 即自毀）。

---

## Suggested starting point

**A1 + A3 並行**：
- A1 是 pure function、可獨立 TDD，交一份 spec 給 subagent 生測試最適合
- A3 可以先做靜態 mockup（不串 state machine），確認 UI 長相與路由

兩者在 A2 合流。
