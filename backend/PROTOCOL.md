# Life Manager sync protocol — `/api/sync`

**Version:** `1` (the value of `protocol` in every handshake)
**Status:** frozen for M2. Server (`crates/server/src/routes/sync.rs`, `feed.rs`) and
client (`web/kernel/src/sync/`, `protocol.ts`) implement this document
independently; where an implementation and this file disagree, **this file is the
bug report**. Where this file and [`../SPEC.md`](../SPEC.md) disagree, the SPEC wins.

Spec anchors: §4.1 (projection + lazy CRDTs), §4.2 (local query), §4.3
(transport), §3.2 (CRDT pinning), §3.5 (persistence), §5.2/§5.3 (auth, sessions).

---

## 0. The shape of it in one paragraph

One WebSocket per client carries three independent things, multiplexed: (1) the
**workspace change feed** — a sequence-numbered stream of projection rows, so the
client's IndexedDB mirror can be brought up to date with one round trip and then
kept live; (2) **per-document CRDT sync** for the handful of documents the user
has open, speaking the standard y-protocols exchange over binary frames; (3)
**opaque awareness relay** for those same documents. Cold start does *not* run
over the socket: `GET /api/sync/bootstrap` streams the whole projection as paged
NDJSON, and the socket resumes from the sequence number that bootstrap pinned.

```
client                                                     server
  │ ── GET /api/sync/bootstrap (cold start only) ──────────▶│   NDJSON pages
  │ ◀─ header{safe_seq} row… footer{next_cursor} ───────────│
  │                                                         │
  │ ══ WS upgrade (cookie | bearer subprotocol, Origin) ════▶│
  │ ◀─ welcome{protocol, session, feed{head,safe}, limits} ──│  JSON
  │ ── feed.subscribe{since_seq} ───────────────────────────▶│
  │ ◀─ feed.batch{rows, safe_seq, mode:"catchup"} … ─────────│
  │ ◀─ feed.batch{…, complete:true} ────────────────────────│
  │ ◀─ feed.batch{rows, safe_seq, mode:"live"} ─────────────│  live tail
  │ ── doc.subscribe{id, sv} ───────────────────────────────▶│
  │ ◀─ 0x01 SYNC_STEP1 | 0x02 SYNC_STEP2 ───────────────────│  binary
  │ ── 0x02 SYNC_STEP2 → 0x03 UPDATE … ─────────────────────▶│
  │ ◀─ 0x03 UPDATE (fan-out) / 0x04 AWARENESS (relay) ──────│
```

---

## 1. Connecting

### 1.1 Endpoint and subprotocols

```
GET /api/sync
Upgrade: websocket
Sec-WebSocket-Protocol: life-manager.v1[, life-manager.bearer.<token>]
Origin: https://app.example.com
```

- The client **must** offer `life-manager.v1`. The server selects exactly that
  value in its `Sec-WebSocket-Protocol` response header. A client that offers no
  recognised protocol version is rejected with HTTP **400** before the upgrade
  (there is no socket yet, so there is no close code).
- Native shells cannot set `Authorization` on a browser-less WebSocket and have no
  cookies (SPEC §5.2, §7). They additionally offer
  `life-manager.bearer.<token>`, where `<token>` is the **raw session token**
  exactly as `POST /api/auth/login` returned it (tokens are already URL-safe
  base64-ish opaque strings; they are used verbatim, not re-encoded). The server
  strips the prefix, authenticates the token, and **never** echoes that value in
  the selected-protocol header.
- Deployments where `Authorization` *can* be set (scripts, tests, the harness)
  may send `Authorization: Bearer <token>` instead; both carriers are accepted.

Resolution order for credentials: `Authorization` header → `life-manager.bearer.*`
subprotocol → session cookie. The first one present is the only one tried.

### 1.2 Origin allowlist (mandatory — SPEC §4.3)

Before anything else the server checks the `Origin` header against
`APP_ORIGIN` (the same comma-separated allowlist CORS uses):

| Case | Result |
|---|---|
| `Origin` matches an entry exactly (`scheme://host[:port]`) | continue |
| `Origin` absent (native shell, `curl`, `wscat`) | continue — non-browser clients cannot be CSRF'd through a cookie they do not have; **a cookie-authenticated connection with no `Origin` is still refused** |
| `APP_ORIGIN` empty and `Origin` equals the request's own host | continue (same-origin deployment) |
| anything else | HTTP **403**, no upgrade |

The check happens **before** authentication, so an attacker's page learns nothing
about session validity.

### 1.3 Authentication and its lifetime

- Authentication happens **at upgrade**. There is no in-band login message; a
  socket is either authenticated from its first byte or it does not exist. Failure
  is HTTP **401** (never an upgraded-then-closed socket).
