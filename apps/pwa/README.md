# quicksave-pwa

React PWA for controlling a remote [`@sumicom/quicksave`](../agent/README.md)
agent from a phone or browser. Review diffs, stage / unstage files, commit,
and drive Claude Code CLI sessions — all end-to-end encrypted.

Hosted build lives at [localhost](http://localhost:5173). This package
is the source for that deployment.

## Stack

- React 18 + TypeScript, Vite 5, Tailwind 3
- [Zustand](https://zustand-demo.pmnd.rs/) for state (`claudeStore`, `gitStore`, `connectionStore`, `identityStore`)
- [`@sumicom/quicksave-message-bus`](../../packages/message-bus/README.md) for RPC + subscriptions over the encrypted WebSocket channel
- [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/) + custom `sw.ts` (Workbox injectManifest) for offline support and Web Push
- React Router 7 for navigation

## Development

```bash
# from monorepo root
pnpm dev                           # vite dev server on :5173 (default)
pnpm --filter quicksave-pwa test   # vitest
pnpm --filter quicksave-pwa test:e2e  # playwright
```

By default the PWA targets the production relay. To point at a locally
running relay:

```bash
QUICKSAVE_SIGNALING_URL=ws://localhost:8080 pnpm dev:pwa
```

For testing on a real phone over HTTPS, a cloudflared tunnel is pre-wired
to `localhost:5173`:

```bash
cloudflared tunnel run --url http://localhost:5173 quicksave-dev-tunnel
```

## Build

```bash
# production build against default relay
pnpm build:pwa

# or point at a custom relay at build time
QUICKSAVE_SIGNALING_URL=wss://your-relay.example.com pnpm build:pwa
```

Output is in `dist/`, deployable to any static host (Cloudflare Pages,
Netlify, S3, nginx).

## Source layout

```
src/
├── App.tsx               # top-level router + auth / pairing gate
├── main.tsx              # entry; mounts React + registers service worker
├── sw.ts                 # service worker (push + offline cache)
├── components/           # UI components (ClaudePanel, CommitForm, DiffViewer, ...)
│   ├── chat/             # chat cards (UserCard, AssistantTextCard, ToolCallCard, ...)
│   ├── settings/         # settings pages
│   └── ui/               # primitives
├── hooks/                # useClaudeOperations, useGitOperations, useProjects, ...
├── lib/                  # transport (busClientTransport, websocket), sync, crypto helpers
└── stores/               # zustand stores
```

## Architecture

See [`docs/references/quicksave-architecture.en.md`](../../docs/references/quicksave-architecture.en.md)
for the end-to-end picture: MessageBus paths the PWA subscribes to,
session / card reconciliation, push subscription flow.

## License

MIT
