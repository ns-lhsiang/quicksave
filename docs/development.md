# Development

Local setup for hacking on Quicksave's apps and packages.

## Prerequisites

- Node.js 20+
- pnpm 9+
- A coding-agent CLI on `$PATH` (Claude Code or Codex) — only needed if
  you want to drive sessions while running the agent locally.
- `git`

## Setup

```bash
pnpm install              # installs everything + sets up git hooks
```

The `prepare` script wires up `core.hooksPath` so the pre-push hook runs
clean-worktree build+test on protected branches and a fast local
build+test on others.

## Running locally

```bash
pnpm dev                  # vite dev server (PWA) on :5173
pnpm dev:relay            # standalone relay on :8080
pnpm dev:agent -- --repo /path/to/repo -s ws://localhost:8080
```

## Per-app commands

```bash
# Agent
pnpm --filter @sumicom/quicksave dev              # tsx watch
pnpm --filter @sumicom/quicksave test             # vitest
pnpm --filter @sumicom/quicksave build            # tsc

# Everything
pnpm test                 # run all test suites (alias for `pnpm -r test`)
pnpm test:e2e             # run cross-package e2e suite (vitest.e2e.config.ts)
pnpm typecheck            # typecheck everything (alias for `pnpm -r typecheck`)
pnpm build                # build everything (alias for `pnpm -r build`)
```

## Restarting the agent from source

`scripts/dev-daemon.sh` kills the running daemon and respawns it from
your local source via `tsx`:

```bash
./scripts/dev-daemon.sh
```

If you're running inside a Claude CLI that the daemon spawned (typical
when Claude is assisting you through Quicksave itself), the plain script
will kill your own parent and terminate your conversation mid-stream.
Use the delayed variant — it schedules the restart in a detached session
so the current turn can finish and reply first:

```bash
./scripts/dev-daemon-delayed.sh 30   # restart in 30 seconds
```

`setsid` detaches the scheduler into a new process group, so SIGTERM to
the old daemon doesn't propagate to it. Progress is logged to
`~/.quicksave/run/dev-daemon-delayed.log`.

## Dev tunneling

To expose your local Vite dev server with a stable hostname for
mobile-device testing:

```bash
cloudflared tunnel run --url http://localhost:5173 quicksave-dev-tunnel
```

Routes `localhost:5173` to local `localhost:5173`.

For an ad-hoc tunnel without a pre-configured Cloudflare hostname, the
PWA package exposes an ngrok-based shortcut that boots Vite and an ngrok
tunnel together:

```bash
pnpm --filter quicksave-pwa dev:tunnel
```