- The server closes **4401 immediately** on every revocation that goes through the
  server itself — logout, password change (which revokes every *other* session),
  admin deactivation or deletion of a user. It additionally re-validates the session
  **every 5 minutes** (± up to 60 s of jitter, so 10 000 sockets do not hit Mongo in
  the same tick), which is what catches the revocations nothing announces: an
  expiry, a row removed straight in the database, a restore from backup. A session
  that is expired, revoked, or belongs to a deactivated user ⇒ close **4401**.
- `4401` means *re-authenticate*, nothing else. The client shows a re-login
  affordance and **never clears IndexedDB** (SPEC §5.3). Unsynced document edits
  survive the re-login.
- Concurrent sockets are capped at **8 per session** (SPEC §4.3, multi-tab), **16
  per user** across all of that user's sessions, and **512 per server process**
  (SPEC §8 pins `replicas: 1`, so every socket's queues and room references sit on
  one heap). A socket over any of those is closed with **4429** immediately after
  the handshake; the client treats that as "another tab owns the socket", stays in
  `offline` sync state with local-only reads, and retries with the standard backoff.
  The per-user cap exists because a session is cheap to mint — `POST
  /api/auth/login` issues as many as it is asked for — so "8 per session" alone
  bounds nothing per account.

### 1.4 `welcome` — the first frame the server sends

The server sends exactly one `welcome` before anything else. A client that
receives any other first frame must close with **4400**.

```json
{
  "t": "welcome",
  "protocol": 1,
  "server_time": "2026-09-24T09:15:00.123Z",
  "session": {
    "user_id": "01J8Z...",
    "is_admin": true,
    "via": "cookie",
    "expires_at": "2026-10-24T09:15:00.000Z"
  },
  "feed": { "head_seq": 48213, "safe_seq": 48213, "floor_seq": 0 },
  "limits": {
    "max_frame_bytes": 4194304,
    "max_subscriptions": 32,
    "feed_catchup_max_rows": 500,
    "inbound_frames_per_sec": 200,
    "inbound_bytes_per_sec": 2097152,
    "heartbeat_secs": 25
  },
  "core_semantics_version": 1,
  "wiring_version": 13
}
```

- `core_semantics_version` mirrors `life_manager_core::CORE_SEMANTICS_VERSION`. A
  client whose Wasm core reports a different value must **not** trust its local
  materialization of `content` → `fm`/`title`; it keeps working read-only from the
  server-materialized projection rows and surfaces "reload to update".
- `wiring_version` is the live plugin wiring version (PLUGIN-PROTOCOLS §6c). A client
  compares it with the version its activated plugin set was resolved from, exactly as if
  a `wiring.applied` had reached it, so a client that was offline during a change
  catches up on reconnect.
- `floor_seq` is the oldest sequence number the feed can still serve. In M2 it is
  always `0`: the feed is never truncated (§2.2). It exists so ACL filtering (v2)
  and any future compaction have a way to say "resume is impossible, bootstrap".

---

## 2. The workspace change feed

### 2.1 What a row is

The projection of SPEC §4.1, plus its sequence number:

```json
{
  "seq": 48211,
  "id": "01J8ZQ0M3M4YQV0X0PTN9R2G7C",
  "title": "Groceries",
  "content": "---\ntitle: Groceries\n---\n\n- [ ] milk\n",
  "fm": { "title": "Groceries", "path": "home/lists", "date": "2026-09-23" },
  "plugins": { "calendar": { "source-uid": "abc123@google.com" } },
  "fm_parse_error": false,
  "materialized_version": "9f2c…",
  "created_at": "2026-09-01T12:00:00.000Z",
  "created_by": "01J8Z…",
  "updated_at": "2026-09-23T18:04:11.482Z",
  "updated_by": "01J8Z…",
  "deleted": false,
  "deleted_at": null,
  "deleted_by": null,
  "purged": false
}
```

Rules, all normative:

- **Every timestamp on the wire is an RFC 3339 / ISO-8601 UTC string with
  millisecond precision** (`2026-09-23T18:04:11.482Z`). MongoDB extended JSON
  (`{"$date": …}`) never appears anywhere in this protocol, the REST API, or the
  bootstrap stream. `fm` and `plugins` carry only the shared-core value model
  (null / bool / int / float / string / list / map) — dates inside them are
  already canonical strings (SPEC §3.4).
- `content` is the **materialized full text**, all three regions (SPEC §3.1). It
  is present unless the subscription asked for `include_content: false` or the row
  is `purged`.
- `deleted: true` is a tombstone: the document is in Trash, still readable and
  restorable for `TRASH_RETENTION_DAYS` (SPEC §3.5). The client keeps the row and
  shows it in Trash.
- `purged: true` is the permanent graveyard entry (the row is gone from
  `documents`). It carries only `seq`, `id`, `deleted: true`, `purged: true`,
  `deleted_at`, `deleted_by`. The client **deletes** its local projection row and
  any local Y.Doc replica for that id. If that replica held unsynced edits, the
  client offers "restore your version as a new document" *before* discarding
  (SPEC §4.1) — as a new id, because the old id can never be reused.
