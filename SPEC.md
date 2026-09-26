# Life Manager — Project Specification

**Status:** v2 spec, 2026-09-23 — v1 revised after adversarial review (see `review/CRITIQUE.md`, `review/GAPS.md`; all findings triaged with the owner)
**License:** open source, permissive (dual MIT / Apache-2.0)
**One-liner:** A highly extensible, offline-first, collaborative document manager built as a microkernel — the visible app is just the default set of plugins.

---

## 1. Vision

Everything is a document: **one markdown text file** — body, YAML frontmatter at the top, machine data in fenced sections at the bottom. Everything else is a plugin: the editor, the sidebar, the navbar, dashboards, automations. The core ("kernel") does exactly one thing well — CRDT-synced storage of a shared document set with a plugin runtime on both server and client.

A plugin is installed **once, on the server**, and every client falls in step: the server hot-loads the backend half and serves the frontend half to all connected clients.

**The preferred plugin pattern: share state through documents.** When a plugin's backend and frontend halves need to share data, the backend writes *documents* (a feed importer syncs an ICS calendar into one note per event); the existing sync carries them to every client, offline included, searchable and editable like everything else. Custom channels (events, KV) are for what genuinely can't be a document.

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────┐
│ Flutter Shell (optional, per-device)            │
│  webview + OTA bundle updater + capability      │
│  bridge (native APIs exposed to JS)             │
├─────────────────────────────────────────────────┤
│ React PWA (works standalone in any browser)     │
│  microkernel: projection store, doc sync,       │
│  plugin loader, extension registry, event bus   │
│  + shared Rust core compiled to Wasm            │
│  + default plugin distribution                  │
├─────────────────────────────────────────────────┤
│ Rust Server (single binary, single replica)     │
│  REST API + WebSocket sync (yrs) + auth         │
│  + Wasm plugin host (Extism) + plugin registry  │
│  + serves the PWA bundle & plugin modules       │
├─────────────────────────────────────────────────┤
│ MongoDB (+ GridFS for attachments)              │
└─────────────────────────────────────────────────┘
```

**The server's identity:** everything it does serves one of two purposes — *keep replicas converging* (sync authority, attachment store, compaction/snapshots/graveyard, materialized indexes) or *keep clients in step* (plugin runtime + distribution, PWA bundle serving, auth/capability gatekeeping). **The kernel knows exactly one domain model — a document is text (body + frontmatter + machine sections) — and nothing above it.** It doesn't know what a task, folder, or theme is. A proposed server feature that fits neither purpose belongs in a plugin.

Key properties:

- **Microkernel:** the kernel API is small, versioned, and the only public contract. All UI and features are plugins; the built-in ones are replaceable by design.
- **Universal plugins:** one package = backend Wasm module + frontend React ES module, installed server-side; no client rebuilds.
- **Offline-first:** every document readable and searchable offline; recently-opened documents editable offline; merges via CRDT.
- **Shared workspace:** all authenticated users see — and can edit or delete — every document. This is an explicit v1 decision; destructive/administrative actions are recorded in an audit log (§5.4). ACLs are v2, and the sync design (§4) deliberately keeps them possible.

**The shared Rust core.** The frontmatter parser, `%%%` section parser, title resolver, and filter evaluator are written **once, in Rust**, used natively by the server and compiled to **Wasm for the client kernel**. Parity between offline and online behavior is by construction, not by test suite. (A conformance corpus still exists as a regression net.)

## 3. Document Model

### 3.1 A document is one text file

```markdown
---
title: Groceries
path: home/lists
date: 2026-09-23
---

# Groceries

- [ ] milk
- [x] bread

