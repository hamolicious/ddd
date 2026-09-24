# `backend/` — Life Manager server

The Rust half of Life Manager: a single binary (`life-manager`) serving the REST
API over MongoDB, plus `life-manager-core`, the shared parsing/filter crate that
also compiles to Wasm for the client kernel.

**This is M2** ([SPEC](../SPEC.md) §9): M1's storage, auth, documents and
attachments, plus the sync layer — the workspace change feed, per-document CRDT
sync over WebSocket, and the bootstrap stream. No Extism plugin host (M4), no
Flutter shell (M5). The CRDT is real from the first commit: every document is one
`yrs` doc holding one `Y.Text`, and `content`/`title`/`fm`/`plugins` are *derived*.

```
crates/core        the shared core — parsers, title resolver, filter DSL
                   (native here, and wasm32 for the PWA via the `wasm` feature)
crates/server      axum app: routes, docstore, feed, auth, db, telemetry
PROTOCOL.md        the /api/sync wire protocol — authoritative for both sides
CONTRACTS.md       file ownership and frozen signatures per builder area
```

---

## Running it

You need Docker (for Mongo) and a Rust toolchain. [`mise`](https://mise.jdx.dev)
drives every task; the raw `cargo`/`docker` equivalents are shown alongside.

```bash
cp ../.env.example ../.env          # then set SESSION_SECRET — see below
mise run dev                        # mongo in docker + server on the host
```

`SESSION_SECRET` has no default and the server refuses to boot without ≥ 32
bytes (SPEC §5.2). Generate one:

```bash
openssl rand -base64 48
```

`../.env` is required by **every** `docker compose` command, including
`up mongo` on its own: compose interpolates the whole file before it decides which
services to start, and `SESSION_SECRET` is declared required there on purpose — a
crash-looping container is a worse failure than a refusal. `cargo` commands need
no `.env`.

| Task | What it does | Without mise |
|---|---|---|
| `mise run dev` | Start Mongo in Docker, run the server on the host | `docker compose up -d --wait mongo` then `cargo run --bin life-manager -- serve` |
| `mise run up` | Build and run the whole stack in Docker | `docker compose up --build -d` |
| `mise run down` | Stop the stack, keep the Mongo volume | `docker compose down` |
| `mise run logs` | Tail the server logs | `docker compose logs -f server` |
| `mise run check` | fmt + `cargo check` + clippy `-D warnings`, whole workspace | see below |
| `mise run test` | Whole workspace test suite | `cargo test --workspace --all-targets` |
| `mise run wasm-check` | The core builds with no server deps (the Wasm shape) | `cargo check -p life-manager-core --no-default-features` |
| `mise run wasm` | Build the core to Wasm for the kernel + node smoke test | see [`../web/README.md`](../web/README.md) |
| `mise run build` | Release binary, same profile as the Docker image | `cargo build --release --locked --bin life-manager` |
| `mise run backup` | `mongodump` (documents + GridFS) into `./backups` | see [`../docs/OPERATIONS.md`](../docs/OPERATIONS.md) |

The Mongo-backed tests are `#[ignore]`d so a clean checkout tests green with no
database. Run them against a live Mongo:

```bash
docker compose up -d --wait mongo
MONGO_URI=mongodb://127.0.0.1:27017 \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  cargo test --workspace --all-targets -- --ignored
```

`SESSION_SECRET` is needed as well as `MONGO_URI`: some of those tests build a
`Config` from the environment, and `Config::from_env` refuses without it — exactly
as the server does. `--all-targets` matters too, or the integration test binaries
under `crates/server/tests/` never run.

Each suite uses its own throwaway database and drops it afterwards, so they are
safe to point at a Mongo that holds real data — but the socket suite (`sync_ws`)
deliberately shares **one** database and serializes itself: an `AppState` is a
replica, and SPEC §8 pins `replicas: 1` because the change-feed counter is
in-process, so two live states over one database would hand out the same sequence
numbers.

### Break-glass password reset

The recovery path when no admin can sign in (SPEC §5.1). It needs the database,
not a running server, and prints a single-use token valid for 24 h:

```bash
cargo run --bin life-manager -- reset-password --email you@example.com
```

Issuing a token invalidates any outstanding unused one for that account. Redeem
it at `POST /api/auth/password/reset`; the new password is chosen there, so it
never enters shell history.

---

## Environment variables

Loaded from the real environment, falling back to a `.env` file (which never
overrides a real variable). **Every** value is validated at boot — a bad variable
is a boot failure, not a surprise at request time. `../.env.example` is the
annotated copy-me file; [`../docs/OPERATIONS.md`](../docs/OPERATIONS.md) has the operational detail.

### Required

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | ≥ 32 bytes, no default. Rotating it logs everyone out. Never logged. |
| `MONGO_URI` | Connection string. A bad URI fails the boot (connect + ping). |

### Commonly set

| Variable | Default | Notes |
|---|---|---|
| `MONGO_DATABASE` | `life_manager` | GridFS attachment buckets live in the same database. |
| `BIND_ADDR` | `0.0.0.0:8080` | The server is TLS-unaware; terminate TLS at the ingress. |
| `APP_ORIGIN` | *(empty)* | Comma-separated allowlist, exact `scheme://host[:port]` — no paths, no wildcards. Empty = same-origin only. Used for CORS **and** as the mandatory WebSocket origin check (SPEC §4.3): a cookie-authenticated `/api/sync` upgrade with no `Origin` is refused outright. |
| `COOKIE_SECURE` | `true` | Set `false` only for plain-http local dev. |
| `LOG_FORMAT` | `json` | `json` (deployed) or `pretty` (local). |
| `RUST_LOG` | `info` | Standard `tracing` filter. |
| `MAX_ATTACHMENT_BYTES` | 25 MiB | Enforced by a streaming counter, never by buffering. |
| `MAX_DOCUMENT_BYTES` | 1 MiB | May only be *lowered*; the shared core's 1 MiB cap is the ceiling. |
| `SEED_WELCOME_DOCS` | `true` | First-run welcome documents (SPEC §6.5). Skipped if the workspace has ever held a document. |

### Tuning (defaults match the spec; safe to omit)

| Variable | Default | Spec |
|---|---|---|
| `SHUTDOWN_GRACE_SECS` | `30` | §8 — drain, flush, exit within it. |
| `TRASH_RETENTION_DAYS` | `30` | §3.5 — then the document purges, the id stays forever. |
| `INVITE_TTL_DAYS` | `7` | §5.1 |
| `SESSION_IDLE_DAYS` / `SESSION_ABSOLUTE_DAYS` | `30` / `180` | §5.2 — rolling idle, hard absolute. |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_ATTEMPT_WINDOW_SECS` | `10` / `900` | §5.2 — per-IP *and* per-account backoff. |
| `MATERIALIZE_DEBOUNCE_MS` | `500` | §3.5 |
| `ROOM_IDLE_TIMEOUT_SECS` | `600` | §4.3 — hot-document eviction, post-flush. |
| `UPDATE_LOG_KEEP_BYTES` / `UPDATE_LOG_KEEP_COUNT` | 1 MiB / `200` | §3.5 — per document. Correctness never depends on retention. |
| `CRDT_COMPACT_THRESHOLD_BYTES` / `CRDT_ALERT_THRESHOLD_BYTES` | 4 MiB / 8 MiB | §3.5 |

Cross-field rules are checked too: `SESSION_ABSOLUTE_DAYS ≥ SESSION_IDLE_DAYS`,
alert threshold ≥ compact threshold, non-zero attempt counts.

---

## API summary

Everything under `/api` needs a session — a `HttpOnly` cookie (browser) or
`Authorization: Bearer <token>` (native shells; SPEC §5.2). Both are supported
from M1; ask for a token with `"bearer": true` on register/login. All users share
one workspace: any user can read, edit and delete any document (SPEC §5.4), and
destructive or administrative actions land in `audit_log`.

### Auth — `/api/auth`

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/bootstrap` | Unauthenticated: `{needs_first_user, invite_required}` — what the sign-in screen should show. |
| `POST` | `/register` | `{email, password, name?, invite?, bearer?}`. The **first** user ever becomes admin with no invite; after that an invite is mandatory and always grants a plain account. |
| `POST` | `/login` | `{email, password, bearer?}` → session cookie, plus a bearer token when asked. |
| `POST` | `/logout` | Revokes the session and clears the cookie (bearer sessions too). |
| `GET` | `/me` | The current user. |
| `POST` | `/password` | `{current_password, new_password}` — revokes every *other* session. |
| `POST` | `/password/reset` | `{token, new_password}` — redeem an admin- or CLI-issued token. Single use. |

### Documents — `/api/documents`

A document is **one markdown string**: `---` frontmatter, body, trailing
`%%% <plugin-id>` sections (SPEC §3.1). The server materializes `title`, `fm` and
`plugins` from that text; it never accepts them as fields.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/` | List/query. `filter` (the DSL, JSON-encoded), `search`, `sort`, `cursor`, `limit` (1–500, default 50), `trash=live\|trashed\|all`. |
| `POST` | `/` | `{content, id?}` — the id is client-mintable (offline-first ULID). 201 + `Location`. Existing id → **409**; graveyarded id → **410**. The server stamps timestamps. |
| `GET` | `/{id}` | Materialized JSON, flushing pending materialization first (read-your-writes; `?stale_ok=true` skips it). `?format=crdt` returns the v1-encoded CRDT state as `application/octet-stream` with the state vector in `x-state-vector`. |
| `PUT` | `/{id}` | `{content}` — replace the full text in one CRDT transaction. |
| `PATCH` | `/{id}` | `{content}` only. Sending `fm` or `plugins` is a **400**, not a silent no-op: machines write through `%%%` splices or own whole documents (SPEC §3.3). |
| `DELETE` | `/{id}` | Tombstone → Trash. 204. |
| `POST` | `/{id}/restore` | Untombstone. |
| `GET`/`POST` | `/{id}/snapshots` | List, or create one (`reason` must be `manual`). |
| `POST` | `/{id}/snapshots/{snapshot_id}/restore` | Replace the text from a snapshot, after taking a `pre_restore` one. |

The filter DSL is **ours, not Mongo's** — same-type comparisons, explicit
`contains`/`any`, `missing` distinct from `null`, an explicit date type. It is
evaluated by the shared core on the client and compiled to a Mongo query here, so
both agree. Tagged-JSON wire form; the grammar is in
[`crates/core/README.md`](crates/core/README.md):

```bash
curl -G "$BASE/api/documents" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'filter={"and":[
      {"cmp":{"field":"fm.status","op":"eq","value":{"str":"open"}}},
      {"contains":{"field":"fm.tags","value":{"str":"work"}}}
    ]}' \
  --data-urlencode 'sort=fm.path,-updated_at'