- Rows are **last-writer-wins per id**: there is exactly one live row per document
  in the feed's source of truth, carrying its newest `seq`. Applying rows is
  idempotent; applying them out of order is not. A client that receives a row with
  a `seq` lower than the `seq` it already stored for that id **ignores it**.

### 2.2 Sequence numbers

- `seq` is a workspace-global, strictly increasing `i64`, starting at `1`.
- It is stored as `feed_seq` on the `documents` row (rewritten on every
  materialization, tombstone, and restore) and on the `deleted_ids` (graveyard)
  row (written once, at purge). "Everything since X" is therefore two indexed
  range scans, merged by `seq` — no separate append-only feed collection to grow
  or trim, and **no truncation**: because the graveyard is permanent and a purged
  id can never be recreated, resume from *any* `since_seq ≥ 0` is always exact.
- **Gaps are legal.** A sequence number is allocated before the Mongo write and is
  burned if that write loses its optimistic-concurrency race. Clients must never
  assume `seq + 1`.
- **`safe_seq` is what a client persists as its resume point**, never the largest
  `seq` it has seen. `safe_seq` is the greatest number such that *every* sequence
  number ≤ it has either committed or been burned — the server tracks in-flight
  allocations to compute it. Because two writes can commit out of order, storing a
  bare `max(seq)` would let a client skip the slower one forever.
  - Rows may (and do) arrive with `seq > safe_seq`. Apply them; just do not move
    the watermark past what the server says.
  - `head_seq` in `welcome` is informational (progress bars, "N changes behind").

### 2.3 `feed.subscribe` (client → server)

```json
{ "t": "feed.subscribe", "since_seq": 48100, "include_content": true, "batch_max_rows": 200 }
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `since_seq` | `i64 ≥ 0` | required | Resume point. `0` = "I have nothing" |
| `include_content` | `bool` | `true` | `false` ⇒ omit `content` from rows (metadata-only clients; the PWA always wants it) |
| `batch_max_rows` | `1..1000` | `200` | Server-side page size for catch-up batches |

Server behaviour:

1. `since_seq > head_seq` ⇒ `feed.reset` with `reason: "seq_ahead"`. (The honest
   case: the database was restored from a backup and the client is from the
   future — SPEC §8 split-brain note.)
2. `since_seq < floor_seq` ⇒ `feed.reset` with `reason: "below_floor"`. Cannot
   happen in M2 (`floor_seq == 0`).
3. The number of rows with `feed_seq > since_seq` exceeds
   `limits.feed_catchup_max_rows` ⇒ `feed.reset` with
   `reason: "bootstrap_required"` and `pending_rows: <count>`. Cold start and
   long-absent clients go through `GET /api/sync/bootstrap` (§4), which is paged,
   resumable, cancellable, and does not hold a socket hostage.
4. Otherwise: stream `feed.batch` messages in ascending `seq`, at most
   `batch_max_rows` rows each, until caught up; the final catch-up batch carries
   `complete: true`. From then on the same message type delivers the **live tail**
   with `mode: "live"`.

A second `feed.subscribe` on the same socket replaces the first (this is how a
client resumes after `feed.resync`). `feed.unsubscribe` (`{"t":"feed.unsubscribe"}`)
stops the tail; the socket stays open for document sync.

**`feed.subscribe` is rate-limited separately** from the general inbound caps: 1/s
sustained, burst 5, per connection; over that ⇒ close **4408**. It is a ~60-byte
frame that costs the server two workspace-wide index counts and a fresh catch-up
read, so the byte bucket never notices it while Mongo does. One subscribe per
connection plus one per `feed.resync` is far inside the budget.

### 2.4 `feed.batch` (server → client)

```json
{
  "t": "feed.batch",
  "mode": "catchup",
  "rows": [ { "seq": 48101, "id": "…", "…": "…" } ],
  "safe_seq": 48150,
  "head_seq": 48213,
  "complete": false
}
```

- `mode`: `"catchup"` while draining history, `"live"` for the tail.
- `rows` is ordered by ascending `seq` and may be empty (a `complete: true`
  catch-up batch with no rows means "you were already up to date").
- `complete` is `true` exactly once per subscription, on the last catch-up batch.
  The client flips its sync state to `synced` there (`syncing` before that).
- `safe_seq` is the watermark **after** applying this batch; persist it together
  with the rows in the same IndexedDB transaction, so a crash mid-batch cannot
  advance the watermark past rows that were not stored.

Live-tail batching: the server coalesces notifications for ~50 ms, and collapses
repeats of the same id within one batch to the newest row.

**Batches are bounded by bytes as well as rows.** `batch_max_rows` says nothing
about size — a row carries the whole document text — so the server closes a batch at
**512 KiB** of serialized JSON and continues in the next one, and it stops *reading*
a catch-up page at 2 MiB whatever `batch_max_rows` said. A client therefore sees more
`feed.batch` messages than `ceil(rows / batch_max_rows)`, and a batch may carry fewer
rows than it asked for while `complete` is still `false`. `complete` — never a row
count, never a short page — is what marks the end of catch-up. Every batch is a
valid resume point on its own: rows are ascending and gapless, so a batch's
`safe_seq` is its last row's `seq` (the final batch of a page carries the page's own
watermark). In the corner where a *single* row does not fit in a frame, the server
sends `feed.reset { reason: "bootstrap_required" }` instead: §4's NDJSON stream has
no frame limit, and it is the same escape hatch §3.5 uses for an oversize diff.

### 2.5 `feed.reset` and `feed.resync` (server → client)

```json
{ "t": "feed.reset", "reason": "bootstrap_required", "floor_seq": 0, "head_seq": 48213, "pending_rows": 5000 }
{ "t": "feed.resync", "reason": "backpressure", "from_seq": 48150 }
```

- **`feed.reset`** — "your resume point is unusable". `reason` ∈
  `bootstrap_required` | `seq_ahead` | `below_floor` | `projection_changed`
  (reserved: a server-side projection schema bump). The client runs `GET
  /api/sync/bootstrap`, then re-subscribes at the `safe_seq` that bootstrap
  reported. It does **not** drop its IndexedDB store first — bootstrap rows
  overwrite by id, and ids the bootstrap never mentions are deleted at the end of
  a successful full pass (that is the only garbage-collection path).
- **`feed.resync`** — "keep your data, restart the stream from `from_seq`". Sent
  when the connection's send queue overflowed and queued feed batches were dropped
  (§6). The client immediately sends `feed.subscribe { since_seq: from_seq }`. The
  server stops the dropped stream's producer at the same moment: its cursor is
  already past the rows that were discarded, so no further batch from it can arrive
  after the instruction and hand the client a watermark above rows it never
  received.

---

## 3. Per-document CRDT sync

### 3.1 Binary frame envelope

All CRDT and awareness traffic is **binary** WebSocket frames:

```
 0        1        2                 2+n
 ├────────┼────────┼─────────────────┼───────────────────────────────┤
 │ type   │ idLen  │ doc id (ASCII)  │ payload                        │
 │ u8     │ u8     │ idLen bytes     │ rest of the frame              │