%%% calendar
source-uid: abc123@google.com
%%%
```

Three regions of one string:

1. **Frontmatter** — a leading `---` YAML block. Human-owned metadata.
2. **Body** — markdown.
3. **Machine sections** — trailing `%%% <plugin-id> … %%%` fences, one per plugin. Machine-owned data (replaces the earlier structural `plugins` map). Hidden in read mode, collapsed in the editor.

The whole document is portable plain markdown (Obsidian-compatible for regions 1–2); export = the text.

### 3.2 CRDT representation (source of truth)

Each document is **one Yjs doc containing one `Y.Text`** — the entire text, all three regions. Character-level insert/delete merging throughout.

Pinned compatibility decisions (client Yjs ↔ server yrs):

- yrs configured with **`OffsetKind::Utf16`** to match Yjs (index-based operations corrupt multi-byte text otherwise).
- **Update encoding v1** everywhere: wire, stored blob, update log, REST representation.
- GC settings identical on both sides.
- **Awareness frames are relayed opaquely** by the server — never parsed. (Presence UI is v2; the protocol slot costs nothing.)

Accepted caveat: concurrent edits to the same syntax markers can merge into briefly malformed markdown. Deterministic, lossless, human-fixable.

### 3.3 Frontmatter and machine sections — who writes what

- **Humans own frontmatter** (in human-authored documents). No API or plugin performs parse→re-serialize→replace on the block — that round-trip destroys comments and formatting, and whole-block replacement corrupts under concurrent edits. UI features that set fm values (properties panel, folders drag) perform **minimal text splices**: replace only the affected key's value span, via a kernel-provided splice helper.
- **Machines own their `%%%` section**, one fenced section per plugin id. Format: **YAML, one key per line**. Writes are **line splices** (touch only changed keys' lines), never whole-section rewrites, via the kernel splice helper. Merge semantics fall out of the text CRDT: different keys = different lines = clean merges; concurrent same-key writes leave duplicate lines resolved deterministically as **last occurrence wins** (the next write cleans up). This reconstructs per-key LWW on plain text.
- **Machine-owned documents** (created and maintained by a plugin — e.g. imported calendar events) may be wholly authored/rewritten by their owning plugin, frontmatter included.
- **High-frequency machine state does not belong in documents** (CRDT history bloat) — use plugin KV (§6.3).

### 3.4 Parsing, hardening, title

The shared Rust core parses, with the same code on both sides:

- **Strict YAML subset:** block mappings, flow sequences, scalars typed string/int/float/bool/null. No anchors, aliases, merge keys, tags, multi-doc, block scalars. Duplicate keys: last wins.
- **Per-line tolerant parsing (stateless):** a malformed line is dropped and recorded; remaining keys parse. Deterministic on any input — a mid-edit broken quote never makes client and server disagree.
- **Hardening caps** (enforced at parse): frontmatter block ≤ 64 KB, ≤ 200 keys, nesting ≤ 5, arrays ≤ 1000 items, string values ≤ 8 KB. Keys must match `^[A-Za-z0-9_-]{1,64}$`; non-conforming keys are dropped from `fm` (text untouched), `fm_parse_error` set.
- **Fence rules (byte-exact, both sides):** frontmatter opens only if `---` is the literal first line; closes at the next `---` line; CRLF normalized; no BOM special-casing beyond stripping. `%%%` sections: last contiguous run of `%%% <id>`…`%%%` fences at end of document.
- **Dates:** ISO-8601 strings, normalized to a canonical form at materialization so lexicographic sort is correct; the filter DSL has an explicit date type.
- **Title resolution** (materialized, indexed, identical in kernel): `fm.title` → first ATX heading → first non-empty body line (truncated 120 chars) → `"Untitled"`.

### 3.5 Persistence (MongoDB)

The CRDT state is authoritative; everything else is derived.

Collection `documents`:

```
{
  _id: "<ulid>",             // client-mintable offline; server stamps timestamps on receipt
  crdt: BinData,             // encoded Yjs state (compacted)
  state_vector: BinData,     // cache, derivable from crdt; written in the same write
  content: "…",              // materialized full text
  title: "…",                // materialized (indexed)
  fm: { … },                 // materialized from frontmatter
  plugins: { … },            // materialized from %%% sections
  materialized_version: "…", // state-vector hash; staleness detection
  fm_parse_error: bool,
  created_at/by, updated_at/by,   // *_by = last applier the server saw, not authorship
  deleted_at/by                    // tombstone (Trash)
}
```

**Materialization is debounced but atomic-with-itself.** The synchronous path per applied update is: apply to the hot doc + append to the update log (durability + broadcast). `content`/`title`/`fm`/`plugins` are rewritten together, coalesced per document (~500 ms, forced flush on idle, subscriber-drop, and shutdown). They can trail the newest CRDT state (marked by `materialized_version`) but are **never inconsistent with each other**. REST `GET`/queries may force a flush for read-your-writes. Re-parse of fm/`%%%` is skipped when the post-apply text delta doesn't intersect those regions or their fences.

Supporting collections:

- `document_updates` — incremental Yjs updates, **normal collection, trimmed per-document** (keep last N bytes/updates per doc; never a capped collection). Fallback when a client predates the window: full state-vector sync against `crdt`. Correctness never depends on retention.
- `document_snapshots` — **per-document retention** (last 20 + one per day for 30 days), taken on a time/change policy (first edit after quiescence, daily cap) — decoupled from compaction. Restore = CRDT transaction replacing the full text (fm included); warns if other users are actively subscribed.
- `deleted_ids` — **permanent graveyard** (id + deleted_at/by). Consulted by every sync/create path; a long-offline client can never resurrect a deleted document. Trash view shows tombstoned docs for 30 days (restorable), then the doc purges but the id stays forever.
- `users`, `sessions`, `invites`, `plugins`, `plugin_kv`, `plugin_config`, `audit_log`, `attachments`, `meta` (schema version).

**Migrations:** `meta.schema_version`; ordered idempotent migrations run at boot under an advisory lock; server refuses to start if DB is newer than the binary. All indexes declared in one list, created idempotently at boot.

**Limits (hard, enforced, client-visible errors):** document text ≤ 1 MB (Mongo's 16 MB ceiling stays far away; `crdt` monitored, compacted aggressively above 4 MB, alerting above 8 MB; GridFS spill is the named escape hatch). Attachments ≤ `MAX_ATTACHMENT_BYTES` (default 25 MB), streamed to GridFS without buffering, MIME sniff-checked.

### 3.6 Attachments

Binary files live in GridFS, outside the CRDT. Simple sync: whole-file, revision check, ask the user on collision.

- Metadata: `{ _id: ulid, name, mime, size, sha256, revision, created/updated at/by }`.
- Referenced as `attachment://<ulid>`; the `markdown` plugin renders (images inline, chips otherwise). Since `%%%` sections are part of `content`, orphan scanning of materialized text covers plugin-held references automatically.
- Upload/replace with `If-Match: <revision>`; 409 → client prompts keep-server / overwrite / keep-both. Identical `sha256` auto-resolves.
- Client cache: lazily fetched on first render + **opt-in background prefetch with a size budget** (setting); a missed file offline renders a "not available offline" chip. Never inline-serve `image/svg+xml` (stored-XSS vector): `nosniff` on everything, `Content-Disposition: attachment` except an allowlist of safe inline types.
- Deletion explicit; background job flags orphans in admin; no auto-delete.

