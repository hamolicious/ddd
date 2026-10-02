# `backend/` — ddd server

The Rust half of ddd (dynamic database for documents): a single binary (`ddd`) that serves the
REST API, the sync WebSocket, the PWA and the plugin host over MongoDB.

Every document is one `yrs` CRDT doc holding one `Y.Text`. `content`, `title`, `fm` and
`plugins` are derived from that text.

```
crates/core        the shared core: parsers, title resolver, filter DSL, query engine
                   (native here, wasm32 for the PWA via the `wasm` feature)
crates/plugin-abi  the wire types of the host ABI, shared by the host and the SDK
crates/plugin-sdk  what a plugin's backend half compiles against (wasm32 only,
                   excluded from this workspace: it links Extism's host imports)
crates/server      axum app: routes, docstore, feed, auth, db, telemetry,
                   pluginhost/ (the Wasm runtime), plugininstall/ (the install flow)
```

**One semver covers both plugin contracts.** A plugin manifest's `kernel` range is checked
against the frontend `@kernel` surface *and* the backend host ABI.

---

## Running it

You need Docker (for Mongo) and a Rust toolchain. [`mise`](https://mise.jdx.dev) drives every
task; the raw `cargo`/`docker` equivalents are listed too.

```bash
cp ../.env.example ../.env          # then set SESSION_SECRET
mise run dev                        # Mongo in Docker, server on the host
```

`SESSION_SECRET` has no default; the server refuses to boot without at least 32 bytes:

```bash
openssl rand -base64 48
```

**Every `docker compose` command needs `../.env`**, even `up mongo` alone: compose interpolates
the whole file first, and `SESSION_SECRET` is declared required there. `cargo` commands do not
need `.env`.

| Task | What it does | Without mise |
|---|---|---|
| `mise run dev` | Start Mongo in Docker, run the server on the host | `docker compose up -d --wait mongo` then `cargo run --bin ddd -- serve` |
| `mise run up` | Build and run the whole stack in Docker | `docker compose up --build -d` |
| `mise run down` | Stop the stack, keep the Mongo volume | `docker compose down` |
| `mise run logs` | Tail the server logs | `docker compose logs -f server` |
| `mise run check` | fmt + `cargo check` + clippy `-D warnings`, whole workspace | |
| `mise run test` | Whole workspace test suite | `cargo test --workspace --all-targets` |
| `mise run wasm-check` | Check the core builds with no server deps (the Wasm shape) | `cargo check -p ddd-core --no-default-features` |
| `mise run wasm` | Build the core to Wasm for the kernel, then a node smoke test | see [`../web/README.md`](../web/README.md) |
| `mise run build` | Release binary, same profile as the Docker image | `cargo build --release --locked --bin ddd` |
| `mise run backup` | `mongodump` (documents + GridFS) into `./backups` | `docker compose exec -T mongo mongodump --db ddd --archive --gzip > dump.archive.gz` |

### Tests against Mongo

Mongo-backed tests are `#[ignore]`d, so a clean checkout tests green with no database. To run
them:

```bash
docker compose up -d --wait mongo
MONGO_URI=mongodb://127.0.0.1:27017 \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  cargo test --workspace --all-targets -- --include-ignored
```

- `SESSION_SECRET` is required: some tests build a `Config` from the environment, which refuses
  without it.
- `--all-targets` is required, or the integration tests under `crates/server/tests/` never run.
- **Use `--include-ignored`, not `--ignored`.** `--ignored` runs *only* ignored tests. Several
  suites are not `#[ignore]`d (`plugininstall_zip` needs no database; the `pluginhost_*` suites
  gate on their fixture instead), so `--ignored` skips them and still reports `ok`.

Each suite uses its own throwaway database and drops it afterwards, so it is safe against a
Mongo holding real data. The socket suite (`sync_ws`) shares one database and serializes
itself, because the change-feed counter is in-process (see "Single replica" below).

### Break-glass password reset

For when no admin can sign in. Needs the database, not a running server. Prints a single-use
token valid for 24 h:

```bash
cargo run --bin ddd -- reset-password --email you@example.com
```

Issuing a token invalidates any unused one for that account. Redeem it at
`POST /api/auth/password/reset`; the new password is chosen there, so it never enters shell
history.

---

## Environment variables

Read from the environment, falling back to a `.env` file (which never overrides a real
variable). Every value is validated at boot: a bad variable fails the boot. `../.env.example`
is the annotated copy-me file and covers every variable below.

### Required

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | At least 32 bytes, no default. Rotating it logs everyone out. Never logged. |
| `MONGO_URI` | Connection string. A bad URI fails the boot (connect + ping). |

### Commonly set

| Variable | Default | Notes |
|---|---|---|
| `MONGO_DATABASE` | `ddd` | GridFS attachment buckets live in the same database. |
| `BIND_ADDR` | `0.0.0.0:8080` | The server does not speak TLS; terminate it at the ingress. |
| `APP_ORIGIN` | *(empty)* | Comma-separated allowlist of exact `scheme://host[:port]` (no paths, no wildcards). Empty = same-origin only. Used for CORS **and** the mandatory WebSocket origin check: a cookie-authenticated `/api/sync` upgrade with no `Origin` is refused. |
| `APP_ORIGIN_HOSTS` | *(empty)* | Extra hosts allowed on `PORT`, e.g. a LAN address for a phone: `192.168.0.69` allows `http://192.168.0.69:PORT`. |
| `PUBLIC_URL` | *(empty)* | The one origin clients reach this server at. Not an allowlist. When set, narrows the CSP of the Android shell bundle's `connect-src` to this origin's `https`/`wss` pair. |
| `COOKIE_SECURE` | `true` | Set `false` only for plain-http local dev. |
| `TRUST_PROXY_HEADERS` | `false` | Trust the rightmost `X-Forwarded-For` hop. Only enable when a reverse proxy is the only route to the server, or clients can forge their IP and origin. |
| `LOG_FORMAT` | `json` | `json` (deployed) or `pretty` (local). |
| `RUST_LOG` | `info` | Standard `tracing` filter. |
| `MAX_ATTACHMENT_BYTES` | 100 MiB | `0` = no limit. Enforced while streaming; a chunked upload (`/api/uploads`) is checked before its first chunk. |
| `MAX_DOCUMENT_BYTES` | 1 MiB | Can only be lowered; 1 MiB is the shared core's ceiling. |

### Docker compose

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Port the server listens on inside the stack and is published on. |
| `MONGO_PORT` | `27017` | Loopback host port compose publishes Mongo on, for `mise run dev`. |
| `BIND_HOST` | `0.0.0.0` | Host address the server port is published on. Use `127.0.0.1` behind a local reverse proxy. |

### Serving the PWA and plugins

| Variable | Default | Notes |
|---|---|---|
| `WEB_DIST_DIR` | *(unset)* | The built PWA (`mise run web-build`). Unset = API only, which is what `mise run app` expects (Vite serves the app and proxies `/api`). |
| `PLUGINS_DIR` | `plugins/base/dist` | Installed plugins, one directory per plugin per version. `mise run plugins` writes the base set to `plugins/base/dist`. |
| `KERNEL_DTS_PATH` | `web/kernel-api/dist/kernel.d.ts` | The generated plugin contract, served at `/kernel.d.ts` (`mise run kernel-dts`). |
| `DISABLE_PLUGINS` | `false` | Server-side safe mode: every client is told the plugin list is empty. Client equivalents: `?safe=1` (base plugins only), `?safe=bare`. |

### Plugin host

| Variable | Default | Notes |
|---|---|---|
| `PLUGIN_STAGING_DIR` | `$PLUGINS_DIR.staging` | Where uploads are extracted and held pending. Must be a sibling of `PLUGINS_DIR`, never a child. |
| `PLUGIN_INBOX_DIR` | *(unset)* | Drop `my-plugin-1.2.0.zip` here to install it as pending. Unset = no watcher. |
| `CONFIG_KEY` | derived from `SESSION_SECRET` | Encrypts `secret: true` plugin config at rest (32 bytes, hex or base64; `openssl rand -hex 32`). **Set it explicitly**: if it is derived, rotating `SESSION_SECRET` makes every stored plugin secret unreadable. |
| `PLUGIN_CALL_TIMEOUT_MS` | `5000` | Resource limits; can only be lowered. |
| `PLUGIN_CRON_TIMEOUT_MS` | `60000` | |
| `PLUGIN_MEMORY_BYTES` | 128 MiB | |
| `PLUGIN_MAX_INSTANCES` | `4` | |
| `PLUGIN_BREAKER_THRESHOLD` | `5` | |
| `PLUGIN_HTTP_TIMEOUT_MS` | `10000` | Global ceilings for outbound HTTP. Hosts come from each plugin's approved capability. |
| `PLUGIN_HTTP_MAX_RESPONSE_BYTES` | 10 MiB | |
| `PLUGIN_HTTP_ALLOW_CIDRS` | *(empty)* | Widens the sandbox: CIDRs plugins may reach besides the public internet. Private, loopback, link-local, CGNAT and cloud-metadata addresses are refused otherwise. |
| `PLUGIN_ENABLE_CRON` | `true` | Turn off on a second server pointed at the same database, or for debugging. |

### Tuning (safe to omit)

| Variable | Default | Notes |
|---|---|---|
| `SHUTDOWN_GRACE_SECS` | `30` | Drain, flush and exit within this. |
| `TRASH_RETENTION_DAYS` | `30` | Then the document purges; its id stays reserved forever. |
| `CHECKPOINT_EVERY_CHANGES` | `1000` | A full-text history checkpoint after this many changes. |
| `RAW_CHANGE_DAYS` | `30` | Raw changes older than this are squashed into one record per group (one author, no pause over two minutes). |
| `HISTORY_SQUASH_INTERVAL_SECS` | `3600` | How often the squash job runs. |
| `INVITE_TTL_DAYS` | `7` | |
| `SESSION_IDLE_DAYS` / `SESSION_ABSOLUTE_DAYS` | `30` / `180` | Rolling idle, hard absolute. |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_ATTEMPT_WINDOW_SECS` | `10` / `900` | Backoff per IP *and* per account. |
| `MATERIALIZE_DEBOUNCE_MS` | `500` | |
| `ROOM_IDLE_TIMEOUT_SECS` | `600` | Evicts an idle hot document after flushing. |
| `UPDATE_LOG_KEEP_BYTES` / `UPDATE_LOG_KEEP_COUNT` | 1 MiB / `200` | Per document. Correctness never depends on retention. |
| `CRDT_COMPACT_THRESHOLD_BYTES` / `CRDT_ALERT_THRESHOLD_BYTES` | 4 MiB / 8 MiB | |

Cross-field rules are checked too: `SESSION_ABSOLUTE_DAYS ≥ SESSION_IDLE_DAYS`, alert
threshold ≥ compact threshold, non-zero attempt counts.

---

## API summary

Everything under `/api` needs a session: an `HttpOnly` cookie (browser) or
`Authorization: Bearer <token>` (native shells). Ask for a token with `"bearer": true` on
register/login. All users share one workspace: anyone can read, edit and delete any document.
Destructive and administrative actions are recorded in `audit_log`.

### Auth — `/api/auth`

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/bootstrap` | Unauthenticated: `{needs_first_user, invite_required}`, i.e. what the sign-in screen should show. |
| `POST` | `/register` | `{email, password, name?, invite?, bearer?}`. The **first** user becomes admin with no invite; after that an invite is required and grants a plain account. |
| `POST` | `/login` | `{email, password, bearer?}` → session cookie, plus a bearer token if asked. |
| `POST` | `/logout` | Revokes the session and clears the cookie (bearer sessions too). |
| `GET` | `/me` | The current user. |
| `POST` | `/password` | `{current_password, new_password}`. Revokes every *other* session. |
| `POST` | `/password/reset` | `{token, new_password}`. Redeems an admin- or CLI-issued token. Single use. |

### Documents — `/api/documents`

A document is **one markdown string**: `---` frontmatter, body, trailing `%%% <plugin-id>`
sections. The server derives `title`, `fm` and `plugins` from that text and never accepts them
as fields.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/` | List/query. `filter` (the DSL, JSON-encoded), `search`, `sort`, `cursor`, `limit` (1–500, default 50), `trash=live\|trashed\|all`. |
| `POST` | `/` | `{content, id?}`. The id may be minted by the client (ULID). 201 + `Location`. Existing id → **409**; deleted-forever id → **410**. The server sets timestamps. |
| `GET` | `/{id}` | Materialized JSON. Flushes pending materialization first so you read your own writes; `?stale_ok=true` skips that. `?format=crdt` returns the v1-encoded CRDT state as `application/octet-stream`, with the state vector in `x-state-vector`. |
| `PUT` | `/{id}` | `{content}`. Replaces the full text in one CRDT transaction. |
| `PATCH` | `/{id}` | `{content}` only. Sending `fm` or `plugins` is a **400**; write those through `%%%` section splices. |
| `DELETE` | `/{id}` | Move to Trash. 204. |
| `POST` | `/{id}/restore` | Restore from Trash. |
| `GET`/`POST` | `/{id}/snapshots` | List, or create one (`reason` must be `manual`). |
| `POST` | `/{id}/snapshots/{snapshot_id}/restore` | Replace the text from a snapshot, after taking a `pre_restore` snapshot. |

The filter DSL is ddd's own, not Mongo's: same-type comparisons, explicit `contains`/`any`,
`missing` distinct from `null`, an explicit date type. The shared core evaluates it on the
client and compiles it to a Mongo query here, so both agree. The grammar is in
[`crates/core/README.md`](crates/core/README.md).

```bash
curl -G "$BASE/api/documents" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'filter={"and":[
      {"cmp":{"field":"fm.status","op":"eq","value":{"str":"open"}}},
      {"contains":{"field":"fm.tags","value":{"str":"work"}}}
    ]}' \
  --data-urlencode 'sort=fm.path,-updated_at'
