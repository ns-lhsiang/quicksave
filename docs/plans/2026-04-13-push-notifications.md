# Web Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send browser push notifications when the agent needs user input (permission prompt, question) **or when a session goes idle** (turn completes and the agent is awaiting next instruction), even when the PWA tab is backgrounded or closed. Targets desktop Chrome, Android Chrome, and iOS Safari (16.4+).

**Triggers** — all gated on "no connected PWA peer currently watching this session":

| Trigger | Source event |
|---------|--------------|
| Agent asks for permission / question | `sessionManager` emits `user-input-request` |
| Session goes idle (turn complete, awaiting next instruction) | `sessionManager` emits `card-stream-end` |

Both triggers produce the **same payload shape** — `{ sessionId, agentSignPubKey }`. The notification tells the user "session X needs your attention"; it does not distinguish *why*, since the action is the same (open that session). `topic` header is set to `sessionId` so newer pushes replace older undelivered pushes for the same session.

---

## Architecture

**Signed HTTP side-channel on the relay**, decoupled from the WebSocket peer model.

```
PWA ──[Browser subscribe()]──▶ FCM / APNs / Mozilla autopush
 │                                                ▲
 │  PushSubscription { endpoint, p256dh, auth }   │
 │ ◀──────────────────────────────────────────    │
 │                                                │
 │ [E2E WS: push-subscription-offer]              │ (5) web-push
 ▼                                                │     (VAPID JWT + ECE)
Agent ──[HTTP POST /push/{agentSignPubKey}/register, signed]──▶ Relay ─────┘
Agent ──[HTTP POST /push/{agentSignPubKey}/notify,   signed]──▶ Relay
                                                         │
                                                         └── stored subscriptions
                                                             (in-memory + disk snapshot)
```

Key properties:

- **Relay's push HTTP routes only trust the agent's Ed25519 signature**, not URL identity. Any request must be signed by the private key matching the `agentSignPubKey` in the URL. This also closes the pre-existing URL-trust hole for `notify-push` specifically.
- **PWA never talks to relay's push HTTP**. It ships its browser `PushSubscription` to the agent over the existing E2E-encrypted WebSocket channel; the agent is the authority for "who is registered".
- **Relay's existing WebSocket push handlers (`push:subscribe`, `push:unsubscribe`, `notify-push`) are removed** — everything moves to HTTP.
- **Subscriptions persist across relay restarts** via a JSON snapshot on disk (in-memory store with periodic flush). PWAs are NOT required to be online at trigger time.

**Tech Stack:** Web Push API, `web-push` npm package (relay), `vite-plugin-pwa` with custom SW injection (PWA), `tweetnacl` (both relay & agent) for Ed25519 sign/verify, VAPID key pair (generated once).

---

## Keys in play

This plan involves three distinct keypairs — do not conflate them:

| Keypair | Who holds private | Purpose | Format |
|---------|-------------------|---------|--------|
| **VAPID** | Relay | Proves relay (as "app server") to FCM/APNs | Ed25519 (via `web-push` lib) |
| **Agent signing keypair** (NEW) | Agent (`~/.quicksave/agent.json`) | Signs HTTP requests to relay's `/push/*` routes; public key is the addressing ID | Ed25519 (`nacl.sign.keyPair`) |
| **Agent box keypair** (existing) | Agent (`~/.quicksave/agent.json`) | Existing E2E encryption with PWAs (session DEK) | X25519 (`nacl.box.keyPair`) |

The agent signing pubkey is exposed in pairing/QR payloads alongside the existing box pubkey and agentId. The box pubkey keeps doing what it does today; we just add a second keypair for signatures.

---

## VAPID Keys

Generate once before starting:

```bash
npx web-push generate-vapid-keys --json
```