**Attachments appear in the workspace as wrapper documents.** A standalone upload ("add file to workspace") creates a regular markdown document representing the file — `fm.title` from the filename, `fm.path` if uploaded into a folder, body embedding `attachment://<ulid>` — so folders, search, tags, Trash, `doc://` links, and the properties panel all apply to files with zero special-case machinery; the `viewer` renders a wrapper document as a full-page file preview. Pasting a file *into an existing document* only embeds it (no wrapper — doc lists don't drown in screenshots), and a **"promote to document"** command on any embedded attachment creates the wrapper later and replaces the embed with a `doc://` link to it. Trashing a wrapper trashes the file reference; blobs nothing references surface in the orphan view. This removes the one object that was "served like a document but wasn't one."

## 4. Sync & Offline

### 4.1 Replication model: projection + lazy CRDTs

Clients do **not** replicate CRDT state for the whole workspace (2–10× plaintext, OOM territory in a webview, and forecloses ACLs). Instead:

- **The projection** — `{_id, title, fm, plugins, content (plain text), updated_at, deleted}` — replicates to every client over a **workspace change feed**: a single sequence-numbered stream; reconnect = "everything since seq X", one round trip. Stored in one IndexedDB store. This is ~1× the size of the actual notes and powers everything read-only: **every document is readable and searchable offline.**
- **Full Y.Docs hydrate lazily** — fetched when a document is opened for editing, LRU-cached (~20 in memory), persisted locally for recently/currently edited docs. **Editable offline = documents you've opened**; an unopened document is read-only offline until reconnect.
- Deletions propagate through the feed (tombstone flag); the client drops local replicas of deleted docs — if one held unsynced edits, the user is offered "restore your version as a new document" before discard.
- ACLs in v2 become a server-side filter on the feed — no protocol rewrite.
- Bulk cold start: `GET /api/sync/bootstrap` streams the projection paged, with a first-run progress screen. Target: 5,000 docs < 30 s on LAN.

### 4.2 Local query engine

The kernel materializes nothing itself — the projection *is* materialized. It maintains: the **shared Wasm filter evaluator** over projection rows, and a **full-text index** (MiniSearch or equivalent) built in a Web Worker, persisted and incrementally updated (never a cold-start main-thread rebuild). `documents.query` and search run locally, online or offline, with live-updating subscriptions. The server's query endpoints exist for scripts, integrations, and backend plugins — the PWA does not browse through them.

**The filter language is ours, not Mongo's.** A small DSL with unambiguous, documented semantics: same-type comparisons only, explicit `contains`/`any` for arrays, explicit `missing` vs `null`, explicit date type. Evaluated by the shared Rust core on the client; **compiled to Mongo queries** on the server. (Mongo's implicit-array/type-bracketing semantics are explicitly not the contract.)

### 4.3 Transport

- WebSocket `/api/sync`: the change feed + per-document CRDT sync (y-protocols) for hydrated/open docs + opaque awareness relay + plugin events.
- **Auth at upgrade** (cookie or bearer token) with a mandatory **Origin allowlist** (`APP_ORIGIN`); session re-validated every 5 min and on revocation — close code `4401` → client re-auths (never clears IndexedDB; see §5.3).
- **Backpressure:** bounded per-connection send queues; on overflow, drop buffered updates and instruct a state-vector resync. Max frame 4 MB; inbound rate caps. Reconnect with exponential backoff + jitter (every deploy drops all sockets — single replica).
- Multi-tab: capped concurrent sockets per session (8); SharedWorker single-connection is v2.
- Server keeps hot docs behind a **per-document actor** (all writers — WS, REST, Wasm — serialize through it) with optimistic concurrency on the Mongo write; rooms evict 10 min after last subscriber, post-flush.

## 5. Rust Server

