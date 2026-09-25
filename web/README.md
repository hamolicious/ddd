# `web/` — Life Manager kernel and PWA

The client half of Life Manager: the offline-first substrate of **M2** (projection store,
sync client, local query engine, the shared Rust core as Wasm) and the microkernel
frontend of **M3** (the `@kernel` contract, the plugin loader, the PWA).

**M4 changed nothing here in contract terms** — no `@kernel` surface was added and no
signature moved. What it added is the management half of `admin`, plus two proof plugins in
`../plugins/base/` (`calendar`, whose backend half cronned an ICS feed into machine-owned
documents, and `agenda`, pure frontend with no backend and no capabilities). **Both were
removed on 2026-09-24** at the owner's direction; they are in git history and nothing here
refers to them. The build scripts they exercised are unchanged and still the path any
plugin takes: `build:plugins` builds frontend halves, `build-wasm-plugins.mjs` builds
backend halves into the same installed layout, `package-plugin.mjs` writes the installable
`.zip`.

**The app is `app/`.** `demo/` is the M2 page, kept exactly as it was: it is the surface
the SPEC §8 Playwright smoke drives and a fixture for the harnesses, not the product.

```
kernel-api/src/          the @kernel contract — FROZEN, and what /kernel.d.ts is built from
kernel/src/protocol.ts   the /api/sync wire protocol, mirroring ../backend/PROTOCOL.md
kernel/src/store/        IndexedDB projection store (one store, the whole workspace)
kernel/src/sync/         change feed, lazy document hydration, reconnect policy
kernel/src/query/        filter (Wasm) + sort + full-text search (MiniSearch in a Worker)
kernel/src/wasm/         bindings to the shared Rust core; pkg/ is generated
kernel/src/runtime/      the implementation of @kernel over all of the above
app/                     the PWA: boot, auth gate, plugin loader, safe mode, service worker
app/runtime/             one re-export module per blessed runtime-layer specifier
app/e2e/                 the M3 journeys + safe mode + the M3 acceptance test
demo/                    the M2 page (harness fixture; the smoke's surface)
demo/e2e/                the SPEC §8 Playwright smoke, plus two-browser live collaboration
harness/                 convergence and performance harnesses (SPEC §9 M2 gate)
../plugins/base/         the base distribution — the visible app (SPEC §6.5)
../plugins/examples/     third-party plugins, built against /kernel.d.ts only
```

## The two `@kernel`s

`@kernel` (exact) is the **public plugin contract** in `kernel-api/`; `@kernel/…` is kernel
internals in `kernel/src/`. Plugins may import only the first. One semver covers the
`@kernel` surface and the Wasm ABI (SPEC §6.4), and
`kernel/src/runtime/contract-parity.ts` fails the typecheck if the contract and the
internals drift apart.

## Running it

```bash
cd ..                      # repo root
cp .env.example .env       # then put a real SESSION_SECRET in it
mise run dev               # mongo in docker + the Rust server on :8080
mise run wasm              # build the shared core to Wasm (once, and after core changes)
mise run web               # the M2 demo page on :5173
mise run web-build         # kernel.d.ts + the PWA bundle + the base plugins
mise run app               # the real app on :5174, /api and /plugins proxied to :8080
```

To have the **server** serve the app (production shape: one origin, the nonced import map,
immutable plugin URLs), build once and point it at the output:

```bash
mise run web-build
# in .env
WEB_DIST_DIR=web/app/dist
PLUGINS_DIR=plugins/base/dist
APP_ORIGIN=http://localhost:8080     # its own origin, or the socket is refused with 403
```

The dev server proxies `/api` **including the WebSocket**, so the browser sees one
origin: cookies, the `Origin` allowlist and the sync socket all behave the way they
will in production. Point it elsewhere with `LM_SERVER=http://host:port` — and note
that the **harness and the Playwright config read the same variable**, so a server
on a non-default port needs it exported for Vite *and* for whatever drives the
browser, or the page loads and every `/api` call 404s.