```

`sort` accepts `id`, `title`, `created_at`, `updated_at`, `deleted_at`,
`materialized_version` and any `fm.*`/`plugins.*` path, `-` for descending, at
most 3 keys. `content` and `crdt` are refused.

### Attachments — `/api/attachments`

Binaries live in GridFS, outside the CRDT, referenced from document text as
`attachment://<ulid>` (SPEC §3.6).

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/` | Streamed multipart. `?wrapper=true` also creates the **wrapper document** (title from the filename, `?path=` → `fm.path`, body embedding the reference) so folders, search, Trash and links apply to files with no special cases. `wrapper=false` is the paste-into-a-document path. |
| `GET` | `/{id}` | Streams the blob. `nosniff` always, `Content-Disposition: attachment` except a closed allowlist of safe inline types — SVG and HTML are **never** inline. `ETag` is the sha256. |
| `GET` | `/{id}/meta` | Metadata only. |
| `PUT` | `/{id}` | Replace. `If-Match: <revision>` required (**428** without it); mismatch → **409**; an identical sha256 auto-resolves to `{"unchanged": true}`. |
| `DELETE` | `/{id}` | Tombstone the row and delete the bytes. |
| `GET` | `/` | Admin listing. |
| `GET`/`POST` | `/orphans`, `/orphans/scan` | Report blobs no materialized text references. Reports only — nothing is auto-deleted. |

MIME type is sniffed from the bytes, then the extension; the client's
`Content-Type` is never trusted.

### Admin — `/api/admin` (admin only; everything here is audited)

| Method | Path | Behavior |
|---|---|---|
| `GET`/`POST` | `/invites` | List, or mint a single-use invite (token returned **once**). |
| `DELETE` | `/invites/{id}` | Revoke. |
| `GET` | `/users` | List, including soft-deleted accounts. |
| `PATCH` | `/users/{id}` | Rename, promote/demote. The last admin cannot be demoted. |
| `DELETE` | `/users/{id}` | Soft-delete: attribution ids stay, sessions/tokens/reset links die. The last admin cannot be deleted. |
| `POST` | `/users/{id}/reset` | Issue a one-time password-reset token. |
| `GET` | `/audit` | Audit log, `_id`-cursor paginated (default 50, max 200). |
| `GET` | `/export` | Streamed zip of every document as plain markdown — the no-Mongo disaster-recovery path. |
| `GET` | `/stats` | Workspace counters. |

### Sync — `/api/sync`

The app's channel (SPEC §4.1, §4.3). The complete wire protocol — message schemas,
framing, close codes, backpressure, reconnect policy — is
[`PROTOCOL.md`](PROTOCOL.md), and it is authoritative for the server and the client
alike.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/sync` | WebSocket upgrade. Carries the **workspace change feed** (sequence-numbered projection rows + live tail), **per-document CRDT sync** (y-protocols over binary frames) for open documents, and an **opaque awareness relay**. Auth at upgrade (cookie, `Authorization: Bearer`, or the `life-manager.bearer.<token>` subprotocol) with a mandatory `Origin` check. |
| `GET` | `/api/sync/bootstrap` | Cold start: the whole projection as paged NDJSON (`header`, `row`…, `footer`), ordered by `_id`, with the feed `safe_seq` pinned for the whole pass. Rows are **streamed from the Mongo cursor**, one at a time — a 1 000-row page of megabyte documents is not a `Vec`. The `cursor` is **opaque** — copy `next_cursor` verbatim; it carries the position, the watermark pin and the row total, so resuming a cancelled pass cannot skip rows and the progress denominator costs one count per pass instead of one per page. Concurrency-limited to 2 streams per user (**429** beyond that). `?probe=1` returns the header line and nothing else. |