Store the public key in PWA env (`VITE_VAPID_PUBLIC_KEY`) and both keys in relay env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). In production, set via deploy secrets.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/relay/src/pushStore.ts` | **NEW** — In-memory store of `PushSubscription[]` per `agentSignPubKey`, with JSON snapshot persistence |
| `apps/relay/src/pushService.ts` | **NEW** — `web-push` wrapper; sets `topic: sessionId`, `TTL: 300` |
| `apps/relay/src/sigVerify.ts` | **NEW** — Ed25519 signature + nonce/timestamp replay protection |
| `apps/relay/src/pushRoutes.ts` | **NEW** — HTTP handlers for `/push/{agentSignPubKey}/register` and `/push/{agentSignPubKey}/notify` |
| `apps/relay/src/index.ts` | **MODIFY** — Wire pushStore/Service/Routes; add URL routing for `/push/*`; add stats |
| `apps/pwa/src/sw.ts` | **NEW** — Custom service worker: `push` handler (unified title, topic=sessionId), `notificationclick` handler |
| `apps/pwa/src/lib/pushSubscription.ts` | **NEW** — Request permission, `pushManager.subscribe()`, forward `PushSubscription` to agent via E2E WS |
| `apps/pwa/src/components/NotificationPrompt.tsx` | **NEW** — UI banner to request notification permission |
| `apps/pwa/vite.config.ts` | **MODIFY** — Add `injectManifest` strategy with custom SW entry |
| `apps/agent/src/identity.ts` | **NEW or MODIFY** — Load/generate Ed25519 signing keypair alongside existing box keypair; expose `signPubKey` and `signSecretKey` |
| `apps/agent/src/service/pushClient.ts` | **NEW** — HTTP client that signs and POSTs to relay `/push/*` routes |
| `apps/agent/src/handlers/messageHandler.ts` | **MODIFY** — Handle `push-subscription-offer` message from PWA; call `pushClient.register()` |
| `apps/agent/src/service/run.ts` | **MODIFY** — On `user-input-request` / `card-stream-end` with no PWA watching, call `pushClient.notify(sessionId)` |
| `packages/shared/src/types.ts` | **MODIFY** — Add `push-subscription-offer` E2E message type; add `agentSignPubKey` to pairing payloads |

---

### Task 1: Generate VAPID keys and add to env

**Files:**
- Create: `apps/relay/.env.example`
- Create: `apps/pwa/.env.example`

- [x] **Step 1: Generate VAPID key pair**

```bash
npx web-push generate-vapid-keys --json
```

- [x] **Step 2: Create relay .env.example**

```
VAPID_PUBLIC_KEY=BNx...
VAPID_PRIVATE_KEY=abc...
VAPID_SUBJECT=mailto:admin@localhost
PUSH_RELAY_URL=http://localhost:3001   # base URL the agent will POST to (see Task 10)
PUSH_STORE_PATH=./data/push-store.json # on-disk snapshot path; gitignored
```

- [x] **Step 3: Create PWA .env.example**

```
VITE_VAPID_PUBLIC_KEY=BNx...
```

- [x] **Step 4: Set actual env vars for dev**

For local dev, create `.env` files (gitignored) with real keys. Add `apps/relay/data/` to `.gitignore` if not already.

---

### Task 2: Agent signing keypair

**Files:**
- Modify: `apps/agent/src/identity.ts` (or wherever `~/.quicksave/agent.json` is loaded — search for `agent.json`)
- Modify: `packages/shared/src/types.ts`
- Modify: pairing/QR emission code in agent CLI (whichever command prints pairing info)
- Modify: `apps/pwa/src/components/AddMachineModal.tsx` + `QRScanner.tsx` to accept & store `agentSignPubKey`

The agent gains a second keypair, stored alongside the existing box keypair.

- [x] **Step 1: Extend agent identity file schema**

```typescript
// ~/.quicksave/agent.json schema (v2)
{
  "version": 2,
  "agentId": "abc123...",              // existing random id
  "boxPublicKey":  "base64...",        // existing X25519
  "boxSecretKey":  "base64...",        // existing X25519
  "signPublicKey": "base64...",        // NEW Ed25519
  "signSecretKey": "base64..."         // NEW Ed25519 (64 bytes, NaCl "secret key")
}
```

Migration: if the loaded file has no `signPublicKey`, generate a new `nacl.sign.keyPair()`, write back atomically. Do NOT rotate the box keypair.

- [x] **Step 2: Export signing primitives**

```typescript
// apps/agent/src/identity.ts
export interface AgentIdentity {
  agentId: string;
  boxPublicKey: Uint8Array;
  boxSecretKey: Uint8Array;
  signPublicKey: Uint8Array;   // NEW
  signSecretKey: Uint8Array;   // NEW
}

export function sign(identity: AgentIdentity, message: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, identity.signSecretKey);
}

export function signPubKeyB64(identity: AgentIdentity): string {
  return encodeBase64Url(identity.signPublicKey);
}
```

Use **URL-safe base64 without padding** for `signPubKeyB64` — it will appear in URL paths.

- [x] **Step 3: Add `agentSignPubKey` to pairing payload**

Wherever the agent emits pairing info (QR code, `quicksave pair` command output, whatever add-machine reads), include `agentSignPubKey`. PWA stores it alongside `agentId` and `publicKey` in its machine record.

- [x] **Step 4: Accept `agentSignPubKey` in PWA machine list**

Update `AddMachineModal`, `QRScanner`, and the machine store type. Machines paired before this change will lack `agentSignPubKey` — the PWA should detect missing field and surface a "re-pair this machine to enable notifications" hint. No automatic migration.

- [x] **Step 5: Verify compilation**

Run: `cd apps/agent && npx tsc --noEmit && cd ../pwa && npx tsc --noEmit`

---

### Task 3: Push subscription store on relay

**Files:**
- Create: `apps/relay/src/pushStore.ts`

Keyed by `agentSignPubKey` (the URL-safe base64 string). In-memory `Map`, with a debounced JSON snapshot to `PUSH_STORE_PATH` after every mutation (flush every 2s, max).

- [x] **Step 1: Create PushStore**

```typescript
// apps/relay/src/pushStore.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class PushStore {
  private subs = new Map<string, Map<string, PushSubscriptionData>>(); // agentSignPubKey -> (endpoint -> sub)
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private snapshotPath: string | null) {
    if (snapshotPath) this.load();
  }

  register(agentSignPubKey: string, sub: PushSubscriptionData): void {
    let m = this.subs.get(agentSignPubKey);
    if (!m) { m = new Map(); this.subs.set(agentSignPubKey, m); }
    m.set(sub.endpoint, sub);
    this.scheduleFlush();
  }

  unregister(agentSignPubKey: string, endpoint: string): void {
    const m = this.subs.get(agentSignPubKey);
    if (!m) return;
    m.delete(endpoint);
    if (m.size === 0) this.subs.delete(agentSignPubKey);
    this.scheduleFlush();
  }

  removeByEndpoint(endpoint: string): void {
    for (const [k, m] of this.subs) {
      m.delete(endpoint);
      if (m.size === 0) this.subs.delete(k);
    }
    this.scheduleFlush();
  }

  list(agentSignPubKey: string): PushSubscriptionData[] {
    return Array.from(this.subs.get(agentSignPubKey)?.values() ?? []);
  }

  get stats() {
    let total = 0;
    for (const m of this.subs.values()) total += m.size;
    return { agents: this.subs.size, subscriptions: total };
  }

  private scheduleFlush() {
    if (!this.snapshotPath || this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 2000);
  }

  private flush() {
    if (!this.snapshotPath) return;
    const out: Record<string, PushSubscriptionData[]> = {};
    for (const [k, m] of this.subs) out[k] = Array.from(m.values());
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    writeFileSync(this.snapshotPath, JSON.stringify(out), 'utf8');
  }

  private load() {
    if (!this.snapshotPath) return;
    try {
      const raw = readFileSync(this.snapshotPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, PushSubscriptionData[]>;
      for (const [k, arr] of Object.entries(parsed)) {
        const m = new Map<string, PushSubscriptionData>();
        for (const sub of arr) m.set(sub.endpoint, sub);
        this.subs.set(k, m);
      }
    } catch { /* no snapshot yet */ }
  }
}
```

- [x] **Step 2: Write unit tests**

Cover register / unregister / removeByEndpoint / load-empty / load-populated / double-register-same-endpoint (upsert). Target `apps/relay/src/pushStore.test.ts` following existing syncStore test style.

- [x] **Step 3: Verify compilation and tests**

```
cd apps/relay && npx tsc --noEmit && npx vitest run
```

---

### Task 4: Push service (web-push wrapper)

**Files:**
- Create: `apps/relay/src/pushService.ts`
- Modify: `apps/relay/package.json` (add `web-push` + `@types/web-push`)

- [x] **Step 1: Install web-push**

```bash
pnpm add web-push --filter quicksave-relay
pnpm add -D @types/web-push --filter quicksave-relay
```

- [x] **Step 2: Create PushService**

```typescript
// apps/relay/src/pushService.ts
import webpush from 'web-push';
import type { PushStore, PushSubscriptionData } from './pushStore.js';

