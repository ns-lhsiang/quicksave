# Deployment

## Configuration

| Variable | Default | Source | Description |
|----------|---------|--------|-------------|
| `PORT` | `8080` | `process.env.PORT` | HTTP/WebSocket listen port (public) |
| `METRICS_PORT` | `9090` | `process.env.METRICS_PORT` | Prometheus admin port (set `0` to disable) |
| `METRICS_HOST` | `127.0.0.1` | `process.env.METRICS_HOST` | Bind address for the metrics admin server |
| `HEARTBEAT_INTERVAL` | 30,000 ms | Hardcoded | WebSocket ping interval |
| `RATE_LIMIT_WINDOW` | 60,000 ms | Hardcoded | Sliding window for rate limiting |
| `RATE_LIMIT_MAX_CONNECTIONS` | 10 | Hardcoded | Max new connections per IP per window |
| `RATE_LIMIT_MAX_MESSAGES` | 100 | Hardcoded | Max messages per connection per window |
| `SyncStore.maxBlobSize` | 8,192 bytes | Hardcoded | Max size for a single sync blob |
| `VERSION` | from `package.json` | Build-time inject | Server version string |

`PORT`, `METRICS_PORT`, and `METRICS_HOST` are runtime-configurable via environment variables. All other values are hardcoded constants.

## Rate Limiting

Two independent layers protect the server:

### Connection Rate Limiting (per-IP)

- Tracked by `RateLimiter` class
- Sliding window: 10 connections per IP per 60-second window
- On rejection: sends `error {code: RATE_LIMITED}` and closes with WebSocket close code `1008`
- Periodic cleanup removes expired IP entries

### Message Rate Limiting (per-connection)

- Tracked inline on each `ExtendedWebSocket`
- Window: 100 messages per connection per 60-second window
- Window resets lazily when the next message arrives after expiry
- On rejection: sends `error {code: RATE_LIMITED}` but does NOT close the connection (message is dropped)

## Build

```bash
cd apps/relay

# Development (watch mode)
npm run dev

# Production build
npm run build    # tsc + esbuild → dist/bundle.cjs

# Run tests
npx vitest run

# Start production
npm start        # node dist/bundle.cjs
```

The build script (`build.mjs`) uses esbuild to produce a single CommonJS bundle with the version string injected as a compile-time constant.

## Prometheus metrics

The relay exposes a Prometheus exposition endpoint at `/metrics` on a separate
**admin** HTTP server. By default it binds to `127.0.0.1:9090` so the public
WebSocket / sync port (`8080`) is never used to serve internal counters.

### Scraping

Run Prometheus inside the same trust boundary as the relay (Tailscale tail
network, VPC, SSH tunnel) and point it at `http://<relay-host>:9090/metrics`.
Example scrape config:

```yaml
scrape_configs:
  - job_name: quicksave-relay
    static_configs:
      - targets: ['<relay-host-on-tailnet>:9090']
```

If you need to expose the metrics port on a real interface, set
`METRICS_HOST=0.0.0.0` **and** lock it down at the firewall. Never reverse-proxy
`/metrics` through the same vhost as the public routes.

### Metric inventory

Process-level metrics (heap, GC, event loop lag, file descriptors, …) are
exposed under the `relay_` prefix via `prom-client`'s default collector.

Application metrics:

