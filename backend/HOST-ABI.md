# The backend-plugin host ABI

**Status:** M4 scaffold, 2026-09-24. Authoritative for the boundary between the server's
Wasm host and a backend plugin (SPEC §6.2, §6.3).
**Type form:** [`backend/crates/plugin-abi`](crates/plugin-abi) — every schema below is a
serde type there, used by *both* sides. This document and that crate change in the same
commit: the document is authoritative for **behaviour**, the crate for **shape**.
**Writing a plugin:** [`backend/crates/plugin-sdk`](crates/plugin-sdk) is the typed Rust
skin over all of it; [`plugins/examples/hello-backend`](../plugins/examples/hello-backend)
is the smallest complete example and the host's own smoke-test fixture.

Where this document and [`../SPEC.md`](../SPEC.md) disagree, **the SPEC wins and this
document is the bug report** (two places below say where they deliberately differ, and
why).

---

## 1. What a backend plugin is for

Its genuine niche (SPEC §6.3): **cron while nobody's looking, outbound HTTP with secrets,
inbound webhooks** — and authoring machine-owned documents. It is *not* a mirror of the
client: reads and queries exist so a job can find what it wrote, not so a plugin can
implement a UI on the server.

**The preferred pattern is documents** (SPEC §1). When the two halves of a plugin share
state, the backend writes *documents*; the existing sync carries them to every client,
offline included, searchable and editable like everything else. `emit_client`, `emit` and
KV are for what genuinely cannot be a document.

---

## 2. Mechanics

### 2.1 One shape for everything

Every host function takes **one** Extism memory handle holding UTF-8 JSON and returns
**one** handle holding UTF-8 JSON. Every plugin export does the same. The returned JSON is
always an envelope:

```json
{ "ok": true,  "value": … }
{ "ok": false, "error": { "code": "capability_denied", "message": "…", "detail": { … } } }
```

`value` and `error` are omitted when empty, so a void success is exactly `{"ok":true}`.

Host functions live in Extism's `extism:host/user` namespace, so they cannot collide with a
plugin's exports, and **Extism's own built-ins in `extism:host/env` are not this ABI**. In
particular `extism_pdk::http` (the PDK's built-in HTTP) is inert: the host builds every
plugin with an empty `allowed_hosts`, because outbound requests must go through
`http_request`, which is the one with the allowlist, the IP policy and the address pinning.

### 2.2 A refusal is a value, never a trap

SPEC §6.2: *"Undeclared host functions are linked as **erroring stubs** (so optional use is
possible; instantiation never fails on imports)."* Therefore:

- **All 13 host functions are always linked**, whatever the plugin's capabilities. An
  unapproved one returns `{"ok": false, "error": {"code": "capability_denied", …}}`.
- A plugin may probe for a capability it does not have and degrade.
- A trap (a panic, an `unwrap` on `None`, an unreachable) is a *host-side failure*: it
  poisons the instance, the instance is dropped, and the circuit breaker counts it.

### 2.3 Binary data

Bodies — an HTTP response, a webhook request — travel **base64** (standard, padded) in a
named `*_base64` field. One wire format, no "is this field text or bytes" ambiguity. Size
caps are enforced on the **raw** bytes, and exceeding one is an error, never a truncation:
half an ICS feed would produce confidently wrong documents.

### 2.4 Timestamps and ids

RFC 3339 UTC strings (`2026-09-24T06:00:00Z`) everywhere, matching the REST wire format.
Document ids are ULID strings. `fm` and `plugins` are the shared core's value model as
plain JSON — never extended JSON.

---

## 3. Host functions

Names are exactly SPEC §6.3's, plus `log` (§3.13, and the reason it exists is there).