`APP_ORIGIN` on the server must list the Vite origin (`http://localhost:5173`), or
the WebSocket upgrade is refused with **403** before it authenticates
(PROTOCOL.md §1.2). `.env.example` ships with only `:8080` in it.

`mise run wasm` needs the `wasm32-unknown-unknown` target and a `wasm-bindgen`
whose version matches `backend/crates/core/Cargo.toml` exactly. With a
rustup-managed toolchain that is `rustup target add wasm32-unknown-unknown` plus
`cargo install wasm-bindgen-cli --version <that version>`; make sure the rustup
`cargo`/`rustc` are the ones on `PATH` (a distro-packaged Rust generally ships no
wasm target and no `rustup` to add one).

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — the gate. Passes without ever building the Wasm package. |
| `npm run test` | Vitest unit tests: protocol framing, backoff, the IndexedDB store, feed and hydration clients, sort semantics, search, **and the shared-core parity suite** read straight out of `backend/crates/core/corpus/` (it self-skips, reporting why, until `mise run wasm` has run). |
| `npm run dev` / `build` / `preview` | Vite. |
| `npm run e2e` | Playwright against the **M2 demo**: the SPEC §8 smoke and two-browser live collaboration. Needs a server and `npx playwright install chromium`; skips with a message when `/api` is unreachable. |
| `npm run e2e:app` | Playwright against the **real app** (`playwright.app.config.ts`): the M3 journeys, browsing, safe mode, and the M3 acceptance test. Starts its own server — see below. |
| `npm run harness:convergence` | N simulated clients, randomized ops/partitions → convergence + materialization equality. `--seed=N` replays; `--clients=`/`--operations=`/`--journal=` are the other knobs. |
| `npm run harness:perf` | 5 000 documents: bootstrap, catch-up, round-trip and client-heap numbers. Recorded in [`../backend/PERF.md`](../backend/PERF.md). |
| `mise run wasm` | Builds `backend/crates/core` (feature `wasm`) into `kernel/src/wasm/pkg/`. |
| `npm run kernel:dts` | Generates `kernel-api/dist/kernel.d.ts` — the file the server serves at `/kernel.d.ts`. |
| `npm run build:app` | Runtime layer → app bundle → service worker, in that order (each reads the previous one's output). |
| `npm run build:plugins` | `plugins/base/*` → `plugins/base/dist/<id>/<version>/`, the layout the server serves. |
| `node scripts/build-examples.mjs` | The same, for `plugins/examples/*`. |
| `node scripts/compose-plugins.mjs <dir> [--exclude=…] [--include-examples=…]` | Builds a registry directory out of already-built plugins. How a plugin gets "disabled" before M4. |

## How the app boots

`app/src/main.tsx` is the whole sequence, and the order is load-bearing:

1. **Browser floor, then tokens.** An import-map-less browser gets a readable message
   (SPEC §8). Then the kernel's default light/dark tokens are painted onto
   `:root` *before React* — the boot screen, the auth gate and the boot-failure screen
   are written in `--lm-*`, and they render before any plugin (or the theme layer) exists.
2. **Session.** `GET /api/auth/me`; no session ⇒ the auth gate. A cookie session for a
   browser, a bearer token for the Flutter shell (SPEC §5.2) — and the token is read and
   stored **only** inside the shell, because a browser's credential is the HTTP-only cookie
   and an origin that runs full-trust plugin code is no place to keep a readable one. A
   **401 never clears local data** — mid-session it raises a re-auth overlay over the
   still-mounted workspace, and only an explicit logout clears the stores.

   **With no server this step does not fail.** `/auth/me` (and `/plugins`, in step 6) are
   `NetworkOnly` in the service worker on purpose — a cached API response is a second,
   silently-wrong copy of the workspace — so each falls back to what the last successful boot
   remembered (`app/src/boot/cache.ts`): the session user, and the installed plugin list. An
   offline reload therefore opens the local workspace rather than a boot-failure screen,
   which is the whole point of SPEC §4.1/§8. If the session really has expired, the socket
   says so with `4401` and the re-auth overlay appears over a workspace that is still
   readable. Only a server that actually answered 401 forgets the remembered session.
3. **Kernel.** `initKernel` opens the IndexedDB projection, starts the sync client and the
   query engine, loads the Wasm core, and `await host.settings.start()` — that last one is
   what makes `kernel.settings.get()` synchronous inside `activate()`.
4. **Frame, then plugins.** `AppFrame` renders *before* `activatePlugins`. `shell-ui` takes
   the single `kernel.ui.mount` inside its own `activate()`, so **the shell appears while
   the plugins behind it are still arriving** — deliberately, because one slow plugin must
   not hold the whole app behind a boot screen. The consequence is a rule, not a caveat:
   *every consumer of a registry point has to be live.* A component that reads
   `extensions.get()` once at first render and never subscribes will be permanently missing
   whatever landed after it. (This is what `app/e2e/helpers.ts`'s `pluginsActivated()` waits
   for, and how two such bugs were found.)
5. **Import map.** In production the server injects it into `index.html` with the response's
   CSP nonce; in `vite dev` there is no server injection, so `app/src/loader/importmap.ts`
   installs one over this bundle's own modules before the first plugin is imported. Either
   way there is exactly one React, one Yjs and one `@kernel`.
6. **Load, in topological order.** `GET /api/plugins`, resolve the dependency graph, import
   each module, link its `style.css`, call `activate(kernel)`, and register the return value
   as the plugin's API for declared dependents.

Failure is contained at every step (SPEC §6.4): an `activate()` throw marks that plugin
failed, withdraws what it registered (**including the extension points it defined**, so a
replacement can claim them), **skips all transitive dependents**, and produces **one
aggregated notice**; a render-time throw becomes an in-place "plugin X failed" chip from the
kernel's error boundary, *and* a line in the notices.

**One rendering of those notices, not two.** `host.notices` is the single list, and
whoever holds the mount draws it: `shell-ui`'s bell while a shell is up (it opens itself
for a notice that arrives *after* it mounted — what was already on the list at boot gets
the badge, not a panel that springs open on every reload), the kernel's own strip when
nothing is mounted, when the holder threw while rendering, **and in `?safe=bare`, where
the kernel's own `BareManager` holds the mount and draws no notices at all**. Both drew it
at once until the polish pass, which put every notice on screen twice and made "dismiss"
something you had to do in two places — and the first cut of the fix keyed on "something
holds the mount", which blanked the strip on the recovery screen. The consequence for a
replacement shell is worth knowing: taking the mount means taking that job. The mount as a
whole sits inside
one more boundary that the app owns, because the per-contribution wrappers cannot cover the
shell's own render or a contributed `icon` (a `ReactNode` is not a component) — and an
uncaught render error unmounts the React root, which is a white page with no way out. The
ways out are `?safe=1` (base distribution only), `?safe=bare` (no plugins — the kernel's own
plugin manager), and `DISABLE_PLUGINS=1` server-side.

