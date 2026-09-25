# Operations

Running, observing, backing up and recovering the Life Manager server (SPEC §8).

The server is **one process, one replica, and TLS-unaware**. It terminates
nothing, shares nothing, and holds live collaboration state, cron and hot
documents in memory. Every operational decision below follows from that: a
deploy drops all connections, a second replica is not a scaling option, and the
database is the only durable thing.

- [Quick reference](#quick-reference)
- [Running it](#running-it)
- [Configuration](#configuration)
- [Health and readiness](#health-and-readiness)
- [Metrics](#metrics)
- [Logs](#logs)
- [Deploys and graceful shutdown](#deploys-and-graceful-shutdown)
- [Migrations and upgrades](#migrations-and-upgrades)
- [Backup](#backup)
- [Restore](#restore)
- [Secret rotation](#secret-rotation)
- [Break-glass password reset](#break-glass-password-reset)
- [Runbook](#runbook)

## Quick reference

| | |
|---|---|
| Liveness | `GET /healthz` — 200 `ok`, never touches Mongo |
| Readiness | `GET /readyz` — 200/503 with a JSON detail body |
| Metrics | `GET /metrics` — Prometheus text, **unauthenticated** |
| Logs | JSON on stdout, one object per event, `request_id` on every request line |
| Shutdown | SIGTERM → drain → flush → exit, hard deadline `SHUTDOWN_GRACE_SECS` (30 s) |
| Data | MongoDB: documents, CRDT state, sessions, audit log, GridFS attachments |
| Backup | `mongodump` of the whole database (GridFS included) |
| Break-glass | `life-manager reset-password --email …` |

## Running it

### Local / self-host: Docker Compose

```bash
cp .env.example .env          # then put a real SESSION_SECRET in it
openssl rand -base64 48       # ← paste into SESSION_SECRET
docker compose up --build -d
docker compose logs -f server
```

Compose publishes the server on `SERVER_PORT` (8080) and mongo on
`127.0.0.1:MONGO_PORT`. Mongo has **no authentication** — it is loopback-only on
purpose. Do not move that binding to `0.0.0.0`.

Caddy (automatic HTTPS) is deliberately not in M1: the server is TLS-unaware and
there is no PWA bundle to serve yet. The commented block at the end of
`docker-compose.yaml` is the M3 shape. Until then, a browser client over plain
HTTP needs `COOKIE_SECURE=false`; anything reachable from outside localhost wants
a TLS-terminating proxy in front of it.

### Development

```bash
mise run dev       # mongo in docker (waits for healthy), server on the host
mise run check     # fmt --check + cargo check + clippy -D warnings
mise run test      # cargo test --workspace --all-targets
mise run build     # release binary, same profile as the image
mise run logs      # tail the compose server logs
mise run backup    # timestamped mongodump into ./backups
```

### Production: Kubernetes

Explicitly single-replica (SPEC §8):

- `replicas: 1`, `strategy: Recreate` — never two processes on one database.
  Rolling updates would have two servers owning the same hot documents.
- `terminationGracePeriodSeconds` **greater than** `SHUTDOWN_GRACE_SECS`
  (e.g. 45 vs 30) so the server's own watchdog ends the process, not SIGKILL.
- Liveness probe → `/healthz`. Readiness probe → `/readyz`.
  Never point liveness at `/readyz`: a Mongo blip would kill a healthy server.
- RWO PVC for the plugin directory (M4), TLS at the ingress.
- `/metrics` is unauthenticated: scrape it over the cluster network and do not
  route it through the public ingress.

## Configuration

Read once at boot, from the environment (a `.env` file is loaded for
convenience and never overrides real variables). **Invalid configuration is a
boot failure, not a warning.** A value that is set but empty counts as unset.

### Required — the server refuses to start without these

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | **≥ 32 bytes, no default.** Keys the derivation of every stored credential id: `sessions._id`, `invites._id` and `password_resets._id` are `HMAC-SHA256(SESSION_SECRET, token)`. Rotating it therefore logs everyone out and voids outstanding invites and reset links (SPEC §5.2). Generate with `openssl rand -base64 48`. |
| `MONGO_URI` | MongoDB connection string. Pinged at boot: unreachable Mongo fails the boot rather than serving 500s. |

### Server

| Variable | Default | Notes |
|---|---|---|
| `BIND_ADDR` | `0.0.0.0:8080` | Listen address. |
| `MONGO_DATABASE` | `life_manager` | Database name inside the URI's server. |
| `APP_ORIGIN` | *(empty)* | Comma-separated origin allowlist for CORS (M1) and the WebSocket upgrade (M2). Exact matches only: `scheme://host[:port]`, no path, no trailing slash, no wildcards. Empty allows nothing. **Add `http://127.0.0.1:41847` if anyone uses the Android shell** — see "The Android shell" below. |
| `PUBLIC_URL` | *(empty)* | The single origin clients reach this server at, e.g. `https://lm.example.com`. Same syntax as one `APP_ORIGIN` entry — `scheme://host[:port]`, no path, no trailing slash — but a different question: `APP_ORIGIN` is *who may talk to me*, this is *what URL am I reached at*, which a TLS-unaware server behind an ingress cannot work out for itself. Optional, and unset changes nothing. Setting it narrows the Content-Security-Policy published in the Android shell's bundle manifest (`index_csp`) from scheme-wide `connect-src 'self' https: http: wss: ws:` to `connect-src 'self' <PUBLIC_URL> <the same host as wss://>` — see "The Android shell" below. |
| `COOKIE_SECURE` | `true` | Set `false` only for plain-http local development. |
| `TRUST_PROXY_HEADERS` | `false` | Where the client IP comes from — the input to the per-IP login backoff (SPEC §5.2) and to `ip` on every session row and audit entry (SPEC §5.4). `false`: the connection's peer address; `X-Forwarded-For` / `X-Real-IP` are ignored. `true`: the **rightmost** `X-Forwarded-For` hop, which is the one a single trusted proxy appended. **Set `true` only when a reverse proxy is the only route to the server** — otherwise a client picks its own rate-limit bucket and stamps its own origin on the audit log. Compose publishes the port directly, so it stays `false` there; behind the Kubernetes ingress of SPEC §8, set it to `true`. |
| `LOG_FORMAT` | `json` | `json` or `pretty`. |
| `RUST_LOG` | `info` | Standard `tracing` filter, e.g. `info,life_manager_server=debug`. |
| `SHUTDOWN_GRACE_SECS` | `30` | Hard deadline for the whole shutdown sequence (SPEC §8). |
| `SEED_WELCOME_DOCS` | `true` | First-run welcome documents. Skipped when the workspace is non-empty. |

### Limits

| Variable | Default | Notes |
|---|---|---|
| `MAX_ATTACHMENT_BYTES` | `26214400` (25 MiB) | Streamed to GridFS; over the cap → 413. |
| `MAX_DOCUMENT_BYTES` | `1048576` (1 MiB) | Document text cap. **Clamped to the shared core's 1 MiB** — it can only be lowered, because client and server must agree on what is too large. |
| `CRDT_COMPACT_THRESHOLD_BYTES` | `4194304` (4 MiB) | Compact a document's CRDT blob above this. |
| `CRDT_ALERT_THRESHOLD_BYTES` | `8388608` (8 MiB) | Alert above this — watch `lm_documents_oversized`. |

### Sessions and login

| Variable | Default | Notes |
|---|---|---|
| `SESSION_IDLE_DAYS` | `30` | Rolling idle expiry. |
| `SESSION_ABSOLUTE_DAYS` | `180` | Absolute expiry; must be ≥ the idle expiry. TTL-indexed, so expired sessions delete themselves. |
| `INVITE_TTL_DAYS` | `7` | Invite validity (single-use). |
| `LOGIN_MAX_ATTEMPTS` | `10` | Failures per window, per IP **and** per account. |
| `LOGIN_ATTEMPT_WINDOW_SECS` | `900` | Backoff window. |

### Storage behaviour

**Not yet wired in M1.** These are validated at boot but the storage engine still
uses the matching compiled-in defaults: the frozen `MongoDocStore::new(db,
max_document_bytes)` constructor takes no `Config` (see the `INTEGRATION` note at
the top of `docstore.rs`). The documented value and the default are the same
number, so nothing is wrong until you change one — changing one has no effect
today. The same applies to `CRDT_COMPACT_THRESHOLD_BYTES` and
`CRDT_ALERT_THRESHOLD_BYTES` above.

| Variable | Default | Notes |
|---|---|---|
| `TRASH_RETENTION_DAYS` | `30` | Tombstoned documents stay restorable this long; the id then stays in the graveyard forever. |
| `MATERIALIZE_DEBOUNCE_MS` | `500` | Materialization coalescing window (SPEC §3.5). |
| `ROOM_IDLE_TIMEOUT_SECS` | `600` | Hot-document eviction after the last subscriber. |
| `UPDATE_LOG_KEEP_BYTES` | `1048576` | Per-document update-log retention. |
| `UPDATE_LOG_KEEP_COUNT` | `200` | Per-document update-log retention. Correctness never depends on either: a client outside the window falls back to a full state-vector sync. |

### Plugins (M4)

Nothing here needs setting for the base distribution to work. The two you are most
likely to touch are `CONFIG_KEY` (before a plugin stores its first secret) and
`PLUGIN_HTTP_ALLOW_CIDRS` (to reach a service on your own network).

| Variable | Default | Notes |
|---|---|---|
| `DISABLE_PLUGINS` | `false` | The server-side half of safe mode (SPEC §6.1). `true` ⇒ **no plugin code runs anywhere**: nothing is compiled, no cron fires, no hook is delivered, `/api/plugins/:id/*` 404s, and every client is told the installed list is empty. The recovery switch when a plugin is taking the workspace down. |
| `PLUGINS_DIR` | `plugins/base/dist` | One directory per installed plugin per version (`<id>/<version>/`), served at `/plugins/<id>/<version>/…`. On Kubernetes this is the RWO PVC of SPEC §8. |
| `PLUGIN_STAGING_DIR` | `<PLUGINS_DIR>.staging` | Where uploads are extracted and pending packages wait. **Must be on the same filesystem as `PLUGINS_DIR`** — approval is an atomic rename, not a copy. |
| `PLUGIN_INBOX_DIR` | *(unset)* | A directory to watch for dropped `.zip` packages — SPEC §6.2's second install path, for a Compose volume or an `initContainer`. Polled every 5 s, after the file stops growing. A dropped package lands **pending**, exactly like an upload: dropping a file is not evidence a human read its capability list. Archives are moved to `installed/` or `rejected/` (with a `.error.txt`), never deleted. Unset ⇒ no watcher. |
| `CONFIG_KEY` | *(derived)* | 32 bytes as 64 hex characters or base64, encrypting every `secret: true` config value at rest. Unset ⇒ derived from `SESSION_SECRET` — see the rotation caveat below. `openssl rand -hex 32`. |
| `PLUGIN_CALL_TIMEOUT_MS` | `5000` | Per-call wall clock (SPEC §6.3). **Clamped down only**: a value above the default is ignored, so config can tighten the limits and never loosen them. |
| `PLUGIN_CRON_TIMEOUT_MS` | `60000` | Budget for one cron run. |
| `PLUGIN_MEMORY_BYTES` | `134217728` (128 MiB) | Per-instance Wasm memory. |
| `PLUGIN_MAX_INSTANCES` | `4` | Pooled instances per plugin (Extism calls are non-reentrant). |
| `PLUGIN_BREAKER_THRESHOLD` | `5` | Consecutive failures or timeouts before the circuit breaker disables the plugin. Re-enabling is a manual admin click, by design — a breaker that closed itself would hide the fault. |
| `PLUGIN_HTTP_TIMEOUT_MS` | `10000` | Outbound request timeout. The effective value is the smallest of this, what the plugin asked for, and what is left of the call's deadline. |
| `PLUGIN_HTTP_MAX_RESPONSE_BYTES` | `10485760` (10 MiB) | Response cap. Over it is a refusal, **never a truncated body** — half an ICS feed makes confidently wrong documents. |
| `PLUGIN_HTTP_ALLOW_CIDRS` | *(empty)* | Comma-separated CIDRs (`10.1.2.0/24`, `fd00::/8`; a bare address means that one host). Loopback, link-local, RFC1918 and unique-local destinations are refused by default *after* DNS resolution, on every redirect hop; this is the operator escape hatch for a service on your own network. **Cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`) stay refused even inside an allowed range.** An unparseable entry fails the boot. |
| `PLUGIN_ENABLE_CRON` | `true` | `false` stops the scheduler without disabling anything else — the switch for a maintenance window, or for a second environment pointed at a production database. |

A plugin is always granted *less* than or equal to what its manifest asks for. The one
exception is `http.hosts`, which an admin may **add** to at approval time: a plugin
whose destination you configure cannot know the host when it was packaged.

### The Android shell (M5)

The shell is optional and per-device: everything works in a plain browser. There is
**nothing to deploy** for it — no extra service, no extra storage, no extra
configuration file. The server publishes the already-built PWA as a verified bundle
through two authenticated routes (`GET /api/shell/manifest`, `GET
/api/shell/bundle/{path}`), both derived from `WEB_DIST_DIR` and `PLUGINS_DIR`.
Nothing is stored: the bundle version is a hash over what is on disk, so it moves when
you deploy a new build and is identical across restarts.

**One thing must be configured, and getting it wrong looks like a different bug
entirely:**

```
APP_ORIGIN=https://lm.example.com,http://127.0.0.1:41847
```

The shell serves its downloaded bundle from a loopback HTTP server so the page gets a
real, stable, secure-context origin — IndexedDB, Web Workers and `crypto.subtle` all
work unchanged. The cost is that every API call is then cross-origin. Login is not
origin-checked, so **without that entry a user signs in successfully and then never
syncs**: the WebSocket upgrade is refused with 403 before it authenticates. The app
warns before sending a password, but it cannot fix the server. The port is fixed
(`41847`) and must stay fixed — it is part of the origin every client-side store is
keyed by.

**One thing is worth configuring, and nothing breaks if you do not:**

```
PUBLIC_URL=https://lm.example.com
```

The bundle manifest publishes `index_csp`, the Content-Security-Policy the shell's
loopback server sends with `index.html`. Because that page's own origin is
`http://127.0.0.1:41847`, every API call and the sync socket are cross-origin to it,
so `connect-src 'self'` would leave the app unable to reach the server at all — and the
server does not know what host, port or scheme a device reaches it by. With `PUBLIC_URL`
unset the policy falls back to scheme sources, `connect-src 'self' https: http: wss: ws:`,
which works everywhere and restricts nothing about *where* the page may connect. Setting
it narrows that to the two spellings of your own origin:

```
connect-src 'self' https://lm.example.com wss://lm.example.com
```

Everything else in the policy is unchanged and was never the loose part — `script-src` is
`'self'` plus one nonce, `object-src 'none'`, `base-uri 'none'`. Devices pick the narrowed
policy up with their next bundle (the manifest changes, so `bundle_version` moves). Point
it at the URL devices actually use: naming the internal cluster address instead would
publish a policy that blocks every request the app makes.

Two further consequences worth knowing:

- **The server must be HTTPS in production.** The shell holds a bearer token rather
  than a cookie (SPEC §5.2), and a plain-HTTP server would put it on the wire. This is
  the same requirement the PWA already has, for the same reason. A release APK now
  enforces it: cleartext is permitted only to the shell's own loopback bundle server,
  so an `http://` server URL simply does not connect.
- **Do not redirect `/api`.** The shell refuses to follow a redirect on any request
  carrying the bearer token, because `dart:io` would re-send the `Authorization`
  header to whatever host the `Location` names. If you move a deployment, change the
  server URL on the device rather than leaving a `301` behind: a shell pointed at the
  old host reports "unavailable" and keeps running its installed bundle. The same
  applies to an identity proxy in front of the API that bounces unrecognised requests
  to an SSO host.
- **A deploy is an app update.** Devices pick up a new bundle on their next launch —
  and on any foreground at least 15 minutes after their last check, so a long-lived
  app process does not sit on an old bundle for days. They verify every file's SHA-256
  before swapping, keep the previous bundle, and revert automatically after two failed
  boots. You do not have to do anything, and a bad deploy does not brick installed
  apps — but a *partially* published `WEB_DIST_DIR` does produce a manifest whose
  hashes do not match, which devices refuse wholesale and log as corrupt. Publish the
  directory atomically.

### Compose-only

`SERVER_PORT` (host port for the server, default 8080) and `MONGO_PORT` (host
loopback port for mongo, default 27017) are read by `docker-compose.yaml`, not by
the server.

### Read indirectly

`HOSTNAME` is used to label the migration lock holder in logs.

## Health and readiness

`GET /healthz` — liveness. Returns 200 `ok` whenever the process and its runtime
are alive. It deliberately does **not** touch Mongo, so a database outage cannot
turn into a restart loop.

`GET /readyz` — readiness, with details:

```json
{
  "ready": true,
  "mongo": { "ok": true, "detail": "ping ok", "latency_ms": 1 },
  "migrations": { "ok": true, "detail": "schema version 2" },
  "plugins": { "ok": true, "detail": "16 plugins loaded" },
  "schema_version": 2,
  "uptime_secs": 412,
  "version": "0.1.0"
}
```

200 when every check passes, 503 with the same body otherwise. The Mongo ping is
bounded at 2 s so the probe cannot hang.

**`plugins` reports the registry, not the health of each plugin.** A plugin whose
backend half failed to activate, or one the breaker disabled, does not make the server
unready — that is deliberate (SPEC §6.4's rule for the frontend, applied to the backend):
a workspace missing one feature is a better outcome than a server that will not start
because somebody dropped a bad zip in. Look at `GET /api/admin/plugins` for per-plugin
state, and at `lm_plugin_disabled` for an alert.

## Metrics

`GET /metrics`, Prometheus text format, **unauthenticated** — keep it off the
public route. Names are stable (they come from one table in `telemetry.rs`):

| Metric | Type | Meaning |
|---|---|---|
| `lm_http_requests_total` | counter | Requests by `method`, `route`, `status`. `route` is a bounded label: id-looking segments collapse to `:id`. |
| `lm_http_request_duration_seconds` | histogram | Request latency by `method`, `route`. |
| `lm_documents_total` | gauge | Documents stored, including trash (estimated; sampled every 15 s). |
| `lm_crdt_updates_applied_total` | counter | CRDT updates applied. |
| `lm_materialize_duration_seconds` | histogram | Time to materialize `content`/`title`/`fm`/`plugins` for one document. |
| `lm_materialize_failures_total` | counter | Failed materialization passes. Should be flat at zero. |
| `lm_rooms` / `lm_rooms_dirty` | gauge | Hot documents in memory / with unflushed materialization. A dirty count that does not fall is the alert that matters. |
| `lm_documents_oversized` | gauge | Documents above `CRDT_COMPACT_THRESHOLD_BYTES`. |
| `lm_attachment_bytes_total` | counter | Attachment bytes written to GridFS. |
| `lm_login_failures_total` | counter | Failed logins — pair with the `login_attempts` collection. |
| `lm_config_max_document_bytes`, `lm_config_max_attachment_bytes` | gauge | The effective limits, so a dashboard can draw the ceiling. |
| `lm_build_info` | gauge | Always 1, carries a `version` label. |
| `lm_ws_connections`, `lm_ws_subscribed_documents` | gauge | Open sync sockets / documents subscribed across them. |
| `lm_ws_backpressure_drops_total` | counter | Send-queue overflows by `queue="feed"｜"doc"｜"plugin"`. `feed`/`doc` mean a client was told to re-derive; `plugin` is a dropped `plugin.event`, which is ephemeral by design. |

### Plugins (M4)

| Metric | Type | Meaning |
|---|---|---|
| `lm_plugin_calls_total` | counter | Calls into a backend half, by `plugin` and `kind` (`cron`｜`hook`｜`route`｜`call`｜`init`). |
| `lm_plugin_call_duration_seconds` | histogram | Call latency by `plugin`, `kind`. |
| `lm_plugin_call_failures_total` | counter | Host-side failures by `plugin`, `kind`, `reason`. **A plugin's own refusal is not a failure** and does not appear here — it is a successful call that returned an error, and counting it would trip the breaker on a misconfiguration. |
| `lm_plugins_active` / `lm_plugins_disabled` | gauge | Backend halves loaded / disabled. **`lm_plugins_disabled` above zero is the alert that matters**: it means the breaker opened or an admin switched something off, and nothing closes a breaker but a person. |
| `lm_plugin_instances` | gauge | Pooled Wasm instances across all plugins. |
| `lm_plugin_hooks_delivered_total` | counter | Hook deliveries by `plugin`, `outcome` (`ok`｜`failed`｜`rate_capped`). A sustained `rate_capped` is a plugin in a write loop; the 10/min per-document cap is the backstop that stopped it. |
| `lm_plugin_hooks_pending` | gauge | Documents waiting out the 2 s hook debounce. |
| `lm_plugin_http_requests_total` | counter | Outbound requests by `plugin`, `outcome`. |
| `lm_plugin_document_writes_total` | counter | Document writes by `plugin`. |
| `lm_plugin_write_cap_refusals_total` | counter | Writes refused by the per-plugin-per-document cap. Same signal as `rate_capped`, from the write side. |

Suggested first alerts: `lm_rooms_dirty` above zero for more than a few minutes,
any `lm_materialize_failures_total` increase, `lm_documents_oversized` above
zero, `lm_plugins_disabled` above zero, and `/readyz` failing.

## Logs

`tracing`, JSON on stdout, one object per event (`LOG_FORMAT=pretty` for a human
at a terminal). Every request runs inside a span carrying `request_id`, `method`
and `route`, so every line emitted while handling a request — including errors
from deep inside the docstore — can be grouped by that id. The id comes from an
inbound `x-request-id` when a proxy supplied one, is otherwise minted as a ULID,
and is echoed back in the `x-request-id` response header.

Requests finish with a `request completed` event carrying `status` and
`latency_ms`. 5xx responses log the full error chain server-side; clients only
ever see `internal server error`.

There is **no telemetry** of any kind, ever (SPEC §8). These logs go nowhere
except your stdout.

## Deploys and graceful shutdown

SIGTERM (or Ctrl-C) starts the sequence:

1. stop accepting new connections,
2. let in-flight requests finish,
3. flush dirty rooms so materialized state matches the CRDT,
4. exit — with a hard watchdog at `SHUTDOWN_GRACE_SECS` (default 30 s) that
   leaves anyway, logging `graceful shutdown exceeded its grace period`.

**Every deploy drops every live connection** — single replica, by design. Clients
reconnect with backoff and converge (SPEC §4.3). In-flight CRDT updates that were
already applied are durable: they were written to the update log synchronously,
before the response.

Set the platform's kill timeout above `SHUTDOWN_GRACE_SECS` (compose:
`stop_grace_period: 40s`) so the server's own deadline is what ends the process.

## Migrations and upgrades

At boot, in order: connect + ping → migrations under an advisory lock → indexes →
seed (first run only) → listen.

- Migrations are ordered and idempotent. `meta.schema_version` records where the
  database is; the lock lives on the same document with a 5-minute TTL so a
  crashed migrator cannot wedge deployments forever.
- A booting server waits up to a minute for someone else's migration, then fails
  and lets the platform restart it.
- **The server refuses to start if `meta.schema_version` is newer than the
  binary** — that is a rollback into a database it does not understand. The fix
  is to roll *forward* again, or restore a backup taken before the upgrade.
- All indexes are declared in one list and created idempotently. An index *name*
  that exists with different keys fails the boot instead of silently serving
  queries against a different index; changing an index therefore means a
  migration that drops the old name.

Upgrade procedure: back up, deploy, watch `/readyz` and the boot log for
`migrations applied`.

## Backup

Everything durable is in MongoDB — including attachments, which live in GridFS
collections (`attachments.files`, `attachments.chunks`) **inside the same
database**. A full `mongodump` of the database therefore covers documents, CRDT
state, users, sessions, the audit log and every attachment byte. There is nothing
else on disk to back up in M1.

```bash
# Compose: whole database, gzipped archive on the host.
docker compose exec -T mongo \
  mongodump --db life_manager --archive --gzip > lm-$(date -u +%Y%m%dT%H%M%SZ).archive.gz

# Same thing with the repo task (writes into ./backups/<timestamp>/).
mise run backup

# Directly against a mongo you can reach:
mongodump --uri "$MONGO_URI" --db life_manager --archive --gzip > lm.archive.gz
```

Verify a backup is readable before trusting it:

```bash
mongorestore --archive --gzip --dryRun < lm.archive.gz
```

**Consistency:** a standalone mongo has no oplog, so `mongodump` is not a
point-in-time snapshot — a document written mid-dump may be captured and its
update-log entries not. For a clean backup, stop the server first
(`docker compose stop server`, which flushes dirty rooms on the way out), dump,
then start it. For scheduled backups, taking the small skew is acceptable: the
CRDT state and its update log are each internally consistent, and a document that
trails is repaired by the next materialization.

**The Mongo-free path:** `GET /api/admin/export` streams a zip of every document
as plain markdown. It is not a backup of sessions, users or attachments, and it
loses CRDT history — but it is readable without Mongo, without this server, in
any editor. Keep one alongside the dumps (SPEC §8).

## Restore

```bash
docker compose stop server                     # never restore under a live server

docker compose exec -T mongo \
  mongorestore --archive --gzip --drop --nsInclude 'life_manager.*' < lm.archive.gz

docker compose start server
```

`--drop` replaces the collections present in the archive; GridFS collections come
along with them, so attachments restore with their metadata. To restore beside the
live data instead of over it, remap the namespace:

```bash
mongorestore --archive --gzip \
  --nsFrom 'life_manager.*' --nsTo 'life_manager_restored.*' < lm.archive.gz
```

### The split-brain caveat — read this before restoring

A restore rewinds the **server**. It does not rewind the **clients**, and clients
hold their own replicas: the projection of every document, plus full CRDT state
for documents they have opened (SPEC §4.1). When they reconnect:

- **Edits made after the backup point come back.** That is the CRDT working as
  designed — a client's newer state merges into the restored older state. A
  restore is therefore not a clean rollback of content; expect a superset of
  what you restored, not exactly what you restored.
- **Deletions made after the backup point can be undone.** The `deleted_ids`
  graveyard is what stops a long-offline client from resurrecting a deleted
  document, and the restored graveyard only contains the deletions that existed
  when the backup was taken. Documents deleted *after* that point lose their
  tombstone and their graveyard entry, and a client still holding one can push it
  back. Deletions that are *inside* the backup stay dead forever — that is the
  protection the graveyard actually gives you.
- **Sessions restore too.** If the backup predates a session revocation, that
  session is valid again. After restoring for a security reason, revoke sessions
  again (or rotate `SESSION_SECRET`, which logs everyone out).

If you need a true rollback — a state clients must not merge into — plan it
explicitly: restore, then have every user log out (logout clears local replicas
after warning about unsynced changes, SPEC §5.3), or have them clear site data
before reconnecting. For a single-user instance, that is one browser profile.

## Secret rotation

`SESSION_SECRET` has no default and no rotation grace period: changing it
invalidates every session, cookie and bearer token. **Rotating it logs everyone
out** — including Flutter shells, which will prompt for a fresh login and keep
their local data. It works because the secret keys the token derivation: a stored
`_id` is `HMAC-SHA256(SESSION_SECRET, token)`, so a new secret means no presented
token hashes to an existing row. Outstanding invites and password-reset links are
voided by the same change; re-issue them afterwards. Do it deliberately, ideally
alongside a restart:

```bash
openssl rand -base64 48            # new value into .env / the secret store
docker compose up -d server        # or roll the deployment
```

**If `CONFIG_KEY` is unset, rotating `SESSION_SECRET` also makes every stored plugin
secret unreadable.** With no `CONFIG_KEY` the encryption key is derived from
`SESSION_SECRET` (SPEC §6.2), so a new session secret cannot open the old ciphertext.
Nothing breaks loudly: an undecryptable value is reported to the admin screen as
*not set*, with a log line, and the plugin behaves as if it had never been configured
— so a feed importer quietly stops syncing rather than erroring. Re-enter each affected
plugin's secrets in Admin → Plugins afterwards.

Set `CONFIG_KEY` *before* a plugin stores its first secret and the two rotate
independently:

```bash
openssl rand -hex 32               # 64 hex characters, or base64 — 32 bytes either way
```

Rotating `CONFIG_KEY` itself has the same consequence for plugin secrets alone, and no
effect on sessions. There is no re-encryption pass: the recovery for both is re-entering
the values.

## Break-glass password reset

When nobody can log in as an admin (SPEC §5.1), run the CLI subcommand next to
the database — no session required:

```bash
docker compose exec server life-manager reset-password --email you@example.com
```

It prints a **one-time reset token**, valid for 60 minutes, single use. Only the
token's SHA-256 hash is stored, the token itself is never logged, and the use is
recorded in the audit log as `user.reset_password.break_glass`. Redeem it through
the normal reset endpoint so exactly one code path can change a password.

## Runbook

**`/readyz` returns 503 with `mongo.ok: false`.** Mongo is unreachable or slow.
Check `docker compose ps mongo`, its logs, and disk space. The server keeps
running and recovers on its own; `/healthz` intentionally stays green.

**`/readyz` returns 503 with `migrations.ok: false` for more than a minute.** The
boot sequence is stuck waiting on the migration lock, or a migration failed. The
log says which. If a previous process died mid-migration, the lock expires after
five minutes and the next boot proceeds.

**Boot fails: `database schema version N is newer than this binary`.** You rolled
back to an older binary. Roll forward, or restore a backup from before the
upgrade.

**Boot fails: `SESSION_SECRET is required` / `must be at least 32 bytes`.** The
secret is missing, empty, or short. This is by design (SPEC §5.2).

**`lm_rooms_dirty` will not fall to zero.** Materialization is failing or
starved; check `lm_materialize_failures_total` and the error logs, then Mongo's
health. Data is not lost — the CRDT state and the update log are authoritative —
but search and list results are stale until it clears.

**`lm_documents_oversized` above zero.** One or more documents' CRDT blobs are
past the compaction threshold. Look for a document with a very long edit history;
compaction runs above the threshold, and SPEC §3.5 names GridFS spill as the
escape hatch if one keeps growing.

**Shutdown logs `exceeded its grace period`.** Something in flight did not
finish inside `SHUTDOWN_GRACE_SECS`. Flushed state is durable; check what was
running, and confirm the platform's kill timeout is still above the grace period.

### Plugins

**`lm_plugins_disabled` is above zero.** Either an admin switched a plugin off, or the
circuit breaker opened after `PLUGIN_BREAKER_THRESHOLD` consecutive failures. Admin →
Plugins shows which, and why: an admin switch reads as "disabled by …", a breaker trip
names the last failure. Nothing closes a breaker but a person — clicking *enable* clears
it and re-activates the backend half without a restart. If it trips again immediately,
the plugin is broken, not flaky.

**A plugin's cron never runs.** Check, in order: `PLUGIN_ENABLE_CRON` is `true`;
the plugin is `enabled` (not pending, disabled or failed); and its configuration is
complete — Admin → Plugins lists the keys with nothing stored. The "run now" button next
to each declared schedule runs the job immediately with the cron budget, and reports
what it did; it deliberately does **not** move `last_run`, so testing a job cannot make
the real firing skip.

**A plugin's outbound request is refused.** The two codes mean different things and the
log line carries both. `capability_denied` — the manifest declares no `http` capability
at all; the package has to change. `blocked` — the host or the resolved address is not
allowed: either the name is not in the approved list (widen it by re-approving; see
below), or it resolved into a refused range (`PLUGIN_HTTP_ALLOW_CIDRS`). The check runs
after DNS and again on every redirect hop, so an approved name that resolves into
RFC1918 is still refused.

**Changing what an already-approved plugin may reach.** Capabilities are granted once,
at approval, and a plugin in the `enabled` state has no re-approval path. To widen
`http.hosts` on a running plugin: uninstall it *without* the purge checkbox — which
keeps its KV and its `%%%` document data — then upload the same package again and
approve it with the host added. A reinstall is lossless by design precisely so this is
safe.

**A dropped package never appears.** `PLUGIN_INBOX_DIR` is polled every 5 s, and only
after the file has stopped growing. A rejected one is moved to `<inbox>/rejected/` with
a sibling `.error.txt` naming the reason — most often an entry outside `frontend/**`
plus the declared wasm module, which the installer refuses on purpose (SPEC §6.2): a
`README.md` or a `__MACOSX/` sidecar from a desktop zip tool fails the install by name.
Package with `mise run plugin-package <id>`, which writes exactly the accepted set.

**A plugin is taking the workspace down.** `DISABLE_PLUGINS=1` and restart: no plugin
code runs on the server, and every client is told the installed list is empty. In the
browser, `?safe=1` boots the base distribution only and `?safe=bare` boots a minimal
built-in plugin manager — neither needs a server change, which matters when the plugin
breaking things is a frontend half.
