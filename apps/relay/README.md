# quicksave-relay

Stateless WebSocket relay that brokers traffic between Quicksave agents
and PWA clients. Performs **no encryption and no authentication** — all
security is end-to-end between the two endpoints. The relay is a dumb
forwarder plus a small in-memory sync store and optional Web Push fan-out.

Built on [`@sumicom/ws-relay`](https://www.npmjs.com/package/@sumicom/ws-relay);
Quicksave-specific behaviour is added through its hook API.

## Responsibilities

- Route encrypted frames between `agent/{agentId}` and `pwa/{publicKey}` WebSocket peers.
- Serve `/sync/{keyHash}` HTTP endpoints for encrypted blob sync (agent config replication between PWA instances). Tombstones are permanent.
- Serve `/push/{signPubKey}/{register|unregister|notify}` HTTP endpoints so agents can fan out Web Push notifications to subscribed PWA endpoints. Enabled only if `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` are set.
- Emit `agent-status` messages to PWAs watching a specific agent when it connects or disconnects.
- Expose `/health` and `/stats` on the public port.
- Expose Prometheus `/metrics` on a separate **admin** port (loopback by default — scrape via Tailscale, VPC, or SSH tunnel).

## Run locally

```bash
# from monorepo root
pnpm dev:relay                      # tsx watch on :8080
PORT=3001 pnpm dev:relay            # custom port
```

## Production build

```bash
pnpm --filter quicksave-relay build
node apps/relay/dist/bundle.cjs     # esbuild-bundled single file
```

Or via Docker:

```bash
docker build -f apps/relay/Dockerfile -t quicksave-relay .
docker run -p 8080:8080 quicksave-relay
```

The relay speaks plain HTTP / WebSocket. Put it behind a TLS-terminating
reverse proxy (nginx, Caddy, Cloudflare) for production.

## Environment variables

| Variable              | Default        | Purpose                                       |
| --------------------- | -------------- | --------------------------------------------- |
| `PORT`                | `8080`         | HTTP + WebSocket port                         |
| `METRICS_PORT`        | `9090`         | Prometheus admin port (set `0` to disable)    |
| `METRICS_HOST`        | `127.0.0.1`    | Bind address for the metrics admin server     |
| `VAPID_PUBLIC_KEY`    | unset          | Enables push routes (must be set with private key) |
| `VAPID_PRIVATE_KEY`   | unset          | VAPID private key for Web Push                |
| `VAPID_SUBJECT`       | `mailto:admin@localhost` | VAPID subject (email or URL)    |
| `PUSH_STORE_PATH`     | in-memory only | Optional JSON snapshot path for push subscriptions |

`METRICS_HOST` defaults to `127.0.0.1` so `/metrics` is **not** reachable from
the public internet. Scrape it from inside your trust boundary (Tailscale tail
network, VPC peer, SSH tunnel). If you need it on a real interface, set
`METRICS_HOST=0.0.0.0` and lock it down at the firewall — never share a port
with the public WebSocket / sync routes.

## Full documentation

The long-form protocol, security, deployment, and API docs live under
[`docs/relay/`](../../docs/relay/README.md):

| Doc                                           | Contents                                     |
| --------------------------------------------- | -------------------------------------------- |
| [`docs/relay/README.md`](../../docs/relay/README.md)       | Overview + architecture                     |
| [`docs/relay/protocol.md`](../../docs/relay/protocol.md)   | WebSocket URL patterns, message shapes      |
| [`docs/relay/connections.md`](../../docs/relay/connections.md) | Connection lifecycle, heartbeat, pairing  |
| [`docs/relay/api.md`](../../docs/relay/api.md)             | Health, stats, sync store HTTP endpoints    |
| [`docs/relay/security.md`](../../docs/relay/security.md)   | E2E crypto, signed push routes, replay guards |
| [`docs/relay/deployment.md`](../../docs/relay/deployment.md) | Rate limiting, graceful shutdown, config    |

## License

MIT