| Function | Capability | Input → Output |
|---|---|---|
| [`get_document`](#31-get_document) | `documents: ["read"]` | `GetDocumentInput` → `GetDocumentOutput` |
| [`query_documents`](#32-query_documents) | `documents: ["read"]` | `QueryDocumentsInput` → `QueryDocumentsOutput` |
| [`create_document`](#33-create_document) | `documents: ["write"]` | `CreateDocumentInput` → `WriteDocumentOutput` |
| [`splice_section`](#34-splice_section) | `documents: ["write"]` | `SpliceSectionInput` → `SpliceSectionOutput` |
| [`rewrite_document`](#35-rewrite_document) | `documents: ["write"]` + ownership | `RewriteDocumentInput` → `WriteDocumentOutput` |
| [`kv_get`](#36-kv_get--kv_set) | none | `KvGetInput` → `KvGetOutput` |
| [`kv_set`](#36-kv_get--kv_set) | none | `KvSetInput` → `KvSetOutput` |
| [`config_get`](#37-config_get) | none | `ConfigGetInput` → `ConfigGetOutput` |
| [`emit`](#38-emit) | none | `EmitInput` → `EmitOutput` |
| [`emit_client`](#39-emit_client) | none | `EmitClientInput` → `EmitClientOutput` |
| [`call_plugin`](#310-call_plugin) | declared dependency | `CallPluginInput` → `CallPluginOutput` |
| [`http_request`](#311-http_request) | `http.hosts` | `HttpRequestInput` → `HttpResponseOutput` |
| [`log`](#312-log) | none | `LogInput` → `null` |

**Why KV, config, events and `call_plugin` are ungated.** SPEC §6.2's example of the
capability system working is *"a cron-and-KV plugin can't silently read the workspace"* —
so KV and config, which are the plugin's **own** namespace, need no grant; `call_plugin` is
gated by the dependency graph instead; and `emit_client` reaches only sessions of this
workspace's users with a payload the plugin already has.

### 3.1 `get_document`

```json
{ "id": "01J8ZQ…", "metadata_only": false }
```

```json
{ "document": {
  "id": "01J8ZQ…", "title": "Standup",
  "content": "---\ntitle: Standup\n…",
  "fm": { "title": "Standup", "date": "2026-09-24T09:00:00Z" },
  "plugins": { "calendar": { "source_uid": "…" } },
  "fm_parse_error": false, "materialized_version": "9f2c…",
  "created_at": "2026-09-24T06:00:00Z", "created_by": "plugin:calendar",
  "updated_at": "2026-09-24T06:00:00Z", "updated_by": "plugin:calendar",
  "deleted": false
} }
```

- `metadata_only: true` omits `content` — the cheap read for a job that only needs `fm` or
  its own section across thousands of documents.
- Forces a materialization flush, so a plugin that splices and re-reads inside one call
  sees its own write (SPEC §3.5's read-your-writes rule).
- Tombstoned documents are returned with `deleted: true`. A graveyarded id is `gone`; an
  unknown id is `not_found`.
- **`created_by` is the machine-ownership record.** `plugin:<id>` means that plugin created
  the document, and that is what `rewrite_document` checks.

Errors: `capability_denied`, `invalid_argument` (not a ULID), `not_found`, `gone`,
`unavailable`.

### 3.2 `query_documents`

```json
{ "filter": { "and": [ { "exists": "fm.date" },
                       { "cmp": { "field": "fm.date", "op": "gte", "date": "2026-09-01" } } ] },
  "sort": ["fm.date", "-updated_at"],
  "search": null, "limit": 200, "cursor": null,
  "trash": "live", "metadata_only": true }
```

```json
{ "documents": [ … ], "next_cursor": "eyJ…" }
```

- **The filter language is ours, not Mongo's** (SPEC §4.2). It is parsed by the shared core
  (`core::filter`) and compiled to a Mongo query by the server; client JSON never reaches
  Mongo, so a plugin cannot smuggle an operator.
- `sort` uses the REST spelling: `"fm.date"`, `"-fm.date"`, `"title:desc"`.
- `limit` is **clamped** to 200 (default 50), not refused. Paging is the caller's job:
  follow `next_cursor` until it is absent. There is no unbounded read.
- `trash` defaults to `"live"` — a plugin that forgets it does not resurrect deleted
  events.
- A page whose serialized size would exceed `MAX_HOST_OUTPUT_BYTES` is `too_large`; ask for
  fewer rows or `metadata_only`.
- **Rows may be materialization-stale, and unlike [§3.1](#31-get_document) this call does
  not force a flush.** It reads the indexes, and a query that forced a flush of every
  matching document would turn one filter into an unbounded write amplification. So
  `content`, `title` and `fm` here can trail the newest CRDT state by up to
  `MATERIALIZE_DEBOUNCE_MS` — including the *plugin's own* write from moments earlier,
  which `get_document` would have shown.

  This is only ever a cost, never a wrong answer, and only for a reconciler that compares
  rendered text against a queried `content`: a stale page makes it rewrite a document that
  did not need it, and the next run finds them equal. Write reconciliation so a redundant
  write is harmless — which is what "reconcile, never accumulate" asks for anyway — rather
  than trying to defeat the staleness. `get_document` is the read-your-writes path when one
  document's exact current text really matters.

Errors: `capability_denied`, `invalid_argument` (filter/sort), `too_large`, `unavailable`.

### 3.3 `create_document`

```json
{ "text": "---\ntitle: Standup\npath: calendar/work\ndate: 2026-09-24T09:00:00Z\n---\n\n# Standup\n", "id": null }
```

```json
{ "id": "01J8ZQ…", "title": "Standup", "materialized_version": "9f2c…", "changed": true }
```

- The document is **machine-owned** (SPEC §3.3): `created_by` is `plugin:<caller>`, and the
  owner may later rewrite it wholesale.
- `id` may be supplied so a retry after a timeout is idempotent — the second attempt gets
  `already_exists` instead of creating a duplicate. A graveyarded id is `gone` and must
  never be retried.
- Counts against both write caps (§5).

Errors: `capability_denied`, `invalid_argument`, `already_exists`, `gone`, `too_large`
(text over 1 MB), `limit_exceeded`, `unavailable`.

### 3.4 `splice_section`

```json
{ "id": "01J8ZQ…",
  "edits": [ { "key": "source_uid", "value": "2f1c…@google.com" },
             { "key": "sequence", "value": 3 },
             { "key": "obsolete_key", "remove": true } ] }
```

```json
{ "id": "01J8ZQ…", "materialized_version": "9f2c…", "edits_applied": 2, "changed": true }
```

**This is the only way a plugin may write inside a document a human owns** (SPEC §3.3), and
the section is **always the caller's own**:

> **Deliberate deviation from the SPEC's literal signature.** SPEC §6.3 spells it
> `splice_section(id, plugin_id, yaml_line_edits)`. The host supplies `plugin_id` from the
> calling instance, so it is **not on the wire**. A plugin that could name the section could
> write into another plugin's machine data, which is exactly the boundary the per-plugin
> section exists to draw.

- Line splices, one key per line, via `core::splice::splice_section` — so concurrent writes
  to different keys merge cleanly, and a same-key race resolves last-occurrence-wins
  (SPEC §3.3, §11.2). **Never** a whole-section rewrite.
- `value` and `remove` are separate fields: `{"key":"k","value":null}` writes `k: null`,
  `{"key":"k","remove":true}` deletes the line.
- Values must be scalars or flow sequences (the strict YAML subset of SPEC §3.4). A nested
  map is `invalid_argument` — it is not representable one-key-per-line.
- Keys must match `^[A-Za-z0-9_-]{1,64}$`.
- An edit whose value already matches writes nothing (`edits_applied` reflects that), so an
  idempotent sync produces no CRDT history.
- The whole decision — which keys differ, where the fence is, which byte spans to replace —
  is made **inside the document's lock**, against the text the write lands on. A byte offset
  only means something against the string it was computed from, so computing the spans from a
  text read a moment earlier let a concurrent human edit slide them: the plugin's one-line
  value landed over the tail of somebody's prose. That is well past what SPEC §11.2 accepts,
  which is losing one machine *value*. The same holds for the uninstall purge, which removes
  whole sections.

Errors: `capability_denied`, `invalid_argument`, `not_found`, `gone`, `too_large`,
`limit_exceeded`, `unavailable`.

### 3.5 `rewrite_document`

```json
{ "id": "01J8ZQ…", "text": "---\ntitle: Standup (moved)\n…" }
```

Answers `WriteDocumentOutput`. Legal **only** when `created_by == "plugin:<caller>"`
(SPEC §3.3: machine-owned documents "may be wholly authored/rewritten by their owning
plugin"); anything else is `forbidden`. Applied as one CRDT transaction against the live
document, so a concurrent human edit merges rather than vanishing.

There is deliberately **no `delete_document`**: see §8.

### 3.6 `kv_get` / `kv_set`

```json
{ "key": "feed.etag" }                      → { "key": "feed.etag", "value": "W/\"x\"", "found": true }
{ "key": "feed.etag", "value": "W/\"y\"" }  → { "key": "feed.etag", "existed": true, "keys": 3 }
{ "key": "feed.etag", "remove": true }      → { "key": "feed.etag", "existed": true, "keys": 2 }
```

Namespaced by the calling plugin — the namespace is not a parameter, so there is no query a
plugin could ask that reaches another's keys. **This is where high-frequency machine state
belongs** (SPEC §3.3): a sync cursor, an ETag, a `last_seen`. Uninstall retains KV by
default so a reinstall is lossless (SPEC §6.2).

Keys: `^[A-Za-z0-9._:-]{1,256}$`. Caps in §5.

Errors: `invalid_argument`, `too_large`, `limit_exceeded`, `unavailable`.

### 3.7 `config_get`

```json
{ "key": null }
{ "values": { "feed_url": "https://calendar.example.com/x.ics", "auth_header": "Bearer …" },
  "missing": ["folder"] }
```

Admin-entered configuration, **secrets decrypted** — that is the point of the feature
(SPEC §6.2: outbound HTTP with secrets is why backend plugins exist). `key` narrows to one
entry; the answer is always a map, so one typed accessor covers both.

`missing` lists declared keys with no value, so a plugin can report "not configured" rather
than failing opaquely. The SDK's `config::require_string` returns `invalid_argument` naming
the key, which is deliberately *not* a breaker-counting failure: a plugin waiting to be
configured is not a broken plugin.

**A `key` the manifest never declared is `invalid_argument` naming it** — not an empty map.
The two are different facts and the plugin cannot tell them apart from a result alone:
"nobody has filled this in yet" is a normal state it should report and wait through, while
"this key is not in my manifest" is a typo in the plugin, and returning the first for the
second means a config key silently reads as unset forever.

A value that is stored but cannot be **decrypted** is reported as *missing*, with a server
log line. That is the `SESSION_SECRET`-rotated-without-`CONFIG_KEY` case (`docs/OPERATIONS.md`,
secret rotation): the honest answer to the plugin is "not configured", so it degrades the
way it already knows how while an admin re-enters the value.

Secrets are **pulled, never pushed** (they are not in `lm_init`), never logged by the host,
and never placed in an error `detail`.

### 3.8 `emit`

```json
{ "event": "synced", "payload": { "created": 12 } }
→ { "event": "calendar:synced", "subscribers": 1 }
```

The **server-side** bus. The host prefixes the emitting plugin's id, so a plugin cannot
spoof another's event. Delivery is to plugins that declared the namespaced name in
`backend.events`, on their `lm_event` export, as a nested invocation (§6 depth and deadline
rules apply). Never delivered back to the emitter. `subscribers: 0` is normal.

### 3.9 `emit_client`

```json
{ "event": "synced", "payload": { "created": 12 }, "user_id": null }
→ { "event": "plugin:calendar:synced", "sockets": 3 }
```

Relayed to connected browsers over the sync socket as

```json
{ "t": "plugin.event", "plugin": "calendar", "event": "synced",
  "payload": { … }, "at": "2026-09-24T06:00:01Z" }
```

which an M2/M3 client ignores (PROTOCOL.md §9: *"Unknown `t` values: the client ignores
them (forward compatibility with M4 plugin channels)"*) and an M4 kernel delivers as
`kernel.events` type **`plugin:<id>:<event>`** with origin `{kind: "server", plugin: "<id>"}`
— the shape `web/kernel-api/src/events.ts` already declares.

`user_id` targets one user's sessions; absent reaches every connected session (this is a
shared workspace). **Ephemeral, no replay:** a client that was closed missed it, and a
socket whose send queue is full drops it (PROTOCOL.md §6). State belongs in documents.

### 3.10 `call_plugin`

```json
{ "plugin": "folders", "function": "normalize", "payload": { "path": "a//b" } }
→ { "value": "a/b" }
```

Three rules, three codes (SPEC §6.3):

| Rule | Refusal |
|---|---|
| the callee must be in the caller's manifest `dependencies` | `forbidden` |
| a plugin already on the call stack may not be re-entered | `reentrancy` |
| the chain may be at most 3 deep | `limit_exceeded` |

Plus: an unknown or backend-less callee is `not_found`, a disabled one (or one whose
breaker is open) is `unavailable`, and the callee's own refusal is forwarded with **its**
code. The callee **shares the caller's deadline** — see §5.

### 3.11 `http_request`

```json
{ "method": "GET", "url": "https://calendar.example.com/feed.ics",
  "headers": { "accept": "text/calendar", "if-none-match": "W/\"x\"" },
  "body_base64": null, "timeout_ms": 8000, "follow_redirects": true }
```

```json
{ "status": 200, "headers": { "etag": "W/\"y\"" },
  "body_base64": "QkVHSU4…", "body_bytes": 48211,
  "final_url": "https://calendar.example.com/feed.ics" }
```

The checks, **in this order** (the order is the security property):

1. `http` capability approved at all, else `capability_denied`.
2. URL parses; scheme is `http` or `https`; the **host is in the approved list** — exact,
   case-insensitive, no wildcards and no suffix matching. Else `blocked`.
3. The host resolves the name itself (Hickory) and checks **every** returned address against
   the IP policy. Else `blocked`.
4. The connection is made to the **pinned** address, so a name that passed cannot be
   re-resolved to something else between the check and the dial.
5. Every redirect hop repeats 2–4 (max 3 hops). A **redirect** is 301, 302, 303, 307 or
   308 — the codes that carry a `Location`. The other 3xx are answers and come back as
   they are: **304 Not Modified** in particular, which is the reply to the conditional
   `GET` above and the entire reason a plugin stores `etag`/`last-modified` between runs.
   (Following "every 3xx" looked for a `Location` a 304 never has, and refused the
   cheapest correct thing a plugin can do — on its *second* run, once it had a validator
   to send.) 300 and the deprecated 305 are likewise returned, not followed.
6. Timeout = `min(timeout_ms, PLUGIN_HTTP_TIMEOUT_MS, remaining invocation deadline)` — a
   `timeout_ms` may only *lower* the cap.
7. A response body over the cap is `too_large`. Never truncated.
8. At most **100 outbound requests per invocation** — `limit_exceeded` past that. The wall
   clock is not a request cap: a cron run has 60 s of it, which is thousands of requests
   aimed at whatever host an admin approved for a nightly feed fetch, and on a plugin with a
   public route the same loop is reachable once per inbound request. The number is far above
   the fetch-and-follow-redirects shape this capability exists for (the calendar makes one
   request per run) and far below a loop; a plugin that genuinely has to page through an API
   spreads the pages across cron runs, the same answer the per-call write cap gives.

**Credentials are not replayed across origins.** `authorization` is deliberately allowed on
the way out — outbound HTTP with secrets is why backend plugins exist — so a **cross-origin
redirect strips it** (along with `cookie` and `proxy-authorization`) before the next hop.
`reqwest`'s own redirect policy does this, and switching it off is unavoidable here: every hop
has to be re-checked before it is dialled. Being on the approved host list is not consent to
receive another host's credential, and an operator granting a second host has no way to know
that is what they would be granting.

**Refused by default** (the IP policy): loopback, unspecified, private (RFC 1918),
link-local (`169.254/16`, `fe80::/10`), site-local (`fec0::/10`), unique-local (`fc00::/7`),
CGNAT (`100.64/10`), multicast, documentation ranges, the discard prefix (`100::/64`), the
6to4 / Teredo / RFC 8215 NAT64-local prefixes whose embedded IPv4 cannot be read out
reliably, and the cloud metadata addresses.

**Every IPv6 encoding of an IPv4 address is re-checked as that IPv4 address**, not just the
mapped one: `::ffff:a.b.c.d` (RFC 4291), `::ffff:0:a.b.c.d` (RFC 2765), `::a.b.c.d`
(IPv4-compatible, deprecated but still routed) and `64:ff9b::a.b.c.d` (the NAT64 well-known
prefix, RFC 6052). The last is the one that matters in production: on an IPv6-only or
dual-stack host behind a DNS64/NAT64 gateway — the default in several managed Kubernetes and
IPv6-only cloud networks — `64:ff9b::a9fe:a9fe` *is* 169.254.169.254, and because the host
resolves then **pins** the address this check is the only defence. Checking only
`::ffff:` left three live routes to the metadata service the list exists to protect.

An operator may allow specific CIDRs with `PLUGIN_HTTP_ALLOW_CIDRS` (SPEC §6.2's
"admin-configurable allowlist") — that is how a self-hosted LAN service becomes reachable
deliberately. The metadata addresses stay refused inside a widened range, in every encoding:
"let my LAN through" never means "let the instance credentials through".

Request rules: at most 32 headers, 4 KiB each; `host` and the hop-by-hop headers are
refused; `authorization` is allowed (that is the point). `set-cookie` is stripped from the
response — a plugin does not run a cookie jar.

Errors: `capability_denied`, `blocked`, `invalid_argument`, `too_large`, `timeout`,
`unavailable`, `limit_exceeded`.

### 3.12 `log`

```json
{ "level": "info", "message": "imported 12 events" }
```

**Not in SPEC §6.3's list, and here anyway.** A Wasm module has no useful stdout: without
this, the only way to debug a plugin is to make it fail, and anything it printed would be
invisible in the server's structured JSON log (SPEC §8) — no plugin id, no request id, no
level, nothing to filter on. Messages are attributed (`plugin=calendar`), capped at 4 KiB
(truncated, not refused), and rate-limited to 100 lines per invocation.

---

## 4. Plugin exports

Fixed names, one per kind of invocation — the host must find them without reading Rust.
Every export takes one JSON payload and answers with an envelope.

| Export | Payload → Value | Required? |
|---|---|---|
| `lm_abi_version` | `null` → `1` | **Yes**, for any plugin with a backend half |
| `lm_init` | `InitPayload` → `null` | optional |
| `lm_hook_document_created` | `DocumentEvent` → `null` | if declared in `backend.hooks` |
| `lm_hook_document_changed` | `DocumentEvent` → `null` | ″ |
| `lm_hook_document_deleted` | `DocumentEvent` → `null` | ″ |
| `lm_cron` | `CronPayload` → `null` | if `backend.cron` is non-empty |
| `lm_http` | `HttpRouteRequest` → `HttpRouteResponse` | if `backend.routes` is non-empty |
| `lm_call` | `CallPayload` → any JSON | if dependents call it |
| `lm_event` | `EventPayload` → `null` | if `backend.events` is non-empty |

`lm_abi_version` is required because the manifest can lie and a stale `.wasm` can outlive
the manifest that describes it — the same belt-and-braces the frontend loader applies to a
stale offline bundle (SPEC §6.4). The install flow refuses a backend module without it, and
the host re-checks it at activation **before** running any of the plugin's own code.

One export per kind, rather than one per hook/route/job, keeps the export surface fixed:
the payload says which route, which cron slot, which function.

### 4.1 `lm_init`

```json
{ "plugin_id": "calendar", "version": "1.0.0", "abi_version": 1,
  "capabilities": { "documents": ["read","write"], "http_hosts": ["calendar.example.com"],
                    "public_routes": [], "notifications": false },
  "config_keys": ["feed_url", "folder"] }
```

Runs **once per instance**, not once per plugin — instances are pooled and recycled, so this
is for cheap preparation, not a migration. `capabilities` is what the admin **approved**, so
a plugin can degrade deliberately instead of discovering denials per call. A refusal here
marks the plugin failed.

"Once per instance" includes the instance activation warms to read `lm_abi_version` and the
export list: it is initialised on its way out of the pool for the first real call, not skipped
because some earlier code path already touched it. A plugin that caches `capabilities` in a
static can rely on that — it used to see its default on that one instance, which is the
silent degradation the payload exists to prevent.

### 4.2 Document hooks

```json
{ "event": "document.changed", "id": "01J8ZQ…",
  "origin": { "kind": "user", "id": "01HUSER…" },
  "at": "2026-09-24T09:12:03Z", "seq": 48213, "coalesced": 3,
  "document": { … } }
```

The rules, and what each costs (SPEC §6.3):

- **At-most-once, fire-and-forget, no retry.** Failures are logged and counted on the
  breaker. A plugin that must not miss a change reconciles on its cron run — which is why
  the calendar plugin does a full reconciliation rather than trusting hooks.
- **Debounced 2 s per document**, with `coalesced` saying how many changes the delivery
  stands for, and a 30 s ceiling so a continuously-edited document still delivers.
- **Never delivered to the plugin that caused the change.** Origin comes from the row's
  `updated_by`/`deleted_by` (`Actor::as_stored`), which is "the last applier the server saw"
  (SPEC §3.5). *Known consequence:* when a user and a plugin both touch one document inside
  the debounce window, the last applier wins the attribution, so a delivery can be
  suppressed for a change the user made. Per-hook origin tracking through the CRDT costs
  far more than a two-second edge case is worth, and the per-document write cap catches the
  loops this misses.
- **Ordering is per-document only.** There is no global order; nothing may assume one.
- **`document` is capability-gated.** Without `documents: ["read"]` the payload carries the
  id, origin and seq and nothing else — a hooks-only plugin must not read the workspace
  through the side door (SPEC §6.2). It is also absent on `document.deleted`.
- **A purge is not a hook.** It happens 30 days after the `document.deleted` that already
  fired; there is nothing useful to do with it.

### 4.3 Cron

```json
{ "expression": "0 6 * * *", "index": 0,
  "scheduled_for": "2026-09-24T06:00:00Z", "fired_at": "2026-09-24T06:00:01Z",
  "last_run": "2026-09-23T06:00:00Z", "missed": 0, "deadline_ms": 60000 }
```

- **UTC. Five standard fields**, `* , - /` and three-letter month/day names. No `@daily`,
  no seconds field, no `L`/`#` — an unsupported expression is an install error, so a
  manifest cannot mean two different things on two servers.
- Day-of-month and day-of-week are **OR'd** when both are restricted (Vixie cron):
  `0 0 1 * MON` is the first of the month *and* every Monday.
- **Missed runs are skipped**: a server down for a day fires each expression once when it
  returns, with `missed` counting the slots it slept through — enough for a sync job to
  choose a full reconciliation.
- **No overlapping executions** per expression; a slot arriving while the previous run is
  in flight counts as missed. That is a property of the *job*, not of the scheduler, so the
  admin screen's "run cron now" takes the same claim and answers `409` when a run is already
  going — a manual run racing the scheduled one gave the calendar two reconciliations that
  both read the pre-write state and both created a document per event.
- `last_run` is persisted on the plugin's record, so a restart does not re-fire.
- Dispatch on `index`, not on the clock: it is stable across restarts and reformatting.

### 4.4 Inbound HTTP routes

Declared as `backend.routes: ["POST /webhook", "GET /status"]`; reachable at
`/api/plugins/<id>/<path>`. **Session-authenticated by default**; a path also listed in
`capabilities.public-routes` is reachable without a session and is shown to the admin as the
capability it is (SPEC §5.1, §6.2). **What decides is the approved set, not the manifest's
request:** an admin may uncheck a requested public route at approval, and then it needs a
session like any other.

Rate-limited per plugin per client — 120 requests a minute. The client is the session's user
when there is one, and otherwise the address the *server* established
(`TRUST_PROXY_HEADERS`), never a `X-Forwarded-For` hop a caller wrote: a bucket per forged
header is not a cap.

```json
{ "method": "POST", "path": "/webhook", "query": { "token": "…" },
  "headers": { "content-type": "application/json" },
  "body_base64": "eyJ…", "public": true, "user": null, "request_id": "01JREQ…" }
```

```json
{ "status": 202, "headers": { "content-type": "application/json" }, "body_base64": "eyJ…" }
```

- `path` is the path **inside** the plugin's namespace, always leading-slash, never `..`.
- `cookie` and `authorization` are **stripped** on the way in: a plugin does not need this
  app's session credential, and one that could read it could impersonate the caller against
  the rest of the API. Identity arrives as `user`.
- `set-cookie`, `content-length` and hop-by-hop headers are stripped on the way out — a
  plugin must not mint cookies for this origin.
- The answer goes out on the **app's own origin** with a `Content-Type` the plugin chose, so
  the host adds `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox;
  default-src 'none'` (an opaque origin — nothing rendered here can reach this origin's
  cookies, storage or API) and `Content-Disposition: attachment` for anything outside the
  inline allowlist. A route answering `text/html` — or a *public* route reflecting a query
  parameter into an error page — would otherwise be script running with the session cookie,
  and the attacker would need no session of their own. JSON, CSV, images, PDF and plain text
  render inline; `text/html`, `application/xhtml+xml` and `image/svg+xml` never do.
- Status outside 200–599, or an unreadable answer, becomes a `502`.

| Cause | Status |
|---|---|
| unknown plugin, no backend half, or no matching route | 404 |
| route needs a session, none given | 401 |
| plugin disabled, breaker open, pool exhausted | 503 |
| deadline exceeded | 504 |
| trap or unreadable answer | 502 |
| plugin refused with a code | that code's status |

### 4.5 Invoked calls and events

```json
{ "function": "normalize", "payload": { … }, "caller": "calendar", "depth": 1, "deadline_ms": 3400 }
{ "event": "calendar:synced", "payload": { … }, "origin": { "kind": "plugin", "id": "calendar" }, "at": "…" }
```

---

## 5. Limits

Every number is a constant in
[`plugin-abi::limits`](crates/plugin-abi/src/limits.rs), readable from both sides so a
plugin can respect a cap instead of discovering it. Configuration may **lower** a cap, never
raise it.

| Limit | Value | Env |
|---|---|---|
| per-call wall clock | 5 s | `PLUGIN_CALL_TIMEOUT_MS` |
| cron wall clock | 60 s | `PLUGIN_CRON_TIMEOUT_MS` |
| memory per instance | 128 MB | `PLUGIN_MEMORY_BYTES` |
| epoch interruption tick | 10 ms | — |
| instances per plugin | 4 | `PLUGIN_MAX_INSTANCES` |
| wait for a free instance | 1 s → `unavailable` | — |
| idle instance eviction | 5 min | — |
| breaker threshold | 5 consecutive failures | `PLUGIN_BREAKER_THRESHOLD` |
| `call_plugin` depth | 3 | — |
| host-call input / output JSON | 2 MiB / 16 MiB | — |
| query page | 50 default, 200 max | — |
| document writes per call | 500 | — |
| writes per (plugin, document) per minute | 10 | — |
| document text | 1 MB | `MAX_DOCUMENT_BYTES` |
| section edits per call | 200 | — |
| KV: key / value / keys per plugin | 256 B / 64 KiB / 1 000 | — |
| event payload | 64 KiB | — |
| HTTP: timeout / response / request body / redirects | 10 s / 10 MB / 1 MB / 3 | `PLUGIN_HTTP_*` |
| outbound requests per call | 100 | — |
| route body / response headers / requests per minute | 1 MB / 16 / 120 | — |
| package: archive / uncompressed / entries / entry | 20 MB / 50 MB / 2 000 / 25 MB | — |

**One deadline per top-level invocation, shared by the whole chain.** A three-deep
`call_plugin` chain does **not** get 15 seconds; a callee sees the remaining budget in
`deadline_ms` and should refuse rather than be interrupted mid-write. An outbound HTTP
timeout is likewise capped by what is left, so a 10 s request cannot outlive a 5 s hook.

**The circuit breaker** (SPEC §6.3) counts *host-side* failures — timeout, trap, unreadable
answer, instantiation failure, pool exhaustion — and **not** a plugin's refusal:
`ErrorCode::is_plugin_fault` is the split, and a plugin is never disabled for correctly
reporting that a document does not exist. Five in a row disables it, with the reason
persisted on its record and **manual re-enable only** — a plugin that has failed five times
has probably been writing nonsense into documents, and an operator should look before it
writes more.

---

## 6. Errors

```json
{ "code": "capability_denied", "message": "…", "detail": { "capability": "documents:write" } }
```

Codes are stable and **append-only**:

| Code | Means | Breaker? |
|---|---|---|
| `capability_denied` | the capability is not approved (fix the manifest / the approval) | no |
| `blocked` | the capability is approved, **this destination** is refused | no |
| `forbidden` | ownership: another plugin's document, an undeclared dependency | no |
| `not_found` | no such document, plugin, function or route | no |
| `gone` | the id is in the permanent graveyard | no |
| `already_exists` | that document id is taken | no |
| `invalid_argument` | malformed JSON, id, filter, key — or config not set | no |
| `too_large` | over a size cap | no |
| `limit_exceeded` | over a rate or count cap | no |
| `reentrancy` | a call into a plugin already on the stack | no |
| `timeout` | the invocation's deadline, or an HTTP timeout | **yes** |
| `unavailable` | Mongo, a disabled callee, an exhausted pool | **yes** |
| `internal` | anything else; never leaks server internals | **yes** |

`capability_denied` vs `blocked` is worth internalising: the first means *my manifest is
wrong*, the second means *my URL is wrong*.

---

## 7. The manifest's backend half

```json
{
  "id": "calendar", "version": "1.0.0", "kernel": "^1.0",
  "dependencies": { "router": "^1.0" },
  "capabilities": {
    "documents": ["read", "write"],
    "http": { "hosts": [] },
    "public-routes": [],
    "notifications": false
  },
  "config": {
    "feed_url": { "type": "string", "required": true },
    "auth_header": { "type": "string", "secret": true }
  },
  "backend": {
    "module": "backend.wasm",
    "hooks": ["document.deleted"],
    "cron": ["0 6 * * *"],
    "routes": ["POST /sync", "GET /status"],
    "events": []
  },
  "frontend": { "module": "frontend/index.mjs", "style": "frontend/style.css" }
}
```

### 7.1 Install validation

In order, and the first four happen **before anything is extracted**:

1. `manifest.json` parses, ≤ 256 KiB; `id` matches `^[a-z0-9][a-z0-9-]{0,63}$`; `version`
   is `x.y.z` with an optional `-prerelease` / `+build` tail of dot-separated alphanumeric
   identifiers — **every character checked**, because the version becomes a filesystem path
   component (`<PLUGINS_DIR>/<id>/<version>/…`, the staging tree, the asset URL) and must be
   one harmless segment.
2. `kernel` range admits this server's kernel version.
3. `dependencies` resolve against the installed set, and the graph is acyclic.
4. `peerLibraries` ranges intersect with what the runtime bundle provides — one version of
   each library for every plugin, chosen once, because an import map cannot change after
   load (SPEC §6.4). Checked against the **version** the bundle shipped, which the runtime
   build records in `runtime-manifest.json` next to each specifier's URL; a bundle with no
   recorded version degrades to the presence check and says so in a warning. Resolution runs
   over the plugins that will actually *load* (`enabled`), the same set the boot-time check
   uses, so an install is never refused for a conflict with a disabled plugin.
5. `capabilities` are well-formed: only `read`/`write` in `documents`, every
   `public-routes` entry also in `backend.routes`, every `http.hosts` entry a bare host name
   (no scheme, no path, no port wildcard).
6. `backend.hooks` are known names; `backend.cron` expressions parse; `backend.routes` parse
   as `METHOD /path`.
7. The declared `backend.module` exists in the archive, ≤ 25 MB, and its
   `lm_abi_version` export answers a major this server speaks.

### 7.2 Approval, and the one capability an admin may widen

Both install paths (admin upload, directory drop) land as **pending**, and activation is an
explicit admin click (SPEC §6.2). The approval screen shows the requested capability list
verbatim, and says in those words that installing a plugin runs its **frontend** code
unsandboxed in every user's session — capabilities gate the *server* half only (SPEC §6.1).

The approved set may **narrow** anything. It may **extend** exactly one field:
`http.hosts`.

> A plugin whose destination is admin-configured cannot know its host when it is packaged.
> The calendar plugin is exactly that case: it ships `"hosts": []` and the operator who
> enters a feed URL is the one who knows the host. The alternative is asking every operator
> to repackage a zip, which they would do by turning the check off. Widening anything else —
> a `documents` right, a public route the package never declared — is refused: those are the
> package's own claims about itself.

### 7.3 Uninstall

KV and in-document `%%%` data are **retained by default** so a reinstall is lossless. An
explicit checkbox purges KV and queues a background job stripping the plugin's `%%%`
sections through CRDT transactions, one document per transaction (SPEC §6.2).

---

## 8. Not in the ABI, and why

- **`delete_document`.** SPEC §6.3's host-function list has none, and destructive actions
  are a user's with an audit trail (SPEC §5.4). A plugin whose upstream item vanished marks
  it (`status: cancelled` in its own section, `fm` as it likes) instead of removing a
  meeting from someone's workspace because a feed hiccuped. **Open for v2** if a real case
  needs it; it would need an owner check like `rewrite_document` plus an audit entry.
- **`kv_list` / a KV prefix scan.** Not in the SPEC's list, and the one use case (a
  uid → document-id index) is better served by `query_documents` on the plugin's own
  section: the projection already knows, and a 5 000-entry index would blow the value cap.
- **Reading another plugin's KV or config.** By construction, not by check.
- **A plugin-defined extension point on the server.** Extension points are a *frontend*
  concept (SPEC §6.4); on the server, `call_plugin` over a declared dependency is the whole
  composition story.
- **Web Push / device registration.** v2 (SPEC §7, §10). `emit_client` reaches *connected*
  sessions only, and says so.
- **Anything scheduled finer than a minute.** Cron is minute-resolution; a plugin needing
  seconds is asking for a worker the server does not offer.

---

## 9. Writing one

```rust
use life_manager_plugin_sdk as lm;

lm::abi_version!();                       // required

lm::cron!(sync);
fn sync(schedule: lm::abi::cron::CronPayload) -> lm::Result<()> {
    let url = lm::config::require_string("feed_url")?;
    let mut headers = lm::abi::JsonMap::new();
    if let Some(etag) = lm::kv::get_string("feed.etag")? {
        headers.insert("if-none-match".into(), etag.into());
    }

    let response = lm::http::get_with_headers(&url, headers)?;
    if response.status() == 304 {
        lm::log::info("feed unchanged");
        return Ok(());
    }
    let body = response.error_for_status()?.text()?;

    // … parse, then write documents: create_document for new ones,
    //   splice_section for bookkeeping, rewrite_document for changed ones.
    let _ = body;

    lm::kv::set("feed.last_sync", &schedule.fired_at)?;
    lm::events::emit_client("synced", &serde_json::json!({ "at": schedule.fired_at }))?;
    Ok(())
}
```

Build and check:

```text
mise run wasm-plugins    # build every backend half into the installed layout
mise run plugin-check    # fmt + clippy for the SDK and the plugin crates (wasm32)
mise run plugin-test     # host-target tests for the pure crates (the ICS parser)
mise run plugin-smoke    # build hello-backend and load it in a minimal Extism host
```

**Keep the testable logic out of the wasm crate.** A plugin crate cannot be unit-tested on
the host target — it links the Extism host imports — so pure logic belongs in a plain crate
beside it (`plugins/base/calendar/ics` is the pattern) and the wasm crate stays glue.
