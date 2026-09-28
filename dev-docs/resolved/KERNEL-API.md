# `@kernel` changelog

The contract plugins compile against (SPEC §6.4: "`dev-docs/resolved/KERNEL-API.md` is the changelog").
The source of truth is `web/kernel-api/src/`; the generated single-file form is
`web/kernel-api/dist/kernel.d.ts`, served at `/kernel.d.ts`.

**One semver covers both the `@kernel` surface and the Wasm host ABI.** Removals and
signature changes are a **major**; adding a surface, a method, or an *optional* field is a
**minor**. The server enforces a plugin's `kernel` range at install, and the loader
re-checks it at boot against its own bundle version — a stale offline client hard-skips a
plugin built for a contract it does not implement, rather than activating it and failing in
pieces.

A plugin declares the range it needs:

```json
{ "kernel": "^2.0" }
```

**The backend half's contract is `backend/HOST-ABI.md`**, and it is the *same* semver.
That is the point of "one `kernel` semver covers both": a plugin declaring `"kernel":
"^2.0"` is declaring both the `@kernel` surface its frontend half compiles against and the
host-function set its Wasm half links. This file is the changelog for the frontend half;
`HOST-ABI.md` is the specification for the backend half, listing every host function, its
capability gate, the limits, and the five exports a module may define. A module also
carries the ABI version itself, in the required `lm_abi_version` export, which the host
reads before any plugin logic runs.

## Writing a backend half

The whole story is in `backend/HOST-ABI.md`; this is the shape of it.

```toml
# plugins/base/<id>/backend/Cargo.toml
[lib]
crate-type = ["cdylib"]

[dependencies]
life-manager-plugin-sdk = { path = "../../../../backend/crates/plugin-sdk" }
```

```rust
lm::abi_version!();                 // required — the host reads it first
lm::init!(init);                    // optional: config keys, capabilities, limits
lm::cron!(tick);                    // optional: one call per matched schedule
lm::http_routes!(route);            // optional: the manifest's declared routes
lm::hooks!(on_deleted);             // optional: document.created/changed/deleted

fn tick(_schedule: lm::abi::cron::CronPayload) -> lm::Result<()> {
    let feed: String = lm::config::get("feed_url")?.unwrap_or_default();
    let body = lm::http::get(&feed)?;              // needs `capabilities.http.hosts`
    lm::documents::create(&render(&body))?;        // needs `capabilities.documents: write`
    Ok(())
}
```

Three rules worth knowing before the first line:

1. **Undeclared host functions are erroring stubs, never link failures** — instantiation
   cannot fail on imports, so a plugin may probe for a capability it would like and work
   without it.
2. **Put the logic in a plain crate.** A `cdylib` that links the host imports cannot be
   unit-tested on the host target, so the testable half belongs in an ordinary library
   crate beside it. `plugins/base/calendar/ics/` was the reference — a 58-test ICS parser
   behind a `mise run plugin-test` task — until the calendar plugin was removed
   (2026-09-24); the crate, its suite and that task went with it. The rule did not: the
   first plugin that needs real logic brings both back.
3. **Reconcile, never accumulate.** Hooks are at-most-once with no retry and cron skips
   missed runs (SPEC §6.3), so every run must be able to start from whatever state it
   finds. A feed sync should be a full reconciliation for exactly this reason, and that is
   also why an unchanged feed costs **zero** writes: `splice_section` drops edits whose
   value already matches, so an idempotent daily sync writes no CRDT history at all.

Build and install both halves with `mise run wasm-plugins`; package one for a real install
with `mise run plugin-package <id>`.

## 1.0.0 — M3

The first published contract. Surfaces, as listed in SPEC §6.4:

| Surface | What it is |
|---|---|
| `documents` | live local queries, search, `open()` → hydrated `Y.Doc`, create/delete/restore, and the **splice helpers** for `fm` values and `%%%` sections |
| `extensions` | `definePoint` / `contribute` / `get` / `subscribe`; buffering, duplicate-throw, live reads, minimal shape validation. A subscriber is **isolated**: if yours throws, the others still hear the change and the throw is reported against you, not against whoever contributed. A plugin the loader retracts releases the points it defined, so its contributions re-buffer and a replacement can define the same name. |
| `services` | the value a dependency's `activate()` returned, for **declared** dependents only |
| `events` | the ephemeral in-page bus, plus server-relayed plugin events (M4) |
| `settings` | per-user settings, stored as documents, namespaced per plugin |
| `session` | the signed-in user, an authenticated `fetch`, plugin-scoped `fetchPlugin`, logout |
| `sync` | the observable status: `offline`/`connecting`/`syncing`/`synced`/`auth-required`/`error` + pending count |
| `ui` | the single mount point, the error-boundary wrapper, notices, and the **kernel's default light/dark tokens** |
| `capabilities` | feature detection with browser fallbacks, and the shell bridge |
| `core` | the shared Rust core: parse, title, date canonicalization |
| `info`, `pluginId`, `manifest`, `log` | identity and diagnostics |

Also shipped as values (not just types): `DEFAULT_LIGHT_TOKENS`, `DEFAULT_DARK_TOKENS`,
`THEME_TOKEN_NAMES`, the shape validators (`s.object({…})`), `validateManifest`,
`satisfies`, the error classes, and `KERNEL_API_VERSION`.

### Known gaps in the 1.0.0 *implementation*

The contract is frozen and, apart from one surface, implemented.

- `documents.splice.*` — **implemented.** The edits are computed by a faithful
  TypeScript port of `core::splice` (`web/kernel/src/runtime/splice.ts`), pinned to the
  Rust implementation by the shared conformance corpus
  (`backend/crates/core/corpus/splices.json`) and by a round-trip test that re-parses every
  spliced document with the Wasm core. Offsets are **UTF-16** code units, i.e. `Y.Text`
  indices. The port exists because the ABI exports no splice function; when it does, this
  is one file to swap and the corpus test becomes the bridge's parity test.
- `settings.*` — **implemented**, as a per-user settings *document*: `fm.path: .settings`,
  **`fm.settings-owner: <user id>`**, one `%%%` section per plugin, created lazily on the
  first write and read from the projection through one live local query. Values are YAML
  scalars or flat lists; a nested object is refused. The document is visible to every user
  of the shared workspace — secrets belong in admin plugin config.

  **Which document counts is decided by two things, not one.** `fm.settings-owner` is text
  in a document anybody in the shared workspace can write, so a candidate is accepted only
  when the server's `created_by` on the projection row is the same user; a document claiming
  someone else's ownership is ignored and warned about. And when one user really does have
  two settings documents (two devices, both offline, both writing), the **canonical** one is
  the lowest id: reads merge every accepted document with the canonical one winning per key,
  writes go to the canonical one, and each write clears the same keys from the duplicates so
  the state converges. Reads and writes agreeing on that is what makes a write readable back
  — the M3 version let the *highest* id win reads while writing the lowest, so with two
  documents in play every write was reverted by the next feed tick.

  **A write can fail, and offline it will.** `settings.set` creates the document (REST) or
  splices into it (needs the document hydrated), so it rejects with no server. Do not latch
  that into a mode: keep the value on the device, keep reading it in preference to the stale
  synced one, and retry when `sync` reports it is back — `plugins/base/themes/src/prefs.ts`
  is the reference implementation.

  **`settings.get()` inside `activate()` can legitimately return `undefined` for a value
  that is stored.** It is synchronous off a cache fed by one live local query, and
  `settings.start()` waits for that query's first result — not for the workspace bootstrap
  to finish replicating. On a cold client the settings document arrives over the change
  feed, which can be *after* your plugin activated. So **read settings at activation *and*
  subscribe**: anything derived from a value has to be re-derived in
  `settings.subscribe()`, not computed once. Two shipped plugins got this wrong in M3
  (`themes` restored the theme but silently dropped the light/dark choice on a new device;
  `document-surface`'s mode memory has the same shape and is harmless only because its
  fallback is the right answer anyway). If you find yourself writing "read it once, it will
  be there", it will not be.