**Stack:** `axum` + `tokio`, `mongodb`, `yrs`, `extism`, `tower-sessions` (Mongo-backed), `argon2`, `rust-embed`. The shared core is a workspace crate compiled natively here and to Wasm for the kernel.

### 5.1 REST API

All under `/api`, authenticated (session cookie or bearer token). WebSocket is the app's channel; REST serves scripts, integrations, plugins, initial loads.

| Route | Behavior |
|---|---|
| `GET /api/documents` | List/query: `filter` (the DSL, §4.2), `search`, `sort`, `cursor`/`limit`. |
| `POST /api/documents` | Create (full text body). Existing `_id` → 409 (idempotent client retries); graveyarded `_id` → 410. Server stamps timestamps. |
| `GET /api/documents/:id` | Materialized JSON (may force a flush). `?format=crdt` returns encoded CRDT state. |
| `PUT /api/documents/:id` | Replace the full text (one CRDT transaction). |
| `PATCH /api/documents/:id` | Body-text-level only: `{"content": …}` replaces text. **No `fm`/`plugins` patching** — machines write via `%%%` splices or own whole documents (§3.3). |
| `DELETE /api/documents/:id` | Tombstone → Trash (30 d) → purge; id → graveyard forever. |

Attachments: `POST /api/attachments` (streamed multipart), `GET /:id` (+`/meta`), `PUT /:id` (`If-Match` revision), `DELETE /:id`, `GET /` (admin/orphans).

Auth: `register` (first user → admin; else invite token), `login` (returns session cookie, or bearer token for shells), `logout`, `me`, `POST /api/auth/password` (change, requires current).

Admin: invites (7-day expiry, single-use, listable, revocable, non-admin only), users (admin flag toggleable; last admin undeletable/undemotable; deleting a user revokes sessions, keeps attribution ids rendered "deleted user"), `POST /api/admin/users/:id/reset` (one-time reset link), plugin management, audit log, `GET /api/admin/export` (zip of every document as plain markdown — the no-Mongo disaster-recovery path).

Break-glass: `life-manager reset-password --email …` CLI subcommand.

Plugin routes `/api/plugins/:id/*`: session-authenticated by default; manifest may declare specific **public routes** (surfaced at install as a capability); rate-limited; namespaced by plugin id.

### 5.2 Auth mechanics