```

- `idLen` is always `26` in practice (a ULID). `0` is illegal.
- Frames whose `idLen` runs past the end, or whose id is not a valid ULID, are a
  protocol error ⇒ close **4400**.
- `type`:

| `type` | Name | Direction | Payload |
|---|---|---|---|
| `0x01` | `SYNC_STEP1` | both | `Y.encodeStateVector(doc)` — "here is what I have" |
| `0x02` | `SYNC_STEP2` | both | `Y.encodeStateAsUpdate(doc, theirStateVector)` — update **encoding v1** |
| `0x03` | `UPDATE` | both | an incremental Yjs update, encoding v1 |
| `0x04` | `AWARENESS` | both | `awarenessProtocol.encodeAwarenessUpdate(...)` — **relayed opaquely, never parsed, never persisted** |
| `0x05` | `AWARENESS_QUERY` | client → server | empty; asks the server to re-relay nothing (no-op in M2; reserved so presence UI in v2 needs no new frame type) |
| `0x06` | `HISTORY` | client → server | an edit made offline: 8 bytes big-endian epoch ms (when it was made), then a Yjs update, encoding v1 (§3.7) |
| `0x10`–`0x1F` | reserved | — | plugin event channels (M4). A client must ignore unknown types ≥ `0x10`; the server closes **4400** on unknown types < `0x10` |

This is deliberately *not* the y-websocket framing: that protocol muxes nothing
and carries no document id. The payloads are exactly y-protocols' payloads, so
`y-protocols/sync` and `y-protocols/awareness` are used unchanged — only the
envelope is ours.

### 3.2 Pinned CRDT compatibility (SPEC §3.2 — violating any of these corrupts text)

- One Yjs doc per document, containing one `Y.Text` at root key **`content`**.
- yrs `OffsetKind::Utf16` (server) ↔ Yjs default UTF-16 indices (client).
- **Update encoding v1** everywhere — wire, stored blob, update log, REST.
- GC identical on both sides: `skip_gc = false` / Yjs default `gc: true`.
- The `Y.Doc` `guid`/`clientID` is client-local and never part of the protocol.

### 3.3 Subscribe / unsubscribe

```json
{ "t": "doc.subscribe", "id": "01J8ZQ…", "sv": "AQTb0pTQ…" }
{ "t": "doc.unsubscribe", "id": "01J8ZQ…" }
```

`sv` is optional, base64 (standard, padded) of the client's
`Y.encodeStateVector`. Send it whenever the client already has a local replica —
it saves a round trip.

Server, on `doc.subscribe`:

1. Validate the id (ULID) → else `doc.error { code: "invalid_id" }`.
2. Graveyarded id ⇒ `doc.error { code: "gone" }`; unknown id ⇒
   `doc.error { code: "not_found" }`. Both are final for that id.
3. Subscription count over `limits.max_subscriptions` ⇒
   `doc.error { code: "too_many_subscriptions" }`. The client's LRU (~20 hydrated
   docs, SPEC §4.1) should make this unreachable.
4. Register the socket as a room subscriber (the per-document actor of SPEC §4.3;
   rooms evict 10 min after the last subscriber drops, post-flush).
5. Send, in this order:
   - JSON `doc.subscribed { id, materialized_version, updated_at, deleted }`
   - binary `SYNC_STEP1` with the server's state vector (always),
   - binary `SYNC_STEP2` computed against the client's `sv` (only if `sv` was
     supplied and the server has anything the client lacks).

Client, on `doc.subscribed`: reply with `SYNC_STEP2` computed against the server's
`SYNC_STEP1` if it has anything the server lacks, then send `UPDATE` frames for
every subsequent local transaction. A client with no local replica sends
`SYNC_STEP1` with its (empty) state vector and lets the server answer
`SYNC_STEP2`.

`doc.unsubscribe` is answered with nothing; the server stops fan-out immediately
and drops any queued frames for that id. An unsubscribed-then-resubscribed doc
restarts the handshake from step 1.

**A subscription is a prerequisite for every binary frame** (§3.4), so
`doc.subscribe` comes first, always. Sending it and the first `SYNC_STEP1` back to
back in the same tick is fine — a connection processes its inbound frames in order —
but a `SYNC_STEP1` for a document this socket has never subscribed to, or has since
unsubscribed from, is dropped.

### 3.4 Steady state and fan-out

- **Every binary frame is scoped to a live subscription on that socket.**
  `SYNC_STEP1`, `SYNC_STEP2`, `UPDATE` and `AWARENESS` for a document this socket
  has not subscribed to are **dropped silently** — no `doc.error`, no close. Two
  reasons, one benign and one not: a frame crossing a `doc.unsubscribe` is ordinary
  and must not cost the client its other documents; and without the gate, one
  28-byte `SYNC_STEP1` per document id loads that document's full `Y.Doc` into the
  server's hot-room registry (where it stays for ten minutes after the socket
  closes), so a single client could pin an entire workspace in RAM while never
  issuing a `doc.subscribe` — and the 32-subscription ceiling that exists to bound
  exactly that would never be consulted.
- Writes that do **not** arrive over a socket — `PUT`/`PATCH /api/documents/:id`, a
  snapshot restore — are fanned out to every subscriber of that document as `UPDATE`,
  the same as a socket write. An open editor sees a REST edit without resubscribing.
- The server applies every inbound `SYNC_STEP2`/`UPDATE` through the docstore
  (`DocStore::apply_update`), which serializes writes per document, appends to
  `document_updates` and marks the room dirty. Materialization is debounced
  (~500 ms) and atomic-with-itself (SPEC §3.5) — which is why a document's *feed
  row* can trail its live CRDT state by one debounce window. Editors get the fine
  grained updates over the socket; the projection catches up right after.
- Applied updates are fanned out to every *other* subscriber of that document as
  `UPDATE`. The originating socket is not echoed.
- Malformed update bytes ⇒ `doc.error { code: "malformed_update" }` and the frame
  is dropped; the socket stays open (a single bad frame must not cost the user
  their other documents). Three malformed updates on one socket ⇒ close **4400**.
- `AWARENESS` frames are relayed to the other subscribers of that doc and to
  nobody else. Not stored, not inspected, not replayed to late joiners.

### 3.5 `doc.resync` and the oversize escape hatch

```json
{ "t": "doc.resync", "id": "01J8ZQ…", "reason": "backpressure" }
{ "t": "doc.resync", "reason": "server_restart" }
```

- `reason` ∈ `backpressure` | `log_gap` | `server_restart` | `contended`.
  `id` omitted ⇒ applies to **every** document this socket subscribes to.
- The client answers with a fresh `SYNC_STEP1` (state-vector resync) per affected
  document. This is the universal recovery move: it is always correct, at worst
  costs one diff, and never loses local edits.
- If a `SYNC_STEP2` the server needs to send exceeds `max_frame_bytes`, it sends
  `doc.error { id, code: "too_large", hint: "rest" }` instead. The client hydrates
  that document over REST — `GET /api/documents/{id}?format=crdt` (SPEC §5.1),
  which has no frame limit — then re-subscribes with the resulting `sv`. Document
  text is capped at 1 MiB and `crdt` is compacted above 4 MiB (SPEC §3.5), so this
  is a corner, not a routine path — but it is a defined corner.
- **`hint` is what distinguishes the two causes of `too_large`, and a client must
  branch on it.** With `hint: "rest"` the *diff* did not fit and REST hydration is
  the fix. **Without a hint**, the server *refused a write* whose result would exceed
  `MAX_DOCUMENT_BYTES` — its state is unchanged, so there is nothing to hydrate;
  re-fetching the document proves nothing and costs a megabyte. The client surfaces
  that one as a size error instead.

### 3.6 `doc.error` (server → client)

```json
{ "t": "doc.error", "id": "01J8ZQ…", "code": "gone", "message": "…", "retryable": false }
```

`code` ∈ `invalid_id` | `not_found` | `gone` | `too_many_subscriptions` |
`malformed_update` | `too_large` | `contended` | `internal`. `retryable: true`
means "the same subscribe may succeed later" (`contended`, `internal`).

### 3.7 Offline edits and their times (`HISTORY`)

Edits made while a document's subscription is down are kept by the client in an **edit
journal**: `{ at, update }` entries, edits closer than 2 s merged into one entry timed
at its first. The journal is saved with the local replica, so it survives a reload.

On (re)subscribe the client sends the journal, oldest first, as `HISTORY` frames
**before** any `SYNC_STEP2` of its own, then clears it. The server applies each like an
`UPDATE` and records it in the document's history (`dev-docs/resolved/HISTORY.md`) at the claimed
time, clamped between the previous change's time and now, marked offline, with the
time it arrived kept beside it. The fan-out to other subscribers is an ordinary `UPDATE`.

The handshake's `SYNC_STEP2` stays the safety net: a journal that was lost (site data
cleared, an older client) still reaches the server through it, and then the change is
marked offline and stamped when it arrived. A `HISTORY` frame shorter than 8 bytes is
`doc.error { code: "malformed_update" }`.

### 3.8 Notes made on the device (`POST /api/documents { id, state }`)

A note made on a device (offline or not) is created from **the device's own CRDT
state**, not its text: the client mints the ULID, builds a `Y.Doc` holding the text,
keeps it as the note's replica, and sends

```jsonc
POST /api/documents
{ "id": "01J8…", "state": "<base64 of the encoded state, update encoding v1>" }
```

The server builds the document from exactly that state. Two things follow:

- **Edits made after it merge.** The replica's later edits (the journal, then the
  handshake) are updates on top of the same state. Created from the text instead, the
  server's insert and the device's would be two different inserts, and the text would
  appear twice.
- **A create sent twice is harmless.** When the reply is lost and the client sends it
  again, the answer is `409`; the client then reads `GET /api/documents/:id?format=crdt`
  and checks the server's state vector covers its seed. If it does, the note is its
  own; if not, the id belongs to another note and the client saves its text as a new
  note under a fresh id.

`state` needs `id`, and excludes `content`. It is refused (`400`) when it is not a
whole document (it depends on edits it does not carry) or its text would change under
normalization (a byte-order mark, a carriage return); the size limit applies to the
text as usual. Until the create succeeds the client does not subscribe to the id (the
server would answer `not_found`); its edits wait in the journal.

---

## 4. `GET /api/sync/bootstrap` — cold start

```
GET /api/sync/bootstrap?limit=200&cursor=01J8ZQ….48213&include_content=true&trash=all
Accept: application/x-ndjson
```

Authenticated like every other `/api` route (cookie or bearer). Response is
`application/x-ndjson`, streamed, **one JSON object per line**:

```jsonc
{"type":"header","protocol":1,"safe_seq":48213,"total":5000,"limit":200,"cursor":null,"core_semantics_version":1}
{"type":"row","seq":48001,"id":"01J8ZQ…","title":"…", …}          // exactly the §2.1 row shape
{"type":"row", …}
{"type":"footer","count":200,"next_cursor":"01J8ZR….48213","complete":false,"safe_seq":48213}
```

- Pages are ordered by `_id` ascending (ULIDs — creation order). `limit` is
  `1..1000`, default `200`.
- **`cursor` is opaque.** A client copies `next_cursor` verbatim into the next
  request and never parses or constructs one. It encodes where the page stopped, the
  watermark the pass is pinned to, *and* the row total that pass reports; a bare
  document id is also accepted and means "no pin".
- **Pages are streamed row by row, and the endpoint is rate-limited by
  concurrency**: at most 2 bootstrap streams per user and 8 per server process. Over
  that, the request is refused with **429** and a `Retry-After`. `limit` is
  client-chosen up to 1 000 and a row carries the document text, so an unbounded
  number of parallel passes is a straightforward way to exhaust a single-replica
  server (SPEC §8).
- **`safe_seq` is captured on the first page and echoed unchanged on every
  page** — by the server, out of the cursor, not by the client remembering. The
  client uses it when the last page reports `complete: true`, subscribing to the
  feed with `since_seq = that safe_seq`. Documents that changed *during* the
  bootstrap are re-delivered by the feed — duplicate rows are harmless (LWW by
  `seq`), missing rows would not be.

  The pin is server-side on purpose. The watermark only ever grows, so a server
  that re-read it per page would report a larger value on later pages; a client
  keeping the first page's value would be fine, but a client exercising the
  cancel-and-restart below would adopt the *restart's* larger value and silently
  skip every document that changed in between. Carrying the pin in the cursor
  makes the guarantee hold for both.
- `trash` ∈ `live` | `trashed` | `all`, default **`all`**: the client's Trash view
  works offline (SPEC §6.5), so tombstoned rows belong in the mirror.
- Purged ids are *not* part of bootstrap. A full successful bootstrap pass is
  authoritative: after `complete: true`, the client deletes every local row whose
  id the pass never mentioned.
- `include_content=false` omits `content` (a metadata-only client; the PWA never
  uses it).
- A client may cancel mid-stream and restart from the last `next_cursor` it saw —
  which keeps the pass's pinned `safe_seq`, because the cursor carries it.
  Restarting from scratch is also always safe.
- Target (SPEC §4.1): 5 000 documents in under 30 s on LAN, with a first-run
  progress screen driven by `header.total` and the running row count.

`GET /api/sync/bootstrap?probe=1` returns a single header line only (no rows) —
how a client asks "how far behind am I, and what is `safe_seq`?" without
downloading anything.

---

## 5. Heartbeats, liveness, and time

- **Server → client:** WebSocket `Ping` every 30 s; two unanswered pings ⇒ close.
- **Client → server:** application-level `{"t":"ping","ts":<epoch_ms>}` every
  `limits.heartbeat_secs` (default 25) whenever the socket has been otherwise
  idle. The server answers `{"t":"pong","ts":<echoed>,"server_time":"…"}`.
  No pong within 10 s ⇒ the client treats the socket as dead and reconnects. (The
  app-level heartbeat exists because browsers expose neither WS ping nor pong.)
- `pong.server_time` is the only clock skew signal in the protocol. Clients use it
  for display ("last synced 3 min ago"), never for ordering — ordering is `seq`
  and the CRDT, never a timestamp.

---

## 6. Backpressure, limits, and flood control

**Max frame size: 4 MiB**, both directions (SPEC §4.3). Larger inbound frame ⇒
close **4413**. The server never *sends* a frame above the limit (see §3.5).

**Bounded send queues.** Each connection has two queues:

| Queue | Bound | On overflow |
|---|---|---|
| feed batches | 64 messages / 8 MiB | drop **all** queued feed batches, stop the feed producer, send `feed.resync { from_seq: <last safe_seq actually flushed> }` |
| per-document frames | 256 frames / 8 MiB total across docs | drop the queued frames **for the offending document**, send `doc.resync { id, reason: "backpressure" }` |

Dropping is always safe because both recovery moves are re-derivations, not
replays: a feed resubscribe re-reads rows from Mongo, and a state-vector resync
recomputes a diff. A connection whose queues overflow more than 10 times in 60 s
is closed **4408** (that client is not keeping up; let it reconnect fresh).

A message is never *built* larger than it may be sent, either: feed batches are
closed at 512 KiB of JSON (§2.4), so the drop-and-instruct path above cannot be
reached by a batch that was over the queue bound before the bound was consulted —
which would otherwise be a resync loop that never terminates, because the
resubscribe rebuilds the identical batch.

**Inbound rate caps** (per connection, token bucket, values announced in
`welcome.limits`): 200 frames/s and 2 MiB/s sustained, burst 2×. Exceeding either
⇒ close **4408**. Control-message floods count the same as data, and
`feed.subscribe` has its own tighter bucket (§2.3).

**Per-socket ceilings:** 32 document subscriptions (and no CRDT frame is served
without one, §3.4); one feed subscription; 8 sockets per session, 16 per user, 512
per process (§1.3). **Per-user ceilings on REST:** 2 concurrent bootstrap streams
(§4).

---

## 7. Close codes

| Code | Meaning | Client response |
|---|---|---|
| `1000` | Normal closure (client navigated away, `logout`) | none |
| `1001` | Going away | reconnect with backoff |
| `4400` | Protocol error (bad frame, unknown control type, `welcome` violated) | **do not** auto-reconnect in a loop: log, reconnect once with full backoff, surface "update available — reload" if it repeats (a version skew is the likely cause) |
| `4401` | Unauthenticated / session revoked / revalidation failed | show re-login; **never clear local data** (SPEC §5.3); resync after re-auth |
| `4403` | Origin not allowed, or a cookie connection without `Origin` | stop; this is a misconfiguration |
| `4408` | Flood / repeated backpressure / rate limit | reconnect with backoff, starting at ×4 the base delay |
| `4409` | Unsupported protocol version | stop reconnecting; prompt reload (the bundle is stale) |
| `4413` | Frame too large | reconnect; report a bug — the client should never send one |
| `4429` | Too many concurrent sockets for this session | stay local-only, retry with backoff (a tab may close) |
| `4503` | Server shutting down (deploy, SIGTERM — SPEC §8) | reconnect quickly with jitter: single replica, so it will be back |

Every close frame carries a short human-readable reason string. It is for logs,
never for branching — branch on the code.

---

## 8. Reconnection

```
delay(n) = random_between(0, min(BASE * 2^n, CAP))     # full jitter
BASE = 500 ms      CAP = 30 s      n = consecutive failures, capped at 6
```

- `n` resets to 0 after a socket stays open ≥ 60 s **and** the feed reported
  `complete: true` (an immediately-failing socket is not a success).
- `4503` uses `BASE = 1 s`, `CAP = 5 s` — a deploy drops every socket at once, and
  full jitter over a short window is what keeps the single replica from being
  stampeded on boot.
- `4408` starts at `n = 2`.
- `4401`, `4403`, `4409` stop the loop entirely; only an explicit user action (or a
  successful re-auth) restarts it.
- The client also reconnects immediately, ignoring the backoff, on
  `navigator.onLine` becoming true or the tab becoming visible — each of those at
  most once per 5 s.
- Sync state machine exposed to plugins (SPEC §6.4 `sync`):
  `offline → connecting → syncing → synced`, plus `auth-required` (4401) and
  `error`. Pending-write count comes from the client's outbox, not from the socket.

---

## 9. Message index

Client → server (JSON): `feed.subscribe`, `feed.unsubscribe`, `doc.subscribe`,
`doc.unsubscribe`, `ping`.
Client → server (binary): `SYNC_STEP1`, `SYNC_STEP2`, `UPDATE`, `AWARENESS`,
`AWARENESS_QUERY`.

Server → client (JSON): `welcome`, `feed.batch`, `feed.reset`, `feed.resync`,
`doc.subscribed`, `doc.error`, `doc.resync`, `pong`, `error`, `wiring.applied`.

`wiring.applied` goes to every connected session whenever the plugin wiring gets a new
version (an Apply in the wiring editor, a rollback, or any install, upgrade, uninstall,
approval, enable, disable or circuit-breaker trip). It is best-effort, like
`plugin.event`: a socket that is not keeping up drops it, and `welcome.wiring_version`
recovers it on the next connect.

```json
{ "t": "wiring.applied", "version": 14, "action": "apply", "at": "2026-09-28T02:30:00Z" }
```
Server → client (binary): `SYNC_STEP1`, `SYNC_STEP2`, `UPDATE`, `AWARENESS`.

Generic fatal/non-fatal server notice, for anything that is not document- or
feed-scoped:

```json
{ "t": "error", "code": "internal", "message": "…", "fatal": false }
```

Unknown `t` values: the **client ignores** them (forward compatibility with M4
plugin channels); the **server closes 4400** (a client sending something the
server does not know is a version skew, and silently dropping writes is worse
than a reconnect).

---

## 10. Conformance checklist

A client implementation is conformant when it:

1. offers `life-manager.v1`, honours `welcome` first, and rejects anything else;
2. persists `safe_seq` (never `max(seq)`) in the *same* transaction as the rows;
3. treats `purged` rows as "delete locally, offer recovery for unsynced edits";
4. answers every `doc.resync`/`feed.resync` with the prescribed re-derivation;
5. never clears local data on `4401`;
6. applies backoff with full jitter and the per-code deviations of §8;
7. sends update encoding **v1** against a `Y.Text` at root key `content`.

A client implementation is additionally conformant when it branches on `doc.error`'s
`hint` rather than on `too_large` alone (§3.5), and when a purge row makes it offer
recovery for **any** local replica holding unsynced edits — including one that is
only on disk, with nothing open (§2.1, SPEC §4.1).

A server implementation is conformant when it:

1. checks `Origin` before authenticating, and refuses cookie auth with no `Origin`;
2. authenticates only at upgrade, closes `4401` on every revocation it performs and
   re-validates every 5 min for the ones it can only discover by looking;
3. computes `safe_seq` from in-flight allocations, never from `max(committed seq)`;
4. emits RFC 3339 strings for every timestamp, never extended JSON;
5. relays awareness without parsing it;
6. drops-and-instructs-resync instead of growing a send queue — and bounds every
   message it builds by bytes, so no frame is assembled that the queue or the frame
   ceiling must then reject;
7. fans out to every subscriber except the originator — **including for writes that
   arrive over REST** — and serializes writes per document through the docstore actor;
8. serves CRDT frames only for documents the socket has subscribed to, and streams
   the bootstrap page instead of buffering it.

The M2 convergence harness (`web/harness/`) is the executable half of this list:
N simulated clients, randomized ops/partitions/reconnects, asserting CRDT
convergence *and* materialization equality (SPEC §9 M2).