## Writing a plugin

A plugin is one ES module with a default `activate(kernel)`, plus a manifest. It is
installed **once, on the server**, and every client falls in step — there is no client
rebuild and no client-side registration (SPEC §1).

`plugins/examples/alt-editor` is the reference third-party plugin, and it is deliberately
the smallest interesting one: a replacement `edit` mode, a textarea bound to the
document's `Y.Text`. Copy it.

```
my-plugin/
├── manifest.json
└── src/
    ├── index.tsx      export default function activate(kernel) { … }
    └── style.css      linked by the kernel on activation
```

```jsonc
{
  "id": "my-plugin",            // must equal the directory name
  "version": "1.0.0",
  "kernel": "^1.0",             // checked at install *and* re-checked by the loader at boot
  "dependencies": { "document-surface": "^1.0" },
  "peerLibraries": { "react": "^18.0.0", "yjs": "^13.0.0" },
  "frontend": { "module": "frontend/index.mjs", "style": "frontend/style.css" }
}
```

Four rules, each of them a consequence of how loading works rather than a style
preference:

- **`@kernel` is the only contract.** Types come from `/kernel.d.ts` (generated by
  `npm run kernel:dts`). `plugins/examples/tsconfig.json` points `@kernel` at that
  *generated file* rather than at `kernel-api/src`, which is what makes "builds against
  `kernel.d.ts` only" a checked claim — if the generator drops something the examples use,
  that config fails and `web/tsconfig.json` does not.