export interface PushPayload {
  sessionId: string;
  agentSignPubKey: string; // so the SW can build the deep link
}

export class PushService {
  constructor(private store: PushStore) {
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const sub = process.env.VAPID_SUBJECT || 'mailto:admin@localhost';
    if (pub && priv) {
      webpush.setVapidDetails(sub, pub, priv);
      console.log('[push] VAPID configured');
    } else {
      console.warn('[push] VAPID keys not set — push delivery disabled');
    }
  }

  get enabled() {
    return !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;
  }

  async notify(agentSignPubKey: string, payload: PushPayload): Promise<void> {
    if (!this.enabled) return;
    const subs = this.store.list(agentSignPubKey);
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    const opts: webpush.RequestOptions = {
      TTL: 300,
      topic: payload.sessionId.slice(0, 32), // RFC 8030: ≤32 URL-safe chars
    };

    const results = await Promise.allSettled(
      subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, opts))
    );

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const err = r.reason as { statusCode?: number };
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          this.store.removeByEndpoint(subs[i].endpoint);
        } else {
          console.error('[push] send error', err);
        }
      }
    });
  }
}
```

- [x] **Step 3: Verify compilation**

```
cd apps/relay && npx tsc --noEmit
```

---

### Task 5: Signature verification utility

**Files:**
- Create: `apps/relay/src/sigVerify.ts`
- Modify: `apps/relay/package.json` (add `tweetnacl`)

- [x] **Step 1: Install tweetnacl**

```bash
pnpm add tweetnacl --filter quicksave-relay
```

- [x] **Step 2: Create verifier**

Verifies that `body` was signed by the private key whose public key matches `agentSignPubKeyB64`, and that the request isn't a replay.

```typescript
// apps/relay/src/sigVerify.ts
import nacl from 'tweetnacl';

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(b64 + pad, 'base64'));
}