- `core.resolveTitle` / `core.normalizeDate` — **threw until 1.1.0.** The Wasm ABI
  exported `resolve_title` and `normalize_date` all along; `CoreBindings` surfaced three of
  its five exports, so the two methods raised `notImplemented`. Closed in 1.1.0 below.

A plugin may compile against all of it today.

## 1.0.0 — M4 additions

M4 added no `@kernel` surface and changed no signature: the contract version is unmoved,
which is the claim worth making explicitly. What it added is on the other side of the same
semver — the Wasm host ABI of `backend/HOST-ABI.md`, whose version is **1**.

Two `@kernel` surfaces that existed in M3 now have a server behind them:

- **`events`** — `emit_client(event, payload, user_id?)` from a backend half arrives as a
  `plugin.event` frame on the sync socket and is delivered to `kernel.events`. Ephemeral,
  with no offline replay (SPEC §6.3): a plugin event that arrives while you are offline is
  gone. Anything that must survive a reload belongs in a document.
- **`session.fetchPlugin`** — reaches the manifest-declared routes of a backend half at
  `/api/plugins/:id/*`. Session-authenticated by default; a manifest may declare specific
  `public-routes`, which is surfaced at install as a capability because it is one.

Two behaviours that are contract, not implementation detail, and that a frontend half
should be written against:

- **A machine-owned document is an ordinary document.** An importer's event notes are
  markdown with frontmatter, in the workspace, searchable and editable like everything
  else; `created_by` is `plugin:<id>` and that is the only difference. A plugin reading
  them uses `documents.query`, not a plugin-specific channel.
- **A user's edit to a machine-owned document survives the next sync.** The owning plugin
  is expected to reconcile around a human's tombstone rather than re-create it, and never
  to rewrite a document it did not create — the host refuses that outright
  (`rewrite_document` checks `created_by`).

## 2.0.0 — ports only (2026-09-28)