Two properties worth stating outright, because they are what the design turns on:

- **Resume is always exact.** The feed's sequence numbers live on the rows
  themselves (`documents.feed_seq`) and on graveyard rows (`deleted_ids.feed_seq`),
  and neither is ever trimmed — so "everything since seq X" works for any X, however
  long a client was offline. There is no append-only feed collection to grow.
- **A client's resume point is the server's `safe_seq`, not the highest sequence
  number it saw.** Numbers are allocated before their Mongo write and can commit out
  of order; `safe_seq` is the watermark below which everything has settled. See
  `crates/server/src/feed.rs` for the whole argument.
- **Every write is fanned out, whoever made it.** A `PUT`/`PATCH` or a snapshot
  restore publishes its CRDT diff to the sockets that have the document open, exactly
  as a socket write does — so an open editor never silently diverges from the server.
- **Revocation is immediate.** Logout, a password change, deactivating or deleting a
  user closes that account's live sockets with `4401` on the spot; the 5-minute
  revalidation poll is the backstop for revocations the server does not perform
  itself (an expiry, a row deleted in the database).

Every timestamp in every response — REST, feed, bootstrap — is an **RFC 3339
string**. MongoDB extended JSON (`{"$date": …}`) never reaches a client.

### Operations (unauthenticated)