const seenNonces = new Map<string, number>(); // nonce -> expiry timestamp
const NONCE_TTL_MS = 2 * 60 * 1000; // 2 min

function gcNonces(now: number) {
  if (seenNonces.size < 1000) return;
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
}

export interface SignedRequest {
  timestamp: number; // unix ms
  nonce: string;     // client-generated, unique
  // plus task-specific fields
}

export function verifySignedBody(
  agentSignPubKeyB64: string,
  rawBody: Uint8Array,
  signatureB64: string,
  parsed: SignedRequest
): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  if (Math.abs(now - parsed.timestamp) > 60_000) {
    return { ok: false, reason: 'timestamp out of window' };
  }
  gcNonces(now);
  if (seenNonces.has(parsed.nonce)) {
    return { ok: false, reason: 'nonce replayed' };
  }
  const pub = b64urlToBytes(agentSignPubKeyB64);
  const sig = b64urlToBytes(signatureB64);
  if (pub.length !== 32 || sig.length !== 64) {
    return { ok: false, reason: 'bad key/sig length' };
  }
  if (!nacl.sign.detached.verify(rawBody, sig, pub)) {
    return { ok: false, reason: 'bad signature' };
  }
  seenNonces.set(parsed.nonce, now + NONCE_TTL_MS);
  return { ok: true };
}
```

- [x] **Step 3: Unit tests**

Cover: good signature accepted, tampered body rejected, replayed nonce rejected, stale timestamp rejected, malformed inputs rejected.

- [x] **Step 4: Verify compilation and tests**

---

### Task 6: HTTP routes for push

**Files:**
- Create: `apps/relay/src/pushRoutes.ts`
- Modify: `apps/relay/src/index.ts`

Two routes, both require `X-QS-Signature` header over the raw request body:

| Method + path | Body | Effect |
|---|---|---|
| `POST /push/{agentSignPubKey}/register`   | `{ subscription, timestamp, nonce }` | Add subscription |
| `POST /push/{agentSignPubKey}/unregister` | `{ endpoint, timestamp, nonce }`     | Remove one subscription |
| `POST /push/{agentSignPubKey}/notify`     | `{ sessionId, timestamp, nonce }`    | Send push to all subs for this agent |

- [x] **Step 1: Create pushRoutes.ts**

```typescript
// apps/relay/src/pushRoutes.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PushStore } from './pushStore.js';
import type { PushService } from './pushService.js';
import { verifySignedBody } from './sigVerify.js';