| Name | Type | Labels | Description |
|------|------|--------|-------------|
| `relay_uptime_seconds` | gauge | — | Seconds since the relay started |
| `relay_ws_connections_total` | counter | `channel` | WebSocket peers that connected |
| `relay_ws_disconnections_total` | counter | `channel` | WebSocket peers that disconnected |
| `relay_ws_connections_active` | gauge | `channel` | Currently connected peers |
| `relay_ws_connection_duration_seconds` | histogram | `channel` | Peer session duration, observed at disconnect |
| `relay_messages_relayed_total` | counter | — | Frames forwarded between peers (cumulative) |
| `relay_http_requests_total` | counter | `route`, `method`, `status_class` | Public HTTP requests handled |
| `relay_http_request_duration_seconds` | histogram | `route`, `status_class` | Public HTTP request latency |
| `relay_rate_limit_hits_total` | counter | `route` | HTTP requests rejected by the per-IP rate limiter |
| `relay_sync_blobs` | gauge | — | Live (non-tombstone) entries in the sync store |
| `relay_sync_tombstones` | gauge | — | Tombstone entries in the sync store |
| `relay_sync_locks_active` | gauge | — | Active per-mailbox write locks |
| `relay_pair_mailboxes` | gauge | — | Active pairing mailboxes |
| `relay_pair_slots` | gauge | — | Total slots across pairing mailboxes |
| `relay_pair_subscribers` | gauge | — | Active SSE subscribers across pairing mailboxes |
| `relay_pair_post_errors_total` | counter | `reason` | Pair POSTs rejected (`full`, `too_large`) |
| `relay_tombstone_subscribed_keys` | gauge | — | keyHashes with at least one tombstone subscriber |
| `relay_tombstone_subscribers` | gauge | — | Total tombstone subscribers across all keys |
| `relay_push_agents` | gauge | — | Distinct agent keys with at least one Web Push subscription (only if VAPID is configured) |
| `relay_push_subscriptions` | gauge | — | Total Web Push subscriptions (only if VAPID is configured) |
| `relay_push_verify_failures_total` | counter | `reason` | Signature verification failures on `/push/*` |
| `relay_push_notifications_total` | counter | `outcome` | Web Push send results (`sent`, `pruned`, `failed`) |
| `relay_message_size_bytes` | histogram | `channel` | Per-frame size for forwarded messages |
| `relay_messages_by_channel_total` | counter | `channel` | Frames forwarded, by source channel |
| `relay_connection_messages` | histogram | `channel` | Frames a peer sent during one WS session, observed at disconnect |
| `relay_connection_bytes` | histogram | `channel` | Bytes a peer sent+received during one WS session, observed at disconnect |
| `relay_reconnects_total` | counter | `channel` | WS connects whose peer ID disconnected within the last 60s |
| `relay_sync_writes_total` | counter | `kind` | Successful sync writes (`blob`, `tombstone`) |
| `relay_sync_store_bytes` | gauge | — | Total bytes of ciphertext stored in the sync store |
| `relay_pair_mailbox_outcomes_total` | counter | `outcome` | Pair-mailbox lifecycle outcomes (`deleted`, `expired_with_slots`, `expired_empty`) |
| `relay_devices_per_agent` | histogram | — | Distinct PWA peers watching one agent. One sample per agent per hourly tick |
| `relay_active_keys` | gauge | `window` | Distinct keys (PWA pubkey or agent ID) with activity in the trailing window (`24h`, `7d`, `30d`) |
| `relay_key_bandwidth_bytes` | histogram | — | Bytes attributed to a single key over one rollup window. One sample per active key per hour |
| `relay_key_messages` | histogram | — | Messages attributed to a single key over one rollup window. One sample per active key per hour |

The `route` label is normalised to a fixed enum (`health`, `stats`, `metrics`,
`sync_blob`, `sync_tombstone`, `sync_lock`, `pair`, `pair_subscribe`,
`push_register`, `push_unregister`, `push_notify`, `other`) so per-user
identifiers in URLs never become labels.

`relay_active_keys` and `relay_key_*` are the closest the relay gets to
"DAU"-style analytics. Per-key labels are deliberately avoided — instead, one
sample per active key is observed into the histograms at each hourly rollup
tick, so distributions (p50/p99 bytes, etc.) are recoverable while cardinality
remains bounded.

## Graceful Shutdown

The server handles both `SIGINT` and `SIGTERM`:

1. Close the metrics admin server (if started)
2. Close the WebSocket server (stops accepting new connections)
3. Close the HTTP server
4. Exit the process

In-memory state (connections, sync store) is lost on shutdown — this is by design. Clients are expected to reconnect and re-establish state.

## Docker

The Dockerfile sets `NODE_ENV=production` and exposes port 8080. The entrypoint runs the bundled output directly with Node.

## Infrastructure Notes

- **No persistence**: All state is in-memory. Server restarts clear everything.
- **Single process**: No clustering or worker threads. Scale horizontally by running multiple instances behind a load balancer (with sticky sessions for WebSocket connections).
- **TLS**: Expected to run behind a reverse proxy (nginx, Cloudflare, etc.) that terminates TLS.
- **CORS**: All HTTP endpoints allow `*` origin — the server is designed to be called from any browser context.
- **IP detection**: Respects `X-Forwarded-For` header for rate limiting, so it works correctly behind proxies.