A **major**: the 1.2.0 shims are removed, and with them every way plugins reached each
other except `kernel.ports`. The plan behind it is `dev-docs/todo/PLUGIN-PROTOCOLS.html`
(§9 step 8, and §10's "`@kernel` 1.2 during migration, 2.0 at the end").

- **`kernel.extensions` is gone** — `definePoint`, `contribute`, `get`, `entries`,
  `subscribe`, `isDefined`, `points`, `pending` — and with it the types `ExtensionsApi`,
  `ExtensionPoint`, `ExtensionPointDefinition`, `Contribution`, `ContributeOptions` and the
  value `DEFAULT_CONTRIBUTION_ORDER`. A host declares a consumed slot port and reads it
  with `kernel.ports.collect`; a provider declares a provided port and `offer`s on it.
- **`kernel.services` is gone** (`require`, `get`, `has`, `list`, and `ServicesApi`). A
  consumer declares a consumed service port and calls `kernel.ports.use`; a provider
  `serve`s on a provided one. **`activate()`'s return value is ignored**: it is no longer
  anybody's API.
- **The manifest fields `dependencies` and `x-defines` are gone.** Both validators refuse
  a manifest that carries either, naming `consumes` as the replacement, so a 1.x package
  cannot be installed by mistake. A backend half that calls another through `call_plugin`
  lists its callees in the new `backend.calls` (HOST-ABI.md §3.10); that allowlist was
  `dependencies` before.
- **The implicit ports are gone.** A plugin that declares no ports provides and consumes
  nothing: the resolver no longer gives a plugin that owns a service protocol a `~<name>`
  port, a contribution no longer lands on a `~<point>` port every host hears, and the
  skip reasons `missing-dependency`, `dependency-version` and `dependency-skipped` (and the
  `legacy` flag on an activation edge) went with them. Activation is ordered by service
  wires alone.
- **The loader activates only from the server's resolution.** A plugin list without one
  (cached before resolutions existed, or served by a server older than wiring) starts no
  plugin; the reload prompt says so, and a reload while online fetches a list that has one.
- **1.x plugins no longer load.** `"kernel": "^1.0"` does not admit 2.0.0: the server
  refuses such a package at install, and the loader skips one it is still served
  (`kernel-mismatch`). Every base plugin and example says `"kernel": "^2.0"`.

The host ABI is unchanged and stays at version 1: nothing a backend half links moved.

## 1.2.0 — protocols and ports (2026-09-28)

A **minor**: every addition below is new surface, nothing is removed, and a plugin built
against 1.0 or 1.1 loads unchanged. `KERNEL_VERSION` and `KERNEL_API_VERSION` are now
generated from one line (`x-kernel-version` in `schema/manifest.schema.json`), so they can
no longer drift apart. The plan behind it is `dev-docs/todo/PLUGIN-PROTOCOLS.html`.

- **`kernel.ports`** (`PortsApi`): services, slots and events through the plugin's own port
  names, wired by the server's resolution of the live wiring.
  - `use(port)` returns the service bound to a consumed port, as a handle limited to the
    port's `needs`. Reading any other member throws `ContractViolationError`, in
    development and production alike. An optional port with nothing bound is `undefined`.
  - `serve(port, api)` provides a service; the API is checked against the protocol
    version's whole shape, at the provider.
  - `offer(port, items)` contributes to every host wired to a provided slot port, and
    `collect(port)` is a host's live list **in seat order** (`get`, `entries`, `subscribe`).
  - `emit(port, payload)` and `on(port, listener)` for events; a sticky protocol hands a
    new listener the last value at once.
  - An undeclared port throws, like an undeclared dependency always did.
- **Manifest fields**: `provides` (port → `<publisher>/<name>@<version>`, with an optional
  `order` default-seat hint), `consumes` (port → `<publisher>/<name>@<range>`, with
  `needs`, `optional` and `seats`) and `hot`. The manifest types and both validators are
  generated from `schema/manifest.schema.json`, and the TypeScript types gained what the
  server already accepted (`config` `select`/`default`/`options`, `backend.routes`/`events`).
- **Protocol packages**: `ProtocolPackage`, `ProtocolSource`, `ProtocolKind`; the `s.*`
  builders gain `promise()`, `toJSON()`, `.as()` and `.describe()`, and `shapeFromJSON`
  rebuilds a validator from a package's shape. A protocol's types are served at
  `/protocols/<id>/<version>/index.d.ts`.
- **Wiring types**: `LiveWiring`, `WiringOverrides`, `Resolution`, `ApplyPlan` and friends,
  and `kernel.core.resolveWiring`, `planWiring`, `wiringCandidates` and `shapeFits`: the
  server's resolver through the Wasm core, for the wiring editor.
- **`kernel.extensions` and `kernel.services` are shims now**, over the same store as
  `kernel.ports`, and go in 2.0. A plugin that declares a port for a point's protocol
  (a point name is a protocol name: `navbar.item` is `lm/navbar.item`) has its legacy calls
  routed onto that port: `contribute` takes the port's wired seat, `definePoint` and `get`
  read the port's seats, and `services.require` of the bound provider returns the port's
  `needs`-limited handle. A plugin that declares nothing contributes to an implicit port
  every host of the protocol hears, and is served what a provider's `activate()` returned
  or the first service it serves. Either side can move first.

- **Hot-plugging** (PLUGIN-PROTOCOLS §6c). A wiring change applies in place: plugins that
  go away stop, plugins whose services were rebound restart (with everything that uses
  them through services), hosts' seats and event listeners update, and new plugins start.
  The contract that makes it safe:
  - **The kernel withdraws everything a plugin registered through it**: slot items,
    services, event and host listeners, `events.on/once/onAny`, `settings.subscribe`,
    `sync.subscribe`, `session.onAuthRequired`, `documents.subscribe` queries and
    `documents.open` handles, `ui.notify` notices, `ui.onNotices`, `ui.onColorScheme`,
    `ui.tokens.apply` layers, its mount and its stylesheet `<link>`. A resource that
    arrives after its plugin stopped (an async `subscribe` resolving late) is released at
    once.
  - **What a plugin built itself** — window listeners, timers, anything outside its mount —
    is its own `export function deactivate()`'s job, which now runs on every stop, not
    only in `?safe=bare` teardown.
  - **`"hot": true` in the manifest is the promise** that the two together leave nothing
    behind. A change that touches a plugin without it (or needs a library missing from
    the page's import map) shows the reload prompt instead, and the page keeps running
    its current version until the user reloads. Every base plugin is `hot`;
    `app/e2e/hot-plug.spec.ts` unplugs and plugs each back 100 times and checks nothing
    is left.

## 1.1.0 — polish pass (2026-09-25)

A **minor**, by this file's own rule: one optional field added, nothing removed and no
signature moved. `"kernel": "^1.0"` still resolves. `KERNEL_VERSION` in
`backend/crates/server/src/plugins.rs` moved with it — the two are one number and nothing
checks that automatically.

- **`SectionLineEdit` gained `remove?: boolean`**, and with it the meaning of `value`
  changed: **`value` is now written literally, `null` included**, and `remove: true` is how
  a key's line is deleted.

  The old shape could not express the difference. `FmValue` already contains `null`, so one
  field could not mean both "write this" and "write nothing", and the documented reading —
  `value: null` deletes — spent the only spelling JSON has for an explicit null on
  deletion. The strict YAML subset of SPEC §3.4 *has* a `null` scalar, `core::splice`'s own
  `SectionLineEdit` is an `Option<Value>` that distinguishes the two, and the conformance
  corpus exercises both cases; only the `@kernel` shape could not say which was meant.

  **If you wrote `{ key, value: null }` to remove a key, it now writes `key: null`.** Add
  `remove: true`. Nothing in the base distribution did — the only caller was the kernel's
  own `settings`, where `settings.remove(key)` and `settings.set(key, null)` had been the
  same call and are now the two different things they read as.

  **This is a behaviour break inside a minor, and the gate at the top of this file cannot
  catch it.** The rule there is about the *shape* of the surface — nothing was removed and
  no signature moved, so `"kernel": "^1.0"` resolves, `KERNEL_API_MAJOR` is still `1`, and
  a plugin built against 1.0.0 installs and passes the loader's boot re-check. The two
  spellings are byte-identical on the way in, so no check could tell them apart even if one
  wanted to. It shipped as a minor anyway because the alternative was a `2.0.0` that
  re-declared a contract published days earlier for one field's semantics, and because
  every consumer in existence is in this repository and was migrated in the same commit.

  What stands in for the gate: `kernel.documents.splice.spliceSection` **warns, once per
  plugin and key**, when a `null` arrives with no `remove` field at all — the write follows
  the new contract, and the author is told at the call site that made it. Pass
  `remove: false` alongside the null to say you meant it. If a plugin outside this
  repository ever ships against 1.0.0, that warning is the migration note; the next
  semantic change to an existing field is a major, because there will then be somebody to
  break.

- **`core.resolveTitle` and `core.normalizeDate` work.** Same signatures, no longer
  throwing: `CoreBindings` carries all five Wasm exports now, so a plugin can resolve a
  title without a `parseDocument` round trip and spell a date the way the server's
  materialization will (SPEC §3.4) — which is what makes a locally-derived `fm.date` sort
  the same on this client as on the server.

Not `@kernel`, but in the same pass and visible to a plugin author replacing a base
plugin: `DocumentModeProps` (in `plugins/base/_shared/points.ts`, the base distribution's
own file) gained an optional `line?: number`, the 1-based line of `#/doc/<id>?line=42`.