const MAX_BODY = 8 * 1024; // 8KB hard cap

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

function json(res: ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function makePushRouter(store: PushStore, service: PushService) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const m = req.url?.match(/^\/push\/([A-Za-z0-9_-]{16,128})\/(register|unregister|notify)$/);
    if (!m || req.method !== 'POST') return false;

    const [, agentSignPubKey, action] = m;
    const sig = req.headers['x-qs-signature'];
    if (typeof sig !== 'string') { json(res, 400, { error: 'missing signature' }); return true; }

    let raw: Uint8Array;
    try { raw = await readBody(req); }
    catch { json(res, 413, { error: 'body too large' }); return true; }

    let parsed: any;
    try { parsed = JSON.parse(new TextDecoder().decode(raw)); }
    catch { json(res, 400, { error: 'bad json' }); return true; }

    const v = verifySignedBody(agentSignPubKey, raw, sig, parsed);
    if (!v.ok) { json(res, 401, { error: v.reason }); return true; }

    switch (action) {
      case 'register': {
        const sub = parsed.subscription;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          json(res, 400, { error: 'bad subscription' }); return true;
        }
        store.register(agentSignPubKey, sub);
        json(res, 200, { ok: true }); return true;
      }
      case 'unregister': {
        if (typeof parsed.endpoint !== 'string') {
          json(res, 400, { error: 'missing endpoint' }); return true;
        }
        store.unregister(agentSignPubKey, parsed.endpoint);
        json(res, 200, { ok: true }); return true;
      }
      case 'notify': {
        if (typeof parsed.sessionId !== 'string') {
          json(res, 400, { error: 'missing sessionId' }); return true;
        }
        service.notify(agentSignPubKey, { sessionId: parsed.sessionId, agentSignPubKey })
          .catch((err) => console.error('[push] notify error', err));
        json(res, 202, { ok: true }); return true;
      }
    }
    return false;
  };
}
```

- [x] **Step 2: Wire into relay `index.ts`**

```typescript
// apps/relay/src/index.ts — additions
import { PushStore } from './pushStore.js';
import { PushService } from './pushService.js';
import { makePushRouter } from './pushRoutes.js';

const pushStore = new PushStore(process.env.PUSH_STORE_PATH || null);
const pushService = new PushService(pushStore);
const pushRouter = makePushRouter(pushStore, pushService);

// Inside onHttpRequest, before `next()`:
if (req.url?.startsWith('/push/')) {
  const handled = await pushRouter(req, res);
  if (handled) return;
}

