# Quicksave

Remote-control your dev machine from a phone. Drive coding-agent CLI
sessions, review diffs, stage, and commit — end-to-end encrypted, with a
relay in the middle that can't read your code.

## How it works

```
┌────────────┐    WebSocket    ┌───────────┐    WebSocket    ┌──────────────┐
│  PWA       │ ◄─────────────► │  Relay    │ ◄─────────────► │  Agent       │
│ (browser)  │   (encrypted)   │ (blind)   │   (encrypted)   │ (your laptop)│
└────────────┘                 └───────────┘                 └──────────────┘
```

- **PWA** — React app (`apps/pwa`), hosted at [localhost](http://localhost:5173) or self-hostable.
- **Agent** — Node.js daemon (`apps/agent`), installed globally via `npm install -g @sumicom/quicksave`. Manages coding-agent sessions, runs git, holds the NaCl keys.
- **Relay** — Minimal Node server (`apps/relay`). Routes encrypted frames, serves an encrypted sync mailbox, fans out Web Push. Holds no keys, no plaintext, no user identifiers.

All three endpoints share a small set of TypeScript packages:

- [`@sumicom/quicksave-shared`](./packages/shared) — wire types, NaCl crypto, card model
- [`@sumicom/quicksave-message-bus`](./packages/message-bus) — command + subscribe RPC over any transport

## Quick start

### 1. Install a coding-agent CLI and sign in

Pick whichever you prefer — Quicksave drives whichever one is on
`$PATH`.

```bash
# Claude Code (Anthropic) — full setup at https://code.claude.com/docs/en/setup
curl -fsSL https://claude.ai/install.sh | bash
claude   # follow login prompts

# Codex (OpenAI) — full setup at https://github.com/openai/codex#readme
npm install -g @openai/codex
codex    # follow login prompts
```

### 2. Install the Quicksave agent on your dev machine

```bash
npm install -g @sumicom/quicksave
cd /path/to/your/repo
quicksave
```

Requires Node.js 20+ and `git`. Prints a pairing URL and QR code; keeps
a background daemon running.

### 3. Connect the PWA

Open [localhost](http://localhost:5173) on your phone and scan the
QR code. Everything from this point on is end-to-end encrypted.

## Monorepo layout

```
apps/
├── agent/        # Desktop daemon (npm: @sumicom/quicksave)
├── pwa/          # React PWA
└── relay/        # WebSocket relay server
packages/
├── shared/       # (npm: @sumicom/quicksave-shared)
└── message-bus/  # (npm: @sumicom/quicksave-message-bus)
site/             # Marketing landing page (GitHub Pages)
docs/             # Architecture, guidelines, references
```

Each `apps/*` and `packages/*` has its own README with package-specific
details.

## Architecture & deeper docs

- **Source-of-truth architecture** — [`docs/references/quicksave-architecture.en.md`](./docs/references/quicksave-architecture.en.md):
  session lifecycle, MessageBus paths, encryption handshake, Web Push
  side channel, IPC / debug CLI.
- **Agent CLI reference** — [`docs/references/agent-cli.md`](./docs/references/agent-cli.md)
- **Local development** — [`docs/development.md`](./docs/development.md)
- **Self-hosting the relay** — [`apps/relay/README.md`](./apps/relay/README.md)
  + [`docs/relay/deployment.md`](./docs/relay/deployment.md)
- **Engineering guidelines index** — [`docs/guidelines.md`](./docs/guidelines.md)

## License

MIT