| Path | Behavior |
|---|---|
| `GET /healthz` | Liveness. 200 without touching Mongo. |
| `GET /readyz` | Readiness with detail: Mongo ping (2 s bound), migration state, plugin **counts**, schema version, uptime, version. 200 / 503 on the same shape. Unauthenticated, so the body carries no filesystem paths and no manifest errors — those go to the log and the admin view. |
| `GET /metrics` | Prometheus text 0.0.4 — `lm_http_requests_total`, `lm_http_request_duration_seconds`, `lm_materialize_duration_seconds`, `lm_crdt_updates_applied_total`, room/document gauges, the change-feed gauges (`lm_feed_head_seq`, `lm_feed_safe_seq`, `lm_feed_subscribers`), socket gauges (`lm_ws_connections`, `lm_ws_subscribed_documents`), `lm_ws_backpressure_drops_total` by queue, and build info. Gauges are **sampled every 15 s**, so a scrape within 15 s of boot reports the workspace the server started with — including zeros. |

### Errors

One envelope everywhere:

```json
{ "error": { "code": "conflict", "message": "…", "detail": { "id": "…", "retryable": true } } }
```

`code` is the snake-case status name (`bad_request`, `unauthorized`, `forbidden`,
`not_found`, `conflict`, `gone`, `precondition_failed`, `precondition_required`,
`payload_too_large`, `unsupported_media_type`, `unprocessable`,
`too_many_requests`, `unavailable`, `internal`). `detail` carries machine-readable
context where there is any — sizes and limits for `payload_too_large`, the id for
`conflict`/`gone`, `retryable: true` when retrying the same write is the correct
client response.

