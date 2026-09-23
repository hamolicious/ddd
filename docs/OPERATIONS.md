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
| `APP_ORIGIN` | *(empty)* | Comma-separated origin allowlist for CORS (M1) and the WebSocket upgrade (M2). Exact matches only: `scheme://host[:port]`, no path, no trailing slash, no wildcards. Empty allows nothing. |
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

### Compose-only

`SERVER_PORT` (host port for the server, default 8080) and `MONGO_PORT` (host
loopback port for mongo, default 27017) are read by `docker-compose.yaml`, not by
the server.

### Read indirectly

`HOSTNAME` is used to label the migration lock holder in logs. `DISABLE_PLUGINS`
appears in SPEC §6.1 but is not read in M1 — there is no plugin host yet.

## Health and readiness

`GET /healthz` — liveness. Returns 200 `ok` whenever the process and its runtime
are alive. It deliberately does **not** touch Mongo, so a database outage cannot
turn into a restart loop.

`GET /readyz` — readiness, with details:

```json
{
  "ready": true,
  "mongo": { "ok": true, "detail": "ping ok", "latency_ms": 1 },
  "migrations": { "ok": true, "detail": "schema version 1" },
  "plugins": { "ok": true, "detail": "plugin host not present in M1" },
  "schema_version": 1,
  "uptime_secs": 412,
  "version": "0.1.0"
}
```

200 when every check passes, 503 with the same body otherwise. The Mongo ping is
bounded at 2 s so the probe cannot hang. `plugins` is reported as a passing,
explicitly-skipped check until M4, which keeps the body's shape stable.

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
| `lm_ws_connections`, `lm_ws_subscribed_documents` | gauge | M2 (WebSocket sync); registered now, zero until then. |

Suggested first alerts: `lm_rooms_dirty` above zero for more than a few minutes,
any `lm_materialize_failures_total` increase, `lm_documents_oversized` above
zero, and `/readyz` failing.

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