- argon2id (m=19456 KiB, t=2, p=1); per-IP + per-account backoff on failed logins; attempts logged.
- Browser: HTTP-only, `Secure`, `SameSite=Lax` cookies; rolling sessions, 30-day idle / 180-day absolute.
- **Shell: bearer tokens** (local-file webviews can't use cookies) — issued at login, stored in native secure storage, sent as `Authorization` and as WS subprotocol. Server supports both from M1.
- `SESSION_SECRET` required, ≥ 32 bytes, no default; rotation documented as "logs everyone out".

### 5.3 Session vs local data

A 401 on reconnect **never clears local data** — the client shows re-login and resyncs after. Logout with unsynced changes warns and blocks until synced or explicitly discarded; logout then clears local replicas (shared-device safety).

### 5.4 Shared-workspace consequences

Any user can edit or delete any document — stated, intended, v1. `audit_log` records destructive/administrative actions (doc delete, restore, user/invite/plugin operations) with an admin view.

## 6. Plugin System

### 6.1 Principles

- Plugins are first-order citizens; the base distribution is installed like any other plugins and individually replaceable.
- Plugins depend on plugins (semver); server resolves the graph at install; both sides load in topological order.
- Interaction only through the kernel registry — never direct imports or direct Wasm linking.
- **Trust model, stated plainly:** installing a plugin runs its frontend code unsandboxed in every user's session — full DOM, workspace, and credentials. `capabilities` gate *server host functions* and *native bridge calls* only. The install UI says exactly this. Frontend isolation is v2 research. Recovery: **safe mode** — `?safe=1` boots base plugins only, `?safe=bare` boots a minimal built-in plugin manager; `DISABLE_PLUGINS=1` server-side.

### 6.2 Package, manifest, capabilities

```
my-plugin-1.2.0.zip
├── manifest.json
├── backend.wasm        # optional — Rust → wasm32, Extism PDK
└── frontend/
    ├── index.mjs       # optional — ES module, React
    ├── style.css       # optional — linked on activation
    └── …assets
```

```json
{
  "id": "my-plugin",
  "version": "1.2.0",
  "kernel": "^1.0",
  "dependencies": { "folders": "^2.0" },
  "peerLibraries": { "@codemirror/view": "^6" },
  "capabilities": {
    "documents": ["read", "write"],
    "http": { "hosts": ["calendar.google.com"] },
    "notifications": true,
    "public-routes": ["/webhook"]
  },
  "config": { "feed_url": { "type": "string" }, "api_key": { "type": "string", "secret": true } },
  "backend": { "module": "backend.wasm", "hooks": ["document.changed"], "cron": ["0 6 * * *"] },
  "frontend": { "module": "frontend/index.mjs" }
}
```

- **Capabilities are parameterized and enforced.** `http` requires declared hosts; loopback/link-local/RFC1918/metadata destinations blocked by default (admin-configurable allowlist), resolve-then-pin, 10 s timeout, 10 MB response cap. `documents:read`/`write` gate the document host functions — a cron-and-KV plugin can't silently read the workspace. Undeclared host functions are linked as **erroring stubs** (so optional use is possible; instantiation never fails on imports).
- **Install approval — both paths:** admin upload and directory drop both land as *pending* in admin, showing the full capability list; activation is an explicit admin click. Zip handling hardened: manifest validated first; reject absolute paths/`..`/symlinks/entries outside `frontend/**` + declared wasm; caps on uncompressed size (50 MB), entry count, per-entry size; extract to temp, atomic rename; watcher waits for a stable file. Installs are serialized through a Mongo-locked queue; partial installs roll back.
- **Admin config & secrets:** manifest-declared `config` schema → admin-only UI → `plugin_config`, readable by the backend half; `secret: true` values are write-only in UI and encrypted at rest (`CONFIG_KEY`, falling back to a key derived from `SESSION_SECRET`).
- **Uninstall** retains KV and in-document `%%%` data by default (lossless reinstall); an explicit checkbox purges KV and queues a background job stripping the plugin's `%%%` sections via CRDT transactions.

### 6.3 Backend plugins (Extism Wasm)

Their genuine niche: **cron while nobody's looking, outbound HTTP with secrets, inbound webhooks** — and authoring machine-owned documents. Not a mirror of the client.

- **Host functions** (capability-gated): `get_document`, `query_documents` (the DSL), `create_document(text)`, `splice_section(id, plugin_id, yaml_line_edits)` (the only in-document write primitive — line splices into the caller's own `%%%` section), `rewrite_document(id, text)` (machine-owned docs only — creator-plugin check), `kv_get/set`, `config_get`, `emit`, `emit_client(event, payload, user_id?)` (per-user targeting supported; ephemeral, no offline replay), `call_plugin` (callee must be a declared dependency; no reentrancy; depth ≤ 3), `http_request` (per declared hosts).
- **Resource limits:** per-call wall clock 5 s (cron 60 s), memory 128 MB, epoch-based interruption; instances pooled (Extism calls are non-reentrant); circuit breaker disables a plugin after 5 consecutive failures/timeouts, surfaced in admin with manual re-enable. Hot unload waits on in-flight calls (refcount).
- **Hooks:** `document.created/changed/deleted` — at-most-once, fire-and-forget, no retry (failures logged/counted); debounced 2 s per doc; payload carries `origin` (user or plugin id) and is **never delivered to the plugin that caused the change**; per-plugin-per-doc write cap (10/min) as a loop backstop; ordering per-document only.
- **Cron:** UTC; missed runs skipped; `last_run` persisted; no overlapping executions.

### 6.4 Frontend plugins (React ES modules)

- **Blessed runtime layer:** the kernel's contract includes a versioned set of shared singletons served via one server-computed import map — `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `yjs`, `@kernel`, plus the extension-point-coupled libraries `@codemirror/state`, `@codemirror/view`, `@lezer/*`, and the `unified`/`remark` set. Plugins declare `peerLibraries` ranges; the server resolves all installed plugins' ranges to single versions at install (import maps can't change post-load). Honest consequence, stated: replacing the `editor` row means another *CodeMirror-based* editor; swapping the runtime layer itself is a kernel-major event.
- `activate(kernel)` default export; return value registered as the plugin's API for dependents. `deactivate` is defined for symmetry but activation remains **reload-only** (plugins load once at boot, topo order; changes prompt "reload to activate"). Backend halves still hot-load.
- **Every contribution is wrapped in an error boundary** (in-place "plugin X failed"); an `activate()` throw marks the plugin failed and **skips all transitive dependents**; one aggregated notice links to admin.
- **CSS:** per-plugin class prefix convention + `style.css` linked on activation; no shadow DOM in v1. The reference build config can compile that stylesheet with Tailwind (utilities only, no preflight, unlayered, mapped onto kernel tokens, and every class under a per-plugin Tailwind prefix such as `folders:flex` so separately compiled stylesheets never re-declare each other's utilities) as an author option, not a kernel concept: the output remains an ordinary stylesheet and the kernel, loader and server do not distinguish it.
- **Types are the contract:** `web/kernel` publishes `@life-manager/kernel` types (also served at `/kernel.d.ts`); a reference Vite config lives in `plugins/base/*`. `docs/KERNEL-API.md` is the changelog. One `kernel` semver covers both the `@kernel` surface and the Wasm host ABI; removals/signature changes = major. Server enforces at install; the loader independently re-checks each plugin at boot against its own bundle version and hard-skips mismatches (protects stale offline clients).
- **`@kernel` surface:** `documents` (projection queries + live subscriptions, open→hydrated `Y.Doc`, create/delete, the **splice helpers** for fm values and `%%%` sections), `extensions` (`definePoint`/`contribute`/`get`; contributions to undefined points buffer until defined; duplicate `definePoint` throws; schema = minimal runtime shape validation, rejects loudly), `services`, `events`, `settings` (per-user, stored as per-user settings documents — synced/offline for free; **visible to other users in the shared pool**, documented), `capabilities` (feature-detect + bridge), `session`, `sync` (observable status: `offline/connecting/syncing/synced/auth-required/error` + pending count), `ui` (mount point + **kernel-shipped default light/dark token values**).
- Kernel calls `navigator.storage.persist()` at first login; warns visibly if denied or if quota nears (`estimate()`).

### 6.5 Base distribution

| Plugin | Responsibility | Defines |
|---|---|---|
| `shell-ui` | Layout skeleton; **mobile breakpoint** (drawer sidebar, single pane, 44 px targets); a spot for the top bar; always-mounted overlays | `shell.header`, `shell.overlay`, `sidebar.panel`, `main.view` |
| `header` | The top bar in `shell.header`: `start`/`end` seats other plugins fill (the sidebar ☰ is `shell-ui`'s); per-user order and visibility in Settings → Top bar | `navbar.item` |
| `context-menu` | One menu / sheet service for every plugin: anchored popover on a wide screen, bottom sheet on a phone | — |
| `notices` | The notice bell in the header's `end` seat: plugin failures, update prompts, other kernel notices | — |
| `sync-status` | The sync pill in the header's `end` seat: status dot, unsynced count, retry / sign-in | — |
| `router` | URL ↔ view | `router.route` |
| `commands` | Command registry + palette (Ctrl+K) **+ keybindings** (per-user config; plugin-suggested defaults; first registration wins on conflict, conflicts listed) | `commands.command`, `keybindings.default` |
| `themes` | Theme registry + picker; **overrides** kernel default tokens | `themes.theme` |
| `doc-list` | Browse/sort/filter and **search** (the list, ranked; **default provider = the local index**, server provider as fallback/integration); "new document"; **Trash view** (restore, 30 d) | `search.provider` |
| `folders` | Tree from `fm.path` (normalized `/` segments, `.`/`..`/empty stripped, case-sensitive, duplicate names allowed — docs are id-addressed); move = fm splice; "new document here" | — |
| `markdown` | Parse/render pipeline (§6.6); resolves `attachment://` (embeds through the winning `markdown.attachment` renderer, else its own image / chip) and **`doc://<ulid>`** (renders target title, navigates; `![](doc://…)` embeds the target's body, nested to a per-user depth, default 4, cycles become links); "promote to document" command on embedded attachments (§3.6) | `markdown.*` |
| `attachments` | Files pasted, dropped or `/attach`ed into the editor are uploaded and embedded as a preview or a link, chosen per file extension; shows embeds through a viewer per extension (user's pick when several claim one) | `attachments.viewer` |
| `slash-commands` | Type `/` in any editor for a menu of actions; editors publish an editor-neutral `text.surface` (caret, text before it, insert there) while mounted | `text.surface`, `slash.command` |
| `native-preview` | Viewers for what a browser shows by itself: images, PDF, audio, video, plain text (never SVG or HTML) | — |
| `document-surface` | Owns the document route + **mode registry**; `viewer`/`editor` are symmetric contributions | `document.mode` |
| `viewer` | Read mode (hides fm block + `%%%` sections) | contributes `read` |
| `editor` | Edit mode — CodeMirror 6 + `y-codemirror.next`; collapses machine sections; paste / drop handlers take them before CodeMirror; publishes a `text.surface`; **must be usable with the Android soft keyboard (M5 acceptance)** | `editor.extension`, `editor.paste` |
| `settings` | Settings shell | `settings.section` |
| `admin` | Users, invites, pending installs + capability approval, plugin config, audit log, orphans, snapshots | — |

First run seeds a few deletable welcome documents demonstrating frontmatter, `fm.path`, task lists, and a directive; empty states written for doc-list (search included)/folders/Trash.

### 6.6 Extensible markdown

The `markdown` plugin owns the unified/remark → React pipeline and exposes: `markdown.directive` (`:::name` / `:name[…]`), `markdown.fence` (per-language renderers), `markdown.remark` (raw plugins — the escalated path), `markdown.component` (AST node overrides), `markdown.taskState` (marker → `{icon, label, menu order, done?}`).

- Directives + fences are the blessed syntaxes: named, collision-free, degrade to literal text when the plugin is absent.
- Built-in task states (`[ ]`, `[x]`) are default `taskState` contributions. Shipped interaction (rendering plugin's decision, replaceable): left-click toggles non-off → off, off → on; right-click / **long-press on touch** opens the state menu.
- Accepted & documented: marker semantics come from the client registry, so a client without a plugin sees its markers as literal text — task counts can differ between differently-equipped clients (moot while base = everyone, relevant if registries ever diverge).
- Syntax contributors should pair a renderer contribution with a matching `editor.extension`.

## 7. Flutter Shell (v1: minimal, Android)

Flutter is a **conscious choice** (owner's stack) — acknowledged cost: a fourth toolchain, hand-built bridge/updater vs Capacitor/Tauri equivalents.

- Webview (`flutter_inappwebview`) serving the downloaded bundle from local storage.
- **Auth: bearer token** in native secure storage (§5.2) — cookies don't survive local-file origins.
- **Bundle updater:** server publishes a bundle manifest with per-file SHA-256; shell verifies before swapping, keeps the previous bundle, auto-reverts after two failed boots. The bundle declares a minimum bridge version; mismatch shows "update the app".
- **Capability bridge** (`window.shell`, versioned): v1 = `filesystem` (export/import), `notifications` (**scheduled local notifications** — these fire with the app closed). Browser fallback/degradation mandatory for every capability.
- Webview storage backed by a native data directory (not evictable web storage). Plugins never contain Dart.
- **Notification scope, stated:** v1 reminders = foreground (browser) + scheduled local (shell). Server push / device registration / Web Push is v2 — plugin authors are told exactly this.

## 8. Repo, Deployment, Operations

**Monorepo** (aligned to existing layout): `backend/` (Rust server + shared core crate), `web/` (kernel + PWA), `app/` (Flutter shell), `plugins/base/` (base distribution).

**Production: Kubernetes, explicitly single-replica** — `replicas: 1`, `strategy: Recreate`, RWO PVC for plugins, TLS at ingress; the server is TLS-unaware. Live collab fan-out, cron, and hot docs are in-process; HA (change-stream/Redis fan-out + leader-elected cron) is the named v2 seam. **Local/self-host: Docker Compose** — server + mongo + caddy (automatic HTTPS; secure origin is required by cookies/PWA/bridge).

- Health: `/healthz` (liveness), `/readyz` (Mongo + migrations + plugin load, with details). Metrics: Prometheus `/metrics` (connections, subscribed docs, update rate, materialization latency, hook latency/failures, wasm timeouts, room count). Logs: `tracing`, JSON, request ids.
- **Graceful shutdown:** SIGTERM → stop accepting, flush dirty rooms, close sockets with a reconnect code, exit ≤ 30 s.
- **CSP:** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (import map served external or nonced). Markdown: no raw-HTML passthrough in v1; link/image schemes allowlisted (`http`, `https`, `mailto`, `attachment`, `doc`).
- **Offline app shell (browser):** Workbox; kernel bundle precached; plugin modules served at version-scoped URLs (`/plugins/:id/:version/*` — canonicalized, no traversal, `nosniff`) cached immutable; one "update available — reload" flow covers bundle and plugin changes.
- **Backups:** `docs/OPERATIONS.md` — `mongodump`/`mongorestore` incl. GridFS, restore split-brain caveat (graveyard prevents resurrection), plus the admin export endpoint as the Mongo-free path.
- **CI:** cargo test/clippy, web unit tests, shared-core conformance corpus, the convergence harness (§9 M2), one Playwright smoke (register → create → edit → reload → offline edit → reconnect → converge), `cargo-deny`/license-checker.
- **Telemetry: none, ever** — stated in the README.
- i18n: English-only v1, no blocking string patterns. A11y baseline: keyboard-operable palette/editor, focus rings, landmarks in `shell-ui`, WCAG AA contrast in the token contract.
- Browser floor: import-map-capable (Chrome 89+/Safari 16.4+); below it, a readable failure message. Perf budget: kernel + base interactive < 2 s on mid-range Android.

## 9. Build Order (milestones)

1. **M1 — Server core (CRDT from the first commit):** axum + Mongo + migrations; yrs storage ("one doc = one Y.Doc, apply, materialize" — **no WebSocket yet**); shared-core crate (parsers, title, DSL) + conformance corpus; auth incl. bearer tokens + reset paths; documents REST + Trash/graveyard; attachments; health/metrics; Compose.
2. **M2 — Sync:** change feed + projection replication; per-doc CRDT sync over WebSocket; lazy hydration + LRU; offline PWA skeleton (IndexedDB projection + local query engine with the Wasm core); bootstrap endpoint; **convergence harness** (N simulated clients, randomized ops/partitions/reconnects → convergence + materialization equality). **Gate: 5,000 docs, 3 concurrent editors — cold boot and steady-state memory measured in an Android webview on mid-range hardware.**
3. **M3 — Microkernel frontend:** loader, import maps + peer-library resolution, registries, error boundaries, safe mode; base distribution (§6.5) — core set first (shell-ui, router, commands, markdown, document-surface, viewer, editor, doc-list, properties, settings), then themes, search, folders, admin. *Acceptance: the built-in editor replaced by a separately-authored editor plugin.*
4. **M4 — Backend plugins:** Extism host + limits + circuit breaker; manifest/deps/capability enforcement; pending-install approval flow; plugin config/secrets; hooks/cron/event bridge. **Proof (built, then removed): the calendar plugin** — backend half cronned an ICS feed into machine-owned documents (`fm.date`), frontend half rendered a calendar view from fm, with **agenda alongside it as a pure frontend plugin**. Both shipped and proved the milestone; both were deleted afterwards at the owner's direction (2026-09-24, "rip out the calendar stuff — let's polish the basics") and are in git history, not in the tree. What they proved is still under test: the host, the install/approval life cycle, capabilities, hooks and cron are all exercised through `plugins/examples/hello-backend`, which is the fixture they always shared.
5. **M5 — Shell:** Android — webview, verified bundle updater with rollback, bearer auth, filesystem + scheduled-local-notification bridge. *Acceptance: CodeMirror editing with the Android soft keyboard; offline boot; OTA update + revert.*

## 10. Out of Scope for v1 / v2 Seams

- **ACLs/sharing** — v2; the feed-filter seam is built (§4.1).
- **Frontend plugin isolation** (iframe/realms) — v2 research; v1 is stated full-trust.
- **Server push notifications** (device registration, VAPID) — v2; v1 scope in §7.
- **HA/multi-replica** — v2; seam named in §8.
- Presence/cursors UI (awareness already relayed); SharedWorker socket sharing; plugin marketplace/signing; selective/partial projection sync for very large workspaces; attachment dedup/object-storage backend; plugin scaffolding CLI (base plugins are the reference); Web Push; i18n.

## 11. Known Risks (kept honest — replaces "fully decided")

1. **Markdown-syntax merge artifacts** — concurrent edits can produce briefly malformed markdown; accepted by design.
2. **`%%%` same-key concurrency** — machine data reconstructs LWW via line splices; a same-key race resolves last-occurrence-wins, and a garbled line costs that plugin one value until its next write. Accepted; kernel splice helper is mandatory discipline.
3. **Plugin trust** — install = full trust of frontend code; mitigated by approval flow, capabilities on the server side, safe mode, audit log. Real isolation is v2.
4. **Single-replica server** — a deploy or crash drops live sync until restart; clients reconnect and converge. Accepted for v1 scale.
5. **Flutter shell** — highest-effort-per-value component (hand-built updater/bridge); kept deliberately for stack fit. Revisit if M5 drags. **Outcome (M5 landed):** it did not drag — the updater, bridge and bundle endpoint are built and tested, and the debug APK builds. The cost landed somewhere else instead: **every §7 acceptance criterion is verified on the host, none on a device.** The soft-keyboard, offline-boot, OTA-update, revert and app-closed-notification behaviours are covered by unit tests and by a written manual script (`app/TESTPLAN.md`), because no Android device and no KVM-capable host were available to the build. Those are exactly the behaviours that a host test cannot prove. **M5 is not done until that script has been run once on real hardware**; until then the shell's risk is unverified integration, not effort.
   *M5 update (2026-09-24): the effort landed roughly where this predicted, and the shape of the cost is now known rather than guessed. The hand-built half — envelope, updater, revert state machine, loopback origin — went in and is covered by tests on both sides of the ABI. What actually cost the most was the fourth toolchain being **fourth**: two unrelated version collisions (a JDK whose `jlink` refuses AGP's rebuilt `java.base`; AGP 9 removing a ProGuard helper the newest stable `flutter_inappwebview` still calls) each fail inside somebody else's build file and name neither cause. Both are pinned and documented (`app/README.md` § Building the APK), and both will recur on every toolchain bump — that, not the bridge code, is this component's ongoing tax. The remaining risk is unchanged and is about verification rather than design: **the acceptance criteria in §9 M5 need a physical device** (`app/TESTPLAN.md`), and the soft-keyboard criterion in particular is the one that cannot be argued from code review.*
   *M5 review pass (2026-09-24): an adversarial read of the landed shell found seven defects and confirmed the shape of the risk above rather than changing it. Four were reachable only through a device or a hostile server — an unvalidated `bundle_version` used as a directory name, the bearer token following redirects, a boot watchdog that could not tell a stalled network from a broken bundle, and a login form that never reported its own successful boot — and two of those turned a recoverable situation into a **permanently quarantined bundle**, which is the failure mode this component was built to avoid. The most instructive one needed no code at all: the two `flutter_local_notifications` broadcast receivers were never declared in `AndroidManifest.xml`, so no scheduled notification could ever fire, while `zonedSchedule` succeeded, `list()` reported the reminder as pending, and every host test passed. That is the §7 capability with no browser equivalent, failing silently, invisible to the entire suite. All are fixed and covered where a host test can cover them; the ones that cannot be are now named in `app/TESTPLAN.md`. The lesson is the one already recorded: **for this component, a green suite is evidence about the code and not about the app.***
6. **Blessed runtime pinning** — the kernel contract pins CodeMirror + remark families; replacing those means a kernel-major. Accepted as the price of a working import-map singleton model.
7. **Client-registry-dependent task semantics** — differently-equipped clients could read task markers differently (§6.6). Moot while all clients share one plugin set.