Two statuses are worth singling out, because the obvious reading is wrong:

- **401 always means "re-authenticate"**, and nothing else does. A wrong *current*
  password on `POST /api/auth/password` is a **422** — a 401 there would make a
  client log the user out over a typo (SPEC §5.3: a 401 never clears local data,
  but it does force a re-login).
- **Invite problems are 422** with a specific message (missing, invalid, expired,
  revoked, already used), not 403.

---

## The M2 gates

SPEC §9 M2 names two, and both are commands rather than claims:

```bash
# convergence: N simulated clients, randomized ops/partitions/reconnects, asserting
# CRDT convergence *and* materialization equality against the Wasm core
cd ../web && npm run harness:convergence

# performance: 5 000 documents — bootstrap, cold boot, catch-up, round trip, heap
cd ../web && npm run harness:perf
```

Measured results, with pass/fail against the SPEC targets, are in
[`PERF.md`](PERF.md). Both harnesses need `mise run wasm` first: materialization
equality is compared against the real shared core, and a missing artifact is a hard
failure rather than a skipped assertion. They also need the server's `APP_ORIGIN`
to list the origin the browser half loads from, and they share a dev account with
the Playwright smoke — see [`../web/README.md`](../web/README.md).

The other executable half of the protocol is `crates/server/tests/sync_ws.rs` —
the real router over a real socket against a live Mongo, covering the handshake,
origin-before-auth ordering, close codes, watermarks, fan-out and backpressure.

---

## Notes on the shape of things

- **The CRDT is the source of truth.** `content`, `title`, `fm`, `plugins` and
  `materialized_version` are derived and rewritten *together* in one Mongo write.
  They may trail the newest CRDT state; they are never inconsistent with each
  other. `GET` forces a flush so a client reads its own writes (SPEC §3.5).
- **Frontmatter is human-owned.** Nothing on the server parses and re-serializes
  it — that round-trip destroys comments and corrupts under concurrent edits.
  Writes are minimal text splices through the shared core's splice helper
  (SPEC §3.3).
- **Deleted ids are never reusable.** Trash holds a tombstone for
  `TRASH_RETENTION_DAYS`, then the document purges but the id stays in
  `deleted_ids` forever, so a long-offline client can never resurrect it.
- **Single replica, on purpose.** Hot documents, cron and (in M2) live sync are
  in-process; `replicas: 1` + `strategy: Recreate`. The HA seam is named in
  SPEC §8 and is v2.
- **Migrations run at boot** under an advisory lock, ordered and idempotent, and
  the server **refuses to start against a database newer than the binary**. All
  indexes are declared in one list (`db/indexes.rs`) and created idempotently. They
  run through `AppState::init_schema`, which then **re-seeds the change feed's
  sequence counter** — `m002_backfill_feed_seq` is what numbers an M1 workspace's
  rows, so a counter seeded before it would hand those numbers out a second time.
- **Telemetry: none, ever.** Nothing leaves the deployment.

[`../docs/OPERATIONS.md`](../docs/OPERATIONS.md) covers deployment, backup/restore (including the GridFS and
split-brain caveats), secret rotation and the runbook.