- **Never import another plugin's source.** Depend on it in the manifest and ask for its
  API with `kernel.services.require("<id>")`. That includes `plugins/base/_shared/points.ts`:
  it is the base distribution's internal file, not part of `@kernel` — the kernel knows
  point names only as opaque strings (SPEC §2), so a third-party plugin re-declares the
  payload shape it contributes. `alt-editor` shows the shape of that.
- **The blessed runtime layer stays external** (`react`, `react-dom`, `yjs`, `@kernel`, the
  CodeMirror and unified/remark rows). `plugins/base/_shared/vite.plugin-config.mjs` is the
  reference build config and already does this; bundling any of them gives the plugin its
  own React or its own Yjs, and the failure reads as a kernel bug. Anything *outside* that
  list you bundle normally — that is allowed, and the cost is bundle size, not correctness.
- **Metadata writes are splices, never rewrites** (SPEC §3.3): `kernel.documents.splice.*`
  for frontmatter values and for your own `%%%` section. A parse → re-serialize → replace
  round trip destroys comments and key order and corrupts under concurrent edits.

Build and serve it:

```bash
node scripts/build-examples.mjs                      # plugins/examples/* -> examples/dist
node scripts/compose-plugins.mjs /tmp/reg \
    --exclude=editor --include-examples=alt-editor   # a registry directory
PLUGINS_DIR=/tmp/reg  cargo run -- serve             # the directory *is* the registry in M3
```

In M3 the registry is the directory the server scans; enable/disable and the approval flow
are M4 endpoints, so composing a directory is how you swap a plugin out. That is exactly
what the acceptance test does.

> **Rebuilding a plugin without bumping its version?** Plugin URLs are version-scoped and
> served `immutable` (SPEC §8), so a browser that already loaded `1.0.0` keeps serving its
> cached copy from disk — no reload fixes it. Bump the version, or use a fresh profile (a
> Playwright context is one). This is the intended production behaviour and a real
> development trap; it is also what made a set of stale scaffold-stub plugins look like a
> plugin bug during integration.

## The shape of things

- **The projection replicates; CRDTs hydrate lazily.** Every document is readable
  and searchable offline from one IndexedDB store (~1× the size of the notes);
  full `Y.Doc`s are fetched when a document is opened, LRU-capped at ~20 (SPEC
  §4.1). An unopened document is read-only offline until reconnect.
- **The resume point is the server's `safe_seq`**, stored in the same transaction
  as the rows it describes — never the highest `seq` seen. The reasoning is in
  [`../backend/PROTOCOL.md`](../backend/PROTOCOL.md) §2.2, and getting it wrong
  loses documents silently.
- **Parsing and filtering are Rust.** `kernel/src/wasm` calls the same code the
  server calls, so offline and online behaviour agree by construction (SPEC §2).
  Filter *compilation* to Mongo stays server-side.
- **A 401 never clears local data** (SPEC §5.3). Only an explicit logout does.
- **Recovery is re-derivation, not replay.** Every "something went wrong" path in
  the protocol resolves to one of two moves: re-subscribe the feed from a
  watermark, or send a state vector and take the diff.
- **The kernel is minimal and the UI is plugins.** The kernel knows one domain model — a
  document is text — and extension-point names are opaque strings to it. Every visible
  thing, including the shell, is a replaceable contribution (SPEC §6.1).
- **One copy of React, Yjs and `@kernel`**, served through an import map the server
  generates (SPEC §6.4). The app bundle externalizes them exactly like a plugin does; two
  copies would break hooks, context and `instanceof` across every plugin boundary.
- **A failing plugin is contained**: an error boundary per contribution, transitive
  dependents skipped, one aggregated notice, and `?safe=1` / `?safe=bare` as the way out.

