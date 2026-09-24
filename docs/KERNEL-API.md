# `@kernel` changelog

The contract plugins compile against (SPEC §6.4: "`docs/KERNEL-API.md` is the changelog").
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
{ "kernel": "^1.0" }
```

**The backend half's contract is `backend/HOST-ABI.md`**, and it is the *same* semver.
That is the point of "one `kernel` semver covers both": a plugin declaring `"kernel":
"^1.0"` is declaring both the `@kernel` surface its frontend half compiles against and the
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
   crate beside it — `plugins/base/calendar/ics/` is the reference, with 58 host-target
   tests behind `mise run plugin-test`.
3. **Reconcile, never accumulate.** Hooks are at-most-once with no retry and cron skips
   missed runs (SPEC §6.3), so every run must be able to start from whatever state it
   finds. The calendar plugin's sync is a full reconciliation for exactly this reason, and
   it is also why an unchanged feed costs **zero** writes: `splice_section` drops edits
   whose value already matches, so an idempotent daily sync writes no CRDT history at all.

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
- `core.resolveTitle` / `core.normalizeDate` — **still throw.** The Wasm ABI exports
  `resolve_title` and `normalize_date`, but `CoreBindings` does not surface them yet; that
  is a `wasm`-area change (it owns both halves of the ABI).

A plugin may compile against all of it today; the two `core` methods throw with a message
naming what is missing.

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

- **A machine-owned document is an ordinary document.** The calendar's event notes are
  markdown with frontmatter, in the workspace, searchable and editable like everything
  else; `created_by` is `plugin:<id>` and that is the only difference. A plugin reading
  them uses `documents.query`, not a plugin-specific channel.
- **A user's edit to a machine-owned document survives the next sync.** The owning plugin
  is expected to reconcile around a human's tombstone rather than re-create it, and never
  to rewrite a document it did not create — the host refuses that outright
  (`rewrite_document` checks `created_by`).
