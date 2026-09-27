# Spec Gap Review (Opus agent, 2026-09-23)

Findings from an adversarial gap-hunt over SPEC.md — things the spec does not decide, address, or mention. Tiered by when the decision is needed. Each item ends with a recommended default to accept or override.

Note: the spec's §8 monorepo layout (`server/`, `web/`, `shell/`, `plugins/base/`) does not match what's on disk (`backend/`, `app/`). Decide the naming now, while it's free.

---

# TIER 1 — must decide before M1/M2 (schema, auth, sync protocol; expensive to retrofit)

**1.1 Documents have no title.** The logical shape (§3.1) has `_id`, `content`, `fm`, `plugins` — nothing to display in a list. `doc-list`, `search`, `folders`, browser tab, and any link all need a name, and server-side `sort` needs an indexed field.
→ *Default:* display name = `fm.title` → else first ATX heading in `content` → else first non-empty non-frontmatter line, truncated 120 chars → else "Untitled". Materialize it as a `title` field in the same atomic write as `fm` (§3.3) and implement the identical resolver in the JS kernel; cover it in the parity test suite.

**1.2 No cross-document link scheme.** `attachment://` exists; there is no `doc://`. A document manager whose documents can't reference each other is a hole, and retrofitting link-rewrite-on-move later is painful.
→ *Default:* `doc://<ulid>` resolved by the `markdown` plugin (renders as the target's display name); `[[wiki-link]]` stays a plugin concern as §6.4.1 already implies.

**1.3 No password reset, no password change, no email change.** There is no email infrastructure and no recovery path. A forgotten admin password bricks the instance permanently.
→ *Default:* (a) `POST /api/auth/password` with current password; (b) admin-generated one-time reset link reusing the invite mechanism (`POST /api/admin/users/:id/reset`); (c) a server-binary subcommand `life-manager reset-password --email …` as the break-glass path. No SMTP in v1.

**1.4 Session lifetime is unspecified, and session expiry during offline editing is a data-loss path.** §5.2 says "sessions stored in Mongo" and nothing else. A client offline for weeks reconnects to a 401: unspecified whether IndexedDB survives. Also unspecified: whether logout wipes local replicas (it must on a shared device — which destroys unsynced edits).
→ *Default:* rolling sessions, 30-day idle / 180-day absolute, refreshed on any authenticated request. On 401 at reconnect the client **never** clears IndexedDB — it shows a re-login prompt and resyncs after. Logout with unsynced changes warns and blocks until synced or explicitly discarded; logout then clears local replicas.

**1.5 WebSocket auth lifecycle and Origin checking.** §4 says the socket authenticates via cookie at upgrade — and then nothing. Mid-connection revocation (logout elsewhere, user deleted, password changed) leaves an authenticated socket open indefinitely. No `Origin` validation is mentioned; cookie-authenticated WebSocket upgrades are the classic cross-site hijacking vector.
→ *Default:* mandatory `Origin` allowlist check at upgrade against an `APP_ORIGIN` env var; re-validate the session every 5 minutes and on session-store invalidation, closing with a defined code (`4401`) so the client re-auths instead of reconnect-looping. Cookies: `HttpOnly; Secure; SameSite=Lax`.

**1.6 The Android shell breaks cookie auth — and this lands in M1, not M5.** §7 serves the webview from local files for true offline boot; §5.2 authenticates with same-origin cookies. A `file://`-origin (or custom-scheme) webview cannot send `Secure; SameSite` cookies to `https://server`. These two sections are mutually incompatible as written, and the fix changes the M1 auth design.
→ *Default:* pick bearer-token auth for the shell now — the shell serves the bundle from a custom scheme, logs in via `POST /api/auth/login` returning a long-lived token stored in native secure storage, and passes it as `Authorization:` on REST and as a subprotocol/first-message on the WebSocket. Server supports both cookie (browser) and token (shell) auth from M1, with CORS-with-credentials allowed for exactly the shell origin.

**1.7 No Mongo schema versioning or migration story.** Nothing anywhere. Index creation is also only implied ("added as needed").
→ *Default:* a `meta` collection holding `schema_version`; ordered idempotent migrations run at boot behind an advisory lock; server refuses to start if the DB version exceeds the binary's; all indexes created idempotently at boot from a single declarative list.

**1.8 YAML frontmatter parsing is unhardened, and it runs on every write.** Unmentioned: YAML anchor/alias expansion bombs, unbounded nesting, multi-megabyte frontmatter, custom tags. Worse — **`fm` keys go straight into BSON**: a user typing `foo.bar: 1` or `$gt: 1` in frontmatter produces field names that the whitelisted-filter evaluator and the JS local evaluator will interpret differently, silently breaking the "identical offline and online" guarantee (§4). Plus the `fm.**` wildcard index grows with arbitrary user-invented keys.
→ *Default:* safe-subset YAML only (no custom tags, anchor expansion capped or disabled). Hard caps enforced at materialization: frontmatter block ≤ 64 KB, ≤ 200 keys, depth ≤ 5, arrays ≤ 1000 items, string values ≤ 8 KB. Keys must match `^[A-Za-z0-9_-]{1,64}$` — non-conforming keys are dropped from `fm` (text is untouched, `fm_parse_error: true` set), which keeps both evaluators honest. Extend the shared parity suite to fm parsing, not just filters.

**1.9 No document size limit, and the storage layout has a hard 16 MB cliff.** `crdt` + `content` + `fm` + `plugins` + `state_vector` share one Mongo document. A large, heavily-edited doc can exceed 16 MB and become **unwritable** — a permanent, unrecoverable-from-the-client failure. CRDT blobs also never shrink to zero (tombstones).
→ *Default:* enforce a 1 MB `content` cap at the sync/REST boundary with an explicit client-visible error; monitor `crdt` size, compact aggressively above 4 MB, alert above 8 MB; document the ceiling; keep "move `crdt` to GridFS" as the named escape hatch.

**1.10 No attachment size limit.** `POST /api/attachments` multipart with no cap = trivial disk exhaustion, and buffering in memory is an OOM.
→ *Default:* `MAX_ATTACHMENT_BYTES` default 25 MB, enforced by streaming straight to GridFS without full buffering; reject on declared-vs-sniffed MIME mismatch.

**1.11 Tombstone retention is unspecified → document resurrection.** §5.1 says "flag + purge job, so offline clients learn of deletion" with no window. A client offline past the purge window reconnects, finds no tombstone, and re-uploads the doc. Zombie documents are the single nastiest bug class in this design.
→ *Default:* keep a **permanent id-only graveyard** collection (`deleted_ids`: 26-byte ULIDs — effectively free forever) that the sync path always consults; the richer tombstone record (who/when, for the trash UI) is retained 30 days. Resurrection becomes structurally impossible rather than window-dependent.

**1.12 "Delete" vs a local replica with unsynced offline edits is undefined.** The CRDT has no semantics for this; it's a layer above. Does the client drop the Yjs doc from IndexedDB on tombstone? What about edits made offline *after* the server-side deletion?
→ *Default:* delete wins. The client removes the replica, but if it held unsynced updates it first surfaces a one-time "this document was deleted elsewhere — your unsynced changes are preserved here; restore as a new document?" flow before discarding.

**1.13 Trash/undelete is absent as a product concept.** A shared pool where any user can delete anything with no recovery is a bad first week.
→ *Default:* deletion = tombstone; tombstoned docs appear in a Trash view (owned by `doc-list`) for 30 days and are restorable; purge after. Ties directly to 1.11.

**1.14 The server is stateful but K8s is named as prod with no replica constraint.** In-memory yrs rooms, the WebSocket relay, the Extism host, cron, and an RWO plugins PVC all mean two replicas silently break live collaboration (clients on different pods never see each other) and double-fire cron. This must be stated, not assumed.
→ *Default:* v1 is explicitly single-replica — `replicas: 1`, `strategy: Recreate`, PVC ReadWriteOnce, documented as a hard constraint with a health-check note. Horizontal scaling (change-stream or Redis fan-out between replicas + leader-elected cron) is v2. Consequence to also write down: every deploy drops all sockets, so clients need reconnect with exponential backoff + jitter.

**1.15 yrs rooms are never evicted from memory.** Nothing says an in-memory doc is ever dropped. With full replication and active clients, server memory grows with every document ever touched.
→ *Default:* evict a room 10 minutes after its last subscriber and after its updates are flushed; reload from Mongo on demand. Export room count as a metric.

**1.16 No health endpoints, structured logging, or metrics.** K8s needs liveness and readiness; you need them from day one.
→ *Default:* `GET /healthz` (process) and `GET /readyz` (Mongo reachable, migrations applied, plugin load finished — with a details body); `tracing` with JSON logs and a request id; `GET /metrics` (Prometheus) covering sync connections, subscribed docs, update rate, materialization latency, hook latency/failures per plugin, wasm timeouts.

**1.17 No backup/restore procedure.** §10 defers "backup/export tooling", but that's deferring the *operational* story for a self-hosted app that holds the user's entire corpus in Mongo + GridFS.
→ *Default:* ship `dev-docs/resolved/OPERATIONS.md` with `mongodump`/`mongorestore` commands (GridFS included) plus the split-brain caveat (restoring while clients hold newer local state re-merges and — absent 1.11's graveyard — resurrects docs). Add `GET /api/admin/export` streaming every document as plain markdown-with-frontmatter in a zip: cheap to build, it *is* the portability pitch, and it's the disaster-recovery path that doesn't require Mongo access.

**1.18 No login rate limiting or stated argon2 parameters.**
→ *Default:* per-IP and per-account exponential backoff on failed login, generous global rate limit middleware; argon2id at m=19456 KiB, t=2, p=1; failed attempts logged.

**1.19 No multi-client convergence test harness.** Only the filter-parity suite is specified. Sync bugs found later are brutal to diagnose.
→ *Default:* an M2 deliverable — N simulated clients, randomized op/partition/reconnect schedules, assert convergence of `content`, `fm`, and `plugins` plus materialization equality between the Rust and JS parsers. Cheap in M2, near-impossible to retrofit.

**1.20 POST with an already-existing client-minted ULID is undefined.** (ULID collision itself is negligible — 80 random bits — but a client retry or a replayed offline queue makes this common.)
→ *Default:* `POST /api/documents` with an existing `_id` returns 409; the sync path treats a known id as a CRDT merge (which is the correct behavior); client create is idempotent on retry. Also: server stamps `created_at`/`updated_at` on receipt — never trust client clocks, and note that ULID time-ordering is best-effort because of clock skew.

---

# TIER 2 — must decide before v1 ships

## Security / plugin trust

**2.1 The spec never acknowledges that frontend plugins are not sandboxed.** §6.3 calls Wasm "sandboxed" and §11 frames `capabilities` as the permission model — which creates the false impression that the whole plugin is gated. A frontend `index.mjs` runs in the app origin with full DOM, `fetch` with the user's credentials, IndexedDB, and — if the viewer is an admin — the admin API including plugin install. Installing a plugin is arbitrary code execution as every user in the workspace.
→ *Default:* state it plainly in §6.4 and §11; the install UI shows "this plugin's frontend code runs with full access to your workspace and session — install only code you trust"; note that `capabilities` gates *server* host functions and *native* bridge calls only. Real frontend isolation (iframe/Realms) is v2.

**2.2 Safe mode is missing, and without it a bad plugin bricks the app for everyone.** Because `shell-ui` is itself a plugin, one throw during activation or render yields a white screen with no recovery UI — for all users, since plugins are installed server-side.
→ *Default:* `?safe=1` boots the kernel with base plugins only; `?safe=bare` boots with none and renders a minimal built-in plugin manager. Server-side complement: `DISABLE_PLUGINS=1` env to recover an instance whose backend plugin breaks boot.

**2.3 No error boundaries or plugin-failure policy.** Unspecified: `activate()` throwing, a contribution crashing in render, a dependency that loaded but threw, a dependency returning no API.
→ *Default:* the kernel wraps every contributed component in an error boundary rendering "plugin X failed" in place; `activate()` throws are caught, the plugin is marked failed, and **all transitive dependents are skipped** (never partially activated); one aggregated notice lists failures and links to admin.

**2.4 Markdown XSS is unaddressed.** Unspecified: whether raw HTML in markdown passes through, URL scheme allowlisting (`javascript:`, `data:`), and — the sharpest one — `GET /api/attachments/:id` serving an attacker-uploaded `image/svg+xml` inline on the app origin is stored XSS with full session access.
→ *Default:* no raw HTML passthrough in v1 (render literally); allowlist link/image schemes to `http`, `https`, `mailto`, `attachment`, `doc`; serve attachments with `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` for everything except an allowlist of safe inline types, and never serve `image/svg+xml` inline (force download or rasterize).

**2.5 No Content-Security-Policy anywhere.** It also interacts with the plugin model, so it can't be bolted on blindly.
→ *Default:* `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Verify CodeMirror/Lezer needs no `eval` (it doesn't) and that the import map is servable under `script-src 'self'` (use an external importmap file or a nonce).

**2.6 Plugin zip handling is unspecified — zip-slip, symlinks, bombs.** Also the directory-watch race: a partially-written `plugin.zip` gets read mid-copy.
→ *Default:* validate `manifest.json` first; reject absolute paths, `..` segments, symlinks, and any entry outside `frontend/**` plus the declared wasm; cap total uncompressed size (50 MB), entry count (1000), per-entry size; extract to a temp dir and atomically rename into place. Watcher requires file size+mtime stable for 2 seconds before acting.

**2.7 Plugin asset serving route and path traversal.** The route shape for `frontend/…assets` isn't even named.
→ *Default:* `GET /plugins/:id/:version/*path`, served from a canonicalized root with `..` rejected, fixed content types by extension, `nosniff`, no directory listing. Version in the path also solves cache-busting (see 2.22).

**2.8 `http` capability is unrestricted SSRF from inside the cluster.** Reaching Mongo, the K8s API, cloud metadata endpoints, and sibling pods.
→ *Default:* deny loopback, link-local, and RFC1918 destinations by default with an admin-configurable allowlist; resolve-then-pin the IP; 10 s timeout; 10 MB response cap.

**2.9 Document access from Wasm is ungated.** `get_document`/`query_documents`/`update_document` are listed without capabilities, so a plugin declaring nothing can read and rewrite the whole workspace — making the install-time capability dialog misleading.
→ *Default:* add `documents:read` and `documents:write` as declared capabilities; only `kv_*`, `emit`, and hook delivery are ungated.

**2.10 Plugin HTTP route auth is unspecified.** `/api/plugins/:id/*` — session-authenticated? admin-only? public (which inbound webhooks require)?
→ *Default:* session-authenticated by default; the manifest may declare specific public routes, surfaced at install as a `public-routes` capability; rate-limited per route; namespaced under the plugin id so collisions are impossible.

**2.11 Notifications have no infrastructure.** `notifications` is listed as a capability, but the browser Notification API only fires while the page is open, and Web Push needs VAPID keys, subscription storage, and a server-side sender — none of which appear in the spec. A reminder plugin (the obvious first use) can't work.
→ *Default:* v1 = foreground-only notifications in the browser, plus scheduled **local** notifications via the Android shell bridge. Web Push is explicitly out of scope and documented as such so plugin authors aren't surprised.

## Plugin system mechanics

**2.12 `@kernel` has no published types and no build story.** Types *are* the contract — nobody, including the base-distribution authors, can write a plugin without them. Practical build traps: the import map must include `react/jsx-runtime` and `react-dom/client`, not just `react`; there is no CSS story for plugins at all; plugin-relative asset URLs need a documented base.
→ *Default:* `web/kernel/` exports the public types, published as a versioned `@life-manager/kernel` package *and* served as `/kernel.d.ts`; a reference Vite config in `plugins/base/*` (`build.lib`, `format: 'es'`, externals listed); import map keys enumerated in the spec (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `yjs`, `@kernel`); plugin CSS = a `frontend/style.css` the kernel links on activation (no shadow DOM in v1); assets resolved via `import.meta.url`.

**2.13 Kernel API versioning is a field with no policy behind it.** `"kernel": "^1.0"` — nothing defines what bumps it, what counts as breaking, who enforces the range (server at install? loader at boot? both — they can disagree across an offline client), or that the frontend `@kernel` surface and the Extism host ABI are two different contracts.
→ *Default:* one `kernel` semver covering both surfaces; any host-function or `@kernel` removal or signature change is a major bump. Server rejects install out of range with a clear error; the loader independently checks each plugin against **its own** bundle version and hard-skips mismatches, listing them in admin (this is what protects a stale offline client). Maintain `dev-docs/resolved/KERNEL-API.md` as a changelog.

**2.14 No Wasm resource limits.** "A crashing plugin returns an error" covers traps, not infinite loops or memory exhaustion.
→ *Default:* per-call wall-clock timeout (5 s; 60 s for cron), max memory 128 MB, fuel limit if exposed; a circuit breaker disabling a plugin after 5 consecutive failures/timeouts, surfaced in admin with a manual re-enable.

**2.15 Hook semantics are undefined — including a real infinite-loop hazard.** Unspecified: delivery guarantees, retries, ordering, the debounce window, and critically **whether a plugin receives `document.changed` for changes it made itself**. It will, by default, and it will loop.
→ *Default:* at-most-once, fire-and-forget, no retry in v1; failures logged and counted. Debounce 2 s per document. Every hook payload carries an `origin` (user id or plugin id) and is **not** delivered to the plugin that caused the change; a per-plugin-per-document write rate cap (e.g. 10/min) kills residual loops. Ordering guaranteed per document, not globally.

**2.16 Cron has no restart or timezone semantics.** Server down over a scheduled time — catch up or skip? Whose timezone?
→ *Default:* UTC only; missed runs are skipped, never caught up; persist `last_run` per (plugin, schedule); no overlapping executions of the same schedule.

**2.17 Concurrent install/uninstall is unserialized.** Two admins, or an admin upload racing the directory watcher, against a shared dependency graph.
→ *Default:* a single serialized install queue guarded by a Mongo lock document with a TTL; the resolved graph is recomputed and validated inside the lock; partial installs roll back.

**2.18 Plugin data after uninstall is undefined.** "KV survives upgrades" says nothing about uninstall, and `doc.plugins.<id>` data sits inside every document's CRDT permanently.
→ *Default:* uninstall retains both by default (reinstall is lossless); an explicit "also delete this plugin's data" checkbox clears `plugin_kv` and queues a background job stripping `plugins.<id>` from every document via CRDT transactions. Document that `plugins.*` data is otherwise never garbage-collected.

**2.19 No admin-level / workspace-level plugin configuration or secret storage.** `settings` is per-user frontend KV; `kv_*` is plugin-written, unencrypted, and not admin-editable. The M4 calendar plugin needs an ICS URL and possibly credentials, and there's nowhere to put them.
→ *Default:* a manifest-declared `config` schema; admin-only UI writing to a `plugin_config` scope readable by the backend half; values marked `secret: true` are write-only in the UI and encrypted at rest with a key derived from `SESSION_SECRET` (or a separate `CONFIG_KEY`).

**2.20 `definePoint`/`contribute` has no ordering, duplicate, or validation rules.** What is `schema`? What happens when a contribution arrives before its point is defined (guaranteed, with topo-ordered loading)? Two plugins defining the same point?
→ *Default:* contributions to an undefined point are buffered and validated when the point is defined; a second `definePoint` for an existing name throws for the caller; `schema` is a minimal runtime shape validator (document the exact subset) with failures logged and the contribution rejected, not silently accepted.

**2.21 Per-user settings storage is unspecified.** Where does `settings` live, is it available/editable offline, how does it merge across a user's devices?
→ *Default:* a per-user Yjs document (id derived from the user id) synced over the existing channel — offline-capable and mergeable for free — with the same LWW caveat as 3.1.

## Frontend / product

**2.22 No service-worker / offline app-shell story for the browser PWA.** "Offline-first" is a headline property and the delivery mechanism for the app itself is unspecified — including the subtle part: plugin ES modules must be cached for offline boot and invalidated on plugin upgrade.
→ *Default:* Workbox; precache the kernel bundle; version-scoped plugin URLs (2.7) runtime-cached cache-first (immutable by construction); a bundle-version manifest the client polls; one shared "update available — reload" flow covering both bundle updates and the §6.5 plugin-change notice.

**2.23 Responsive/mobile is never mentioned — and the only v1 shell is Android.** A navbar + sidebar + document surface is a desktop layout. Concretely: §6.4.1's shipped default uses **right-click** for the task-state menu, with no touch equivalent specified. CodeMirror 6 with the Android soft keyboard/IME is a known pain area.
→ *Default:* `shell-ui` ships a mobile breakpoint (sidebar → drawer, single-pane navigation, 44 px touch targets); long-press is the specified touch equivalent for the task-state menu; "CodeMirror usable on Android with the soft keyboard and autocorrect" becomes an explicit M3/M5 acceptance criterion.

**2.24 No sync-status surface.** An offline-first app must tell the user whether they're synced and how much is pending.
→ *Default:* the kernel exposes an observable `sync.status` with defined states (`offline`, `connecting`, `syncing`, `synced`, `auth-required`, `error`) plus a pending-update count; `shell-ui` renders an indicator. Also call `navigator.storage.persist()` at first login and warn visibly if denied.

**2.25 No bulk initial sync / cold-start path.** A new device replicates the whole workspace; one state-vector round-trip per document over a single socket is slow, with no progress UI.
→ *Default:* `GET /api/sync/bootstrap` streaming paged CRDT blobs for the initial fill, then the socket for the delta; a first-run progress screen; a stated target (5000 documents in under 30 s on a LAN).

**2.26 No first-run experience or empty states.** The first admin registers and lands in an empty list, with no hint that `fm.path` means folders or that `:::directives` exist.
→ *Default:* seed a handful of real, deletable welcome documents on first boot demonstrating frontmatter, `fm.path`, a task list, and a directive; write empty-state copy for `doc-list`, `search`, `folders`, and Trash.

**2.27 "Any user can delete or edit anything" is implied but never stated, and unaudited.**
→ *Default:* state it in §5.2. Add an `audit_log` collection for destructive and administrative actions (document delete, snapshot restore, user delete, invite issue, plugin install/uninstall) with an admin view. No ACLs in v1.

**2.28 Admin/user account semantics are thin.** Unspecified: can admin be granted/revoked; can the last admin be deleted; can a user delete themselves; what happens to a deleted user's sessions, attribution, and per-user settings.
→ *Default:* `admin` is a boolean an admin can toggle; the last remaining admin cannot be demoted or deleted; `DELETE /api/admin/users/:id` revokes sessions, deletes the per-user settings doc, and **retains** `created_by`/`updated_by` as a raw id rendered as "deleted user"; no self-delete in v1.

**2.29 Invite token semantics beyond "one-time".** No expiry, revocation, listing, or role.
→ *Default:* 7-day expiry, single-use, listable and revocable by admins, always creates a non-admin user.

**2.30 Snapshot retention and restore concurrency; capped collection is the wrong tool.** Globally size-bounded `document_snapshots` means one busy document evicts everyone else's history. "Restore = new CRDT transaction replacing content" clobbers what a co-editor is typing, with no specified UX. And capped collections can't delete selectively, can't grow documents, and reject inserts exceeding the max size — a single large Yjs update would just fail.
→ *Default:* per-document snapshot retention (last 20, plus one per day for 30 days), not a global cap. Use a normal collection with a TTL index for `document_updates` rather than a capped collection. Restore warns when other users are actively subscribed to the document and names them.

**2.31 Graceful shutdown and secret policy.** SIGTERM behavior with in-flight updates and unflushed compaction is unspecified (deploy-time data loss), as is `SESSION_SECRET` handling.
→ *Default:* on SIGTERM stop accepting connections, flush all dirty rooms, close sockets with a "server restarting, reconnect" code, exit within a 30 s grace period. `SESSION_SECRET` is required, ≥32 bytes, no default — server refuses to start without it; rotation is documented as "logs everyone out".

**2.32 Search's offline/online provider rule is unstated.** `search`'s default provider is "server full-text" (§6.4.2) while §4 promises search works identically offline via the local index.
→ *Default:* the local index is always the default provider; the server provider is used only for corpora above a threshold or explicitly, and the UI never silently changes behavior when connectivity drops.

**2.33 `fm.path` has no rules.** No normalization, validation, case-sensitivity, or collision policy — two documents can share a path and name; `..` is unhandled.
→ *Default:* the `folders` plugin normalizes to `/`-separated segments, strips `.`/`..`/empty segments, is case-sensitive, and permits duplicate names within a folder (documents are id-addressed, not path-addressed).

---

# TIER 3 — fine to defer, but write it down

**3.1 `plugins` Y.Map "LWW" is not chronological.** Yjs resolves concurrent same-key sets deterministically by client id, so after a long offline period the *older* edit can win. Plugin authors will assume wall-clock semantics.
→ *Note in plugin-author docs; prefer append-only `Y.Array` or per-user subkeys for anything order-sensitive.*

**3.2 IndexedDB eviction beyond `persist()`.** Safari's unused-site cap and OS-level WebView data clearing can wipe the local corpus including unsynced edits.
→ *Warn on `navigator.storage.estimate()` nearing quota; the shell should back its WebView storage with a native-directory data path.*

**3.3 No WebSocket backpressure or frame limits.** Full replication fans every update out to every client with no bound on send queues.
→ *Bounded per-connection queue; on overflow drop buffered updates and instruct a state-vector resync; max frame 4 MB; inbound rate cap.*

**3.4 Multi-tab duplicates sockets.** Each tab opens its own connection and replica.
→ *Note it; SharedWorker single connection is v2; cap concurrent sockets per session (e.g. 8).*

**3.5 Minimum browser/WebView versions unstated.** Import maps need Chrome 89+/Safari 16.4+; Android System WebView varies by device.
→ *Declare targets; fail loudly with a readable message below them.*

**3.6 Shell bundle updater has no integrity or rollback rules.** A downloaded bundle is executable code; "versioning + rollback owned by the shell" has no policy; bridge/bundle version negotiation unspecified.
→ *Server publishes a bundle manifest with SHA-256 per file; shell verifies before swapping, keeps the previous bundle, reverts if the new one fails to boot twice; bundle declares a minimum bridge version and refuses to load against an older shell with a clear "update the app" screen.*

**3.7 Attribution under merge is ill-defined.** `updated_by` after merging two offline clients' work is arbitrary; per-character blame isn't recoverable from a compacted CRDT.
→ *Document that `updated_by` means "last applier the server saw"; blame is out of scope.*

**3.8 No presence UI in v1 means silent co-editing.** Two users in the same doc see text move with no explanation.
→ *A minimal "N others editing" badge is cheap insurance if it fits.*

**3.9 Orphan attachment detection can false-positive.** A reference living only in an unsynced offline document looks orphaned. Harmless given admin-only, no-auto-delete — but say so.

**3.10 i18n and a11y have no stance.**
→ *English-only v1, no i18n framework, but no runtime string concatenation blocking it later. A11y baseline: keyboard operability of palette and editor, visible focus rings, semantic landmarks in `shell-ui`, WCAG AA contrast in the `themes` token contract.*

**3.11 Keybinding collisions have no resolution policy.**
→ *First registration wins; later ones dropped and listed as conflicts in settings.*

**3.12 Telemetry stance unstated.**
→ *None, ever; state it in the README — a selling point for self-hosted.*

**3.13 Mongo text index caveats.** One text index per collection; language stemming; it will index the raw frontmatter block and markdown syntax as body text. Minor quality issue; note it.

**3.14 No cap on installed plugin count or bundle size.** Boot time degrades linearly.
→ *Soft target: kernel + base distribution interactive in under 2 s on a mid-range Android device.*

**3.15 CI and test strategy beyond the two named suites.** No CI specified.
→ *GitHub Actions on PRs: cargo test/clippy, web unit tests, the parity suite, the convergence harness, one Playwright smoke path (register → create → edit → reload → offline edit → reconnect → converge).*

**3.16 Dependency license audit.** Add `cargo-deny`/`license-checker` to CI to keep the MIT/Apache-2.0 claim true.

---

# THE 5 QUESTIONS FOR THE OWNER

1. **How is a document named?** `fm.title`, the first `#` heading, or the first line — and is that name materialized server-side as an indexed `title` field? (Blocks the M1 schema, `doc-list`, search, and links.)

2. **Is the server permanently single-replica in v1?** If yes, say `replicas: 1` in the spec and keep the relay in memory. If two replicas must ever run, the sync fan-out, cron, and the plugins volume all need a different design — and that decision belongs in M2, not later.

3. **Does the Android shell authenticate with a bearer token rather than cookies?** Serving the webview from local files (§7) makes same-origin cookie sessions (§5.2) impossible. This has to be settled in M1 because it changes the auth layer, not in M5.

4. **Is "installing a plugin grants it full access to every user's workspace and session" the accepted v1 security model?** Frontend plugin ES modules are not sandboxed, and the `capabilities` list gates only server and native calls. If yes, state it in the spec and show it in the install UI. If not, frontend isolation has to be designed before M3.

5. **What does deleting a document mean?** (a) Is there a Trash with a retention window and restore; (b) do you accept a permanent id-only graveyard so a long-offline client can never resurrect a deleted document; (c) when a client deletes offline while another edits the same document, does delete win, and are the losing unsynced edits offered back to the user?

*Runners-up:* what is the account-recovery path when the admin forgets the password (no email infra exists), and do you accept a hard 1 MB per-document content cap to stay clear of Mongo's 16 MB document ceiling?