## Wire protocol

[`../backend/PROTOCOL.md`](../backend/PROTOCOL.md) is authoritative for everything
on the socket and the bootstrap stream, and this side implements it independently
from the server. Where an implementation and that document disagree, **the document
is the bug report**; where the document and [`../SPEC.md`](../SPEC.md) disagree, the
SPEC wins. Its §10 is a conformance checklist, and the harness is its executable
half — `harness/src/rest.ts` watches the wire and reports violations rather than
asserting on them one at a time.

## Running the gates against a server

Both harnesses and the Playwright suite need credentials, and they **share one dev
account by default** (`harness@example.com`): whichever runs first on an empty
workspace registers it, and everything after logs in. That matters because
registration past the first user is invite-only (SPEC §5.1) — with different
default accounts, the first tool to run would claim the first-user slot and lock
the others out of that database permanently.

Override with `LM_EMAIL`/`LM_PASSWORD` (harness, also honoured by the smoke) or
`LM_SMOKE_EMAIL`/`LM_SMOKE_PASSWORD` (Playwright only). Pointed at a workspace
whose first user is somebody else, both fail with the refusal the server gave
rather than a bare timeout.

## The M3 end-to-end suite

```bash
cd ..                             # repo root
docker compose up -d --wait mongo
cargo build --manifest-path backend/Cargo.toml --bin life-manager
mise run web-build                # bundle + base plugins + kernel.d.ts
node web/scripts/build-examples.mjs
cd web && npm run e2e:app
```

It owns its server (`app/e2e/server.mjs`), because half the journeys are about the
first-user transition — register, then an admin invite, then a second user — and those are
only repeatable against a database that starts empty, so it **drops its test database
before every run**. The registry it serves is the base distribution plus
`extra-task-states`: `[ ]` and `[x]` are `markdown`'s own contributions *and* the only two
markers remark-gfm recognises, so a custom `[/]` is the only way to test that marker
semantics come from the registry (SPEC §6.6), and `?safe=1` needs a *non-base* plugin to
break.

| Spec | What it covers |
|---|---|
| `journeys.spec.ts` | Register → welcome documents → create from the palette → edit in CodeMirror and watch the list follow → toggle a task and set a plugin-contributed state → drag between folders and assert the raw text was **spliced** (comment, key order and `%%%` section byte-identical) → a date through the properties panel → offline search and offline read → two browsers live → a theme that survives a reload → Trash and restore → an invite a second user registers with. |
| `safe-mode.spec.ts` | Sabotages an installed plugin's module *on disk*, then: a normal boot degrades with one aggregated notice, `?safe=1` boots past it, `?safe=bare` reaches the kernel's own manager, and restoring the file recovers. Each step in a fresh context, because plugin URLs are immutable. |
| `browsing.spec.ts` | The two browsing behaviours that only exist assembled: a machine-owned document (`fm.path: .settings`) staying out of the list, the sidebar count *and* the folder tree until the toggle asks for it — three plugins that have to agree — and `#/doc/<id>?line=N` scrolling the editor, including on a query-only navigation into the document already open. |
| `acceptance.spec.ts` | **SPEC §9 M3's acceptance criterion.** Composes a registry of base-minus-`editor` plus `plugins/examples/alt-editor`, starts a second server over it, and shows the app working with `document.mode`'s `edit` provided by the separately-authored plugin — same tab, same command, same keybinding, and no CodeMirror in the page. |

Notes for running it: `LM_APP` points the suite at a server you started yourself (and
`webServer` then reuses it — which also means the database is *not* dropped, so a
repeatable run wants a fresh server). `LM_E2E_PORT`, `LM_E2E_DB`, `LM_E2E_PLUGINS` and
`LM_E2E_KEEP_DB=1` tune the launcher. Service workers are blocked in this suite: they add
nothing to these journeys and their immutable plugin cache makes rebuilds lie.

Interfaces, file ownership and the rules for filling this scaffold in are in
[`CONTRACTS.md`](CONTRACTS.md).