```

`sort` accepts `id`, `title`, `created_at`, `updated_at`, `deleted_at` and any
`fm.*`/`plugins.*` path; prefix `-` for descending; at most 3 keys. `content`, `deleted` and
`materialized_version` are refused.

**Rows missing the sort key sort differently on server and client.** Mongo puts them first
ascending; the client's local query engine puts them last in both directions. For example
`?trash=all&sort=deleted_at` lists live documents first on the server and last on the client.
`-deleted_at` agrees on both.

### Attachments — `/api/attachments`

Binaries live in GridFS, outside the CRDT, referenced from document text as
`attachment://<ulid>`.

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/` | Streamed multipart. `?wrapper=true` also creates a **wrapper document** (title from the filename, body embedding the reference) so folders, search, Trash and links work for files. `wrapper=false` is for pasting into an existing document. |
| `GET` | `/{id}` | Streams the blob. Always `nosniff`; `Content-Disposition: attachment` except for a fixed list of safe inline types. SVG and HTML are **never** inline. `ETag` is the sha256. |
| `GET` | `/{id}/meta` | Metadata only. |
| `PUT` | `/{id}` | Replace. `If-Match: <revision>` required (**428** without it); mismatch → **409**; an identical sha256 returns `{"unchanged": true}`. |
| `DELETE` | `/{id}` | Tombstone the row and delete the bytes. |
| `GET` | `/` | Admin listing. |
| `GET`/`POST` | `/orphans`, `/orphans/scan` | Report blobs no document references. Report only; nothing is deleted automatically. |

The MIME type is sniffed from the bytes, then the extension. The client's `Content-Type` is
ignored.

### Admin — `/api/admin` (admin only, all audited)

| Method | Path | Behavior |
|---|---|---|
| `GET`/`POST` | `/invites` | List, or create a single-use invite (token returned **once**). |
| `DELETE` | `/invites/{id}` | Revoke. |
| `GET` | `/users` | List, including soft-deleted accounts. |
| `PATCH` | `/users/{id}` | Rename, promote/demote. The last admin cannot be demoted. |
| `DELETE` | `/users/{id}` | Soft-delete: attribution stays; sessions, tokens and reset links are revoked. The last admin cannot be deleted. |
| `POST` | `/users/{id}/reset` | Issue a one-time password-reset token. |
| `GET` | `/audit` | Audit log, cursor-paginated (default 50, max 200). |
| `GET` | `/export` | Streamed zip of every document as plain markdown. Disaster recovery without Mongo. |
| `GET` | `/stats` | Workspace counters. |
| `GET`/`POST` | `/plugins` | Every plugin record (state, requested vs approved capabilities, cron, breaker, last error), or upload a `.zip` (multipart), which lands **pending**. |
| `POST` | `/plugins/{id}/{version}/approve` | Body: the approved capability set. Can only narrow, except `http.hosts`, which an admin may widen. Activates the backend half without a restart. |
| `POST` | `/plugins/{id}/{version}/reject` | Delete the pending package. |
| `POST` | `/plugins/{id}/enable`, `/disable` | Admin off switch. `enable` also resets the circuit breaker. |
| `DELETE` | `/plugins/{id}` | Uninstall. Keeps KV and in-document `%%%` data by default; `?purge=true` clears them and queues a job that strips the sections. |
| `GET`/`PUT` | `/plugins/{id}/config` | Schema and values. `secret: true` values are write-only: reads return a mask, and sending the mask back means "unchanged". |
| `POST` | `/plugins/{id}/cron/{index}/run` | Run one declared schedule now, with the cron budget. Does not update `last_run`. |
| `GET` | `/plugins/{id}/logs` | The last N host-side events for this plugin (in memory; the audit log is the durable record). |

### Plugin routes — `/api/plugins/{id}/*`

A backend plugin's own routes, exactly as its manifest declares them.

- Session-authenticated by default. A manifest may declare `public-routes`, which is shown at
  install as a capability.
- Rate-limited per plugin per client.
- `cookie` and `authorization` are stripped from the request, so a plugin never sees the
  caller's credentials. `set-cookie` and hop-by-hop headers are stripped from the response.
- A plugin's own error keeps its status code; a host failure is 502/503/504.

### Sync — `/api/sync`

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/sync` | WebSocket upgrade. Carries the **workspace change feed** (sequence-numbered rows + live tail), **per-document CRDT sync** (y-protocols over binary frames) for open documents, and an **awareness relay**. Auth at upgrade (cookie, `Authorization: Bearer`, or the `ddd.bearer.<token>` subprotocol), with a mandatory `Origin` check. |
| `GET` | `/api/sync/bootstrap` | Cold start: every row as paged NDJSON (`header`, `row`…, `footer`), ordered by `_id`, streamed from the Mongo cursor. The `cursor` is **opaque**: pass `next_cursor` back verbatim. At most 2 concurrent streams per user (**429** beyond that). `?probe=1` returns only the header line. |

What clients can rely on:

- **Resume is always exact.** "Everything since seq X" works for any X, however long the
  client was offline.
- **Resume from the server's `safe_seq`, not the highest sequence number seen.** Sequence
  numbers can commit out of order; `safe_seq` is the point below which everything has
  settled. See `crates/server/src/feed.rs`.
- **Every write is fanned out**, including REST `PUT`/`PATCH` and snapshot restores, to the
  sockets that have the document open.
- **Revocation is immediate.** Logout, a password change, or deactivating or deleting a user
  closes that account's sockets with `4401`. A 5-minute revalidation covers expiries and
  out-of-band database changes.

Every timestamp in every response is an **RFC 3339 string**.

### Shell bundle — `/api/shell/*`

Authenticated. Publishes the PWA as a content-hashed bundle, verified per file, which the
Android shell downloads and can revert between. See `crates/server/src/routes/shell.rs`.

### Operations (unauthenticated)

| Path | Behavior |
|---|---|
| `GET /healthz` | Liveness. 200 without touching Mongo. |
| `GET /readyz` | Readiness: Mongo ping (2 s timeout), migration state, frontend plugin counts, backend plugin host counts (active, breaker-open, cron schedules, instances, calls in flight), schema version, uptime, version. 200 or 503, same shape. Plugin problems never fail the probe; alert on `ddd_plugins_disabled` instead. The body carries counts only, never paths or plugin ids. |
| `GET /metrics` | Prometheus text 0.0.4: HTTP request counts and durations, materialize duration, CRDT updates applied, room/document gauges, change-feed gauges (`ddd_feed_head_seq`, `ddd_feed_safe_seq`, `ddd_feed_subscribers`), socket gauges (`ddd_ws_connections`, `ddd_ws_subscribed_documents`), `ddd_ws_backpressure_drops_total` by queue, and build info. Gauges are sampled every 15 s, so a scrape right after boot can report zeros. |

### Errors

One envelope everywhere:

```json
{ "error": { "code": "conflict", "message": "…", "detail": { "id": "…", "retryable": true } } }
```

`code` is the snake-case status name: `bad_request`, `unauthorized`, `forbidden`, `not_found`,
`conflict`, `gone`, `precondition_failed`, `precondition_required`, `payload_too_large`,
`unsupported_media_type`, `unprocessable`, `too_many_requests`, `unavailable`, `internal`.
`detail` carries machine-readable context where there is any: sizes and limits for
`payload_too_large`, the id for `conflict`/`gone`, `retryable: true` when retrying the same
write is correct.

- **401 always means "re-authenticate"**, and nothing else does. A wrong *current* password on
  `POST /api/auth/password` is a **422**, so a typo does not log the user out.
- **Invite problems are 422** with a specific message (missing, invalid, expired, revoked,
  already used), not 403.

---

## Test harnesses

Both need `mise run wasm` first (a missing core artifact is a hard failure), an `APP_ORIGIN`
that lists the origin the browser half loads from, and the dev account shared with the
Playwright smoke test. See [`../web/README.md`](../web/README.md).

```bash
# convergence: N simulated clients with random ops, partitions and reconnects, asserting
# CRDT convergence and materialization equality against the Wasm core
cd ../web && npm run harness:convergence

# performance: 5 000 documents (bootstrap, cold boot, catch-up, round trip, heap)
cd ../web && npm run harness:perf
```

`crates/server/tests/sync_ws.rs` tests the sync protocol
end to end: the real router over a real socket against a live Mongo.

## Testing plugins

The plugin host suites use `plugins/examples/hello-backend` as their fixture; it exports a
cron handler, a document hook, inbound routes, outbound HTTP and a call dispatcher.

Install path end to end (upload → pending → approve → hot activation):

```bash
mise run web-build && mise run wasm-plugins   # build both halves of every plugin
mise run plugin-package doc-list              # → dist-packages/doc-list-1.0.0.zip
# then: Admin → Plugins → upload → approve → configure (if it declares config)
```

`plugin-package` writes only what the installer accepts (manifest, declared wasm module,
`frontend/**`). A plain `zip -r` of the directory is not equivalent and will be rejected if it
picks up stray files.

Host suites (need `MONGO_URI` and `mise run wasm-plugins`):

```bash
cargo test -p ddd-server \
  --test pluginhost_runtime  `# limits, ownership, breaker, pooling, safe mode` \
  --test pluginhost_http     `# SSRF: allowlist, IP policy, resolve-then-pin, per-hop` \
  --test pluginhost_routes   `# inbound routes: auth default, credential stripping` \
  --test plugininstall_zip   `# hostile archives, no database needed` \
  --test plugininstall_flow  `# queue, approval, upgrade, uninstall, secrets` \
  -- --include-ignored
```

---

## Design notes

- **The CRDT is the source of truth.** `content`, `title`, `fm`, `plugins` and
  `materialized_version` are derived and written together in one Mongo write. They may trail
  the newest CRDT state but are never inconsistent with each other. `GET` flushes first, so a
  client reads its own writes.
- **Frontmatter is human-owned.** The server never parses and re-serializes it (that loses
  comments and corrupts concurrent edits). Writes are minimal text splices through the shared
  core.
- **Deleted ids are never reused.** Trash keeps a tombstone for `TRASH_RETENTION_DAYS`; then
  the document purges but its id stays in `deleted_ids` forever, so a long-offline client can
  never resurrect it.
- **Single replica only.** Hot documents, cron, live sync and the change-feed counter are
  in-process. Deploy with `replicas: 1` and `strategy: Recreate`; two servers on one database
  would hand out duplicate sequence numbers.
- **Migrations run at boot** under an advisory lock, ordered and idempotent. The server
  **refuses to start against a database newer than the binary**. All indexes are declared in
  `db/indexes.rs` and created idempotently.
- **No telemetry.** Nothing leaves the deployment.
