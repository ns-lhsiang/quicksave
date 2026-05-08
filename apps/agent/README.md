# @sumicom/quicksave — desktop agent

Background daemon that runs on your development machine and connects
your Quicksave PWA (phone or browser) to your coding-agent CLI sessions
and the local git working tree. All communication is end-to-end
encrypted; the relay server never sees plaintext.

## Prerequisites

Quicksave drives a coding-agent CLI on your `$PATH`. Install one (or
both) and sign in first:

```bash
# Claude Code (Anthropic) — https://code.claude.com/docs/en/setup
curl -fsSL https://claude.ai/install.sh | bash
claude   # follow login prompts

# Codex (OpenAI) — https://github.com/openai/codex#readme
npm install -g @openai/codex
codex    # follow login prompts
```

You also need Node.js 20+ and `git`.

## Install

```bash
npm install -g @sumicom/quicksave
```

## Quick start

```bash
cd /path/to/your/repo
quicksave
```

On first run this prints a pairing URL and QR code. Scan it from the
[Quicksave PWA](http://localhost:5173) to connect.

The CLI auto-launches a background daemon (`quicksave service run`) and
then exits. The daemon keeps running; future `quicksave` invocations
just attach to it to add repos or re-read pairing info.

## More

- **CLI subcommands, debug commands, data layout** —
  [`docs/references/agent-cli.md`](../../docs/references/agent-cli.md)
- **Architecture (sessions, MessageBus, permissions, IPC)** —
  [`docs/references/quicksave-architecture.en.md`](../../docs/references/quicksave-architecture.en.md)
- **Local development** —
  [`docs/development.md`](../../docs/development.md)