// In /stats output, add: pushStore: pushStore.stats
```

Also: **remove the old `push:subscribe` / `push:unsubscribe` / `notify-push` WebSocket handlers** if they exist from prior plan iterations — this plan replaces them entirely.

- [x] **Step 3: Integration test**

Spin up the relay in a test, register a subscription with a valid sig from a generated keypair, verify it shows in stats, then notify with a mocked `web-push` to assert the fan-out.

- [x] **Step 4: Verify compilation and tests**

---

### Task 7: Custom service worker

**Files:**
- Create: `apps/pwa/src/sw.ts`
- Modify: `apps/pwa/vite.config.ts`

The notification is **intentionally generic** — all pushes for the same session collapse to one notification via the `tag`, and the title doesn't try to explain *why*, just *where* (which session).

- [x] **Step 1: Create custom service worker**

```typescript
// apps/pwa/src/sw.ts
/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload: { sessionId: string; agentSignPubKey: string };
  try { payload = event.data.json(); } catch { return; }
  if (!payload?.sessionId) return;

  const shortId = payload.sessionId.slice(0, 8);
  const options: NotificationOptions = {
    body: 'Tap to open this session',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: `qs-session-${payload.sessionId}`, // collapse older pushes for same session
    renotify: true,
    data: {
      url: `/?agent=${encodeURIComponent(payload.agentSignPubKey)}&session=${encodeURIComponent(payload.sessionId)}`,
    },
    requireInteraction: true, // keep it on screen until user acts
  };

  event.waitUntil(
    self.registration.showNotification(`Session ${shortId} needs your attention`, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes(self.location.origin)) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
```

- [x] **Step 2: Update vite.config.ts to use injectManifest**

Replace the existing `VitePWA({...})` config:

```typescript
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  registerType: 'autoUpdate',
  injectRegister: 'auto',
  includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
  manifest: {
    name: 'Quicksave', short_name: 'Quicksave',
    description: 'Remote git control with E2E encryption',
    theme_color: '#0f172a', background_color: '#0f172a',
    display: 'standalone', orientation: 'portrait',
    icons: [
      { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  },
  injectManifest: { globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'] },
}),
```

- [x] **Step 3: Install workbox-precaching**

```bash
pnpm add workbox-precaching --filter quicksave-pwa
```

- [x] **Step 4: Verify PWA builds**

```
cd apps/pwa && npx vite build
```

---

### Task 8: PWA push subscription management

**Files:**
- Create: `apps/pwa/src/lib/pushSubscription.ts`
- Modify: `packages/shared/src/types.ts` (add `push-subscription-offer` E2E message)

The PWA's only push-related network call is to the browser (`pushManager.subscribe`). Once it has a `PushSubscription`, it sends it **over the existing E2E WebSocket channel** to the agent — never directly to the relay's push HTTP routes.

- [x] **Step 1: Add shared message type**

```typescript
// packages/shared/src/types.ts
export interface PushSubscriptionOfferMessage {
  type: 'push-subscription-offer';
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}
```

This is sent inside the E2E-encrypted envelope, just like other session messages.

- [x] **Step 2: Create pushSubscription.ts**

```typescript
// apps/pwa/src/lib/pushSubscription.ts
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const std = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = window.atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  return Notification.requestPermission();
}

export function getNotificationPermission(): NotificationPermission {
  if (!('Notification' in window)) return 'denied';
  return Notification.permission;
}

export async function ensurePushSubscription(): Promise<PushSubscription | null> {
  if (!VAPID_PUBLIC_KEY || !('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) return sub;
  try {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    return sub;
  } catch (err) {
    console.error('[push] subscribe failed', err);
    return null;
  }
}

export function toJSON(sub: PushSubscription) {
  const j = sub.toJSON();
  return { endpoint: j.endpoint!, keys: { p256dh: j.keys!.p256dh!, auth: j.keys!.auth! } };
}
```

- [x] **Step 3: Forward subscription to agent on connect**

In the WebSocket connection setup (where the PWA completes key-exchange and sends `watch-agent`), add — only if notification permission is `granted`:

```typescript
import { ensurePushSubscription, getNotificationPermission, toJSON } from './pushSubscription';

// after key-exchange + watch-agent succeed:
if (getNotificationPermission() === 'granted') {
  const sub = await ensurePushSubscription();
  if (sub) {
    connection.sendEncrypted({
      type: 'push-subscription-offer',
      subscription: toJSON(sub),
    });
  }
}
```

Re-offering on every connect is cheap (agent's register call is idempotent — it upserts by endpoint) and handles the case where the browser rotated the subscription.

- [x] **Step 4: Verify types**

```
cd apps/pwa && npx tsc --noEmit
```

---

### Task 9: Agent-side push client + PWA offer handler

**Files:**
- Create: `apps/agent/src/service/pushClient.ts`
- Modify: `apps/agent/src/handlers/messageHandler.ts`

The agent owns all HTTP calls to the relay's `/push/*` routes. `pushClient` signs bodies with `identity.signSecretKey` and POSTs them.

- [x] **Step 1: Create pushClient.ts**

```typescript
// apps/agent/src/service/pushClient.ts
import nacl from 'tweetnacl';
import { randomBytes } from 'node:crypto';
import type { AgentIdentity } from '../identity.js';

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class PushClient {
  private readonly signPubKeyUrl: string;

  constructor(
    private identity: AgentIdentity,
    private relayBaseUrl: string,
  ) {
    this.signPubKeyUrl = b64url(identity.signPublicKey);
  }

  private async signedPost(path: string, body: Record<string, unknown>): Promise<void> {
    const fullBody = { ...body, timestamp: Date.now(), nonce: b64url(randomBytes(16)) };
    const raw = new TextEncoder().encode(JSON.stringify(fullBody));
    const sig = nacl.sign.detached(raw, this.identity.signSecretKey);

    const res = await fetch(`${this.relayBaseUrl}/push/${this.signPubKeyUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-QS-Signature': b64url(sig),
      },
      body: raw,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[push] ${path} ${res.status}: ${text}`);
    }
  }

  register(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return this.signedPost('/register', { subscription });
  }

  unregister(endpoint: string) {
    return this.signedPost('/unregister', { endpoint });
  }

  notify(sessionId: string) {
    return this.signedPost('/notify', { sessionId });
  }
}
```

- [x] **Step 2: Handle `push-subscription-offer` from PWA**

In `messageHandler.ts`, add a branch for the new message type. Call `pushClient.register(msg.subscription)` — fire-and-forget; failures are logged, not surfaced to the PWA (the PWA will re-offer on next connect).

- [x] **Step 3: Verify compilation and tests**

```
cd apps/agent && npx tsc --noEmit && npx vitest run
```

---

### Task 10: Trigger push from agent events

**Files:**
- Modify: `apps/agent/src/service/run.ts`

Two triggers; both check "no PWA currently watching this session" before calling `pushClient.notify()`.

- [x] **Step 1: Trigger on user-input-request**

```typescript
claudeService.on('user-input-request', (request) => {
  const msg = createMessage('claude:user-input-request', request);
  const sent = connection.sendToSession(request.sessionId, msg);
  if (sent === 0) pushClient.notify(request.sessionId);
});
```

- [x] **Step 2: Trigger on card-stream-end (session idle)**

```typescript
claudeService.on('card-stream-end', (result) => {
  if (connection.hasListenersForSession(result.sessionId)) return;
  // Skip if this end is because the agent is awaiting user input (step 1 handles that).
  if (result.endReason === 'awaiting_user_input') return;
  pushClient.notify(result.sessionId);
});
```

- If `card-stream-end` does not currently carry `endReason` or equivalent, extend `sessionManager.ts` in this same task to add it — otherwise we will double-fire on permission prompts (once from step 1, once from step 2), and the collapsing `topic` will hide it but the push still costs a round-trip.

- [x] **Step 3: Verify compilation and tests**

---

### Task 11: Notification permission UI

**Files:**
- Create: `apps/pwa/src/components/NotificationPrompt.tsx`

A banner that shows when notifications aren't enabled yet, inside the coding session view.

- [x] **Step 1: Create NotificationPrompt component**

```typescript
import { useState, useEffect } from 'react';
import {
  getNotificationPermission,
  requestNotificationPermission,
  ensurePushSubscription,
  toJSON,
} from '../lib/pushSubscription';

export function NotificationPrompt({ onSubscribed }: {
  onSubscribed?: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => void;
}) {
  const [permission, setPermission] = useState(getNotificationPermission());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('qs-notif-dismissed')) setDismissed(true);
  }, []);

  if (permission === 'granted' || permission === 'denied' || dismissed) return null;
  if (!('Notification' in window)) return null;

  const handleEnable = async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
      const sub = await ensurePushSubscription();
      if (sub) onSubscribed?.(toJSON(sub));
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem('qs-notif-dismissed', '1');
  };

  return (
    <div className="mx-4 mb-3 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg flex items-center gap-3">
      <div className="flex-1">
        <p className="text-sm text-blue-300">Enable notifications to get alerted when a session needs you</p>
      </div>
      <button onClick={handleEnable} className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 rounded-md text-white transition-colors">
        Enable
      </button>
      <button onClick={handleDismiss} className="p-1 text-slate-500 hover:text-slate-400">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
```

- [x] **Step 2: Mount NotificationPrompt in ClaudePanel**

Place above the message input. The `onSubscribed` callback should piggyback on the existing E2E connection helper to send a `push-subscription-offer` — so the first-time subscribe doesn't wait for the next reconnect.

---

## Execution Order

1. **Task 1** — VAPID keys (manual, prerequisite)
2. **Task 2** — Agent signing keypair (blocks 9, 10; enables 6 integration tests)
3. **Task 3** — PushStore (relay, no deps)
4. **Task 4** — PushService (relay, depends on 3)
5. **Task 5** — Signature verification (relay, no deps)
6. **Task 6** — HTTP routes (depends on 3, 4, 5)
7. **Task 7** — Custom SW (PWA, independent)
8. **Task 8** — PWA push lib (PWA, depends on 7)
9. **Task 9** — Agent push client + offer handler (depends on 2, 6)
10. **Task 10** — Agent triggers (depends on 9)
11. **Task 11** — Permission UI (depends on 8)

Tasks 3/4/5/6 (relay) and 7/8 (PWA) can run in parallel. Task 2 (agent keypair + pairing) unblocks the agent work and should start early because it also touches PWA pairing code.

---

## Testing

- **Relay unit**: `pushStore.test.ts`, `sigVerify.test.ts`, `pushRoutes.test.ts` (mock `web-push`).
- **Agent unit**: `pushClient.test.ts` — assert correct HTTP body + signature for a known keypair.
- **End-to-end local dev**:
  1. Run relay with VAPID env set. `PUSH_STORE_PATH=./data/push-store.json`.
  2. Run agent; pair a PWA; enable notifications in PWA; accept prompt.
  3. Confirm relay logs `[push] register` and `pushStore.stats.subscriptions === 1`.
  4. Close the PWA tab. From another machine or same host, trigger a permission request in a session (e.g. agent runs a shell command that requires approval).
  5. Notification appears. Click it → PWA opens on that session.
  6. Kill relay, restart — subscriptions reload from `./data/push-store.json`; the flow still works even if the agent restarts.
- **iOS**: must be installed to home screen. Test on real device — web-push simulators don't work.
- **DevTools**: Chrome DevTools → Application → Service Workers → Push accepts a raw payload (JSON matching `{sessionId, agentSignPubKey}`) for SW-only testing.

---

## Security Notes

- Relay's push HTTP routes are fully signature-authenticated; no URL-trust. A peer cannot register or trigger for another agent's `agentSignPubKey` without the corresponding private key.
- The WebSocket `/agent/{agentId}` and `/pwa/{pubKey}` endpoints **still have the pre-existing URL-trust issue** (anyone who knows the public identifier can squat an agent slot or replace a real PWA, yielding DoS). This is out of scope for this plan and tracked separately in `docs/plans/2026-04-18-relay-connect-auth.md`. Push is immune to it because push routes are signed HTTP, not URL-identified WebSocket. The Ed25519 signing keypair added in Task 2 is also the key material that future work will reuse.
- Payload contents (`{sessionId, agentSignPubKey}`) are not sensitive — they only tell the receiver which session to open. Any attacker who somehow intercepts the Web Push payload (between relay and FCM/APNs, or between vendor and device) learns at most timing + `sessionId`. No message content leaves the relay.
- The SW deep link uses `agentSignPubKey` (not `agentId`) so the PWA must be able to resolve it to a paired machine. PWAs paired before Task 2 lack that field and should re-pair — the UI surfaces this (Task 2 step 4).
- `tag: qs-session-${sessionId}` collapses multiple pushes for the same session to a single notification. `requireInteraction: true` keeps the notification until the user dismisses or clicks — important for "agent is waiting" semantics.
