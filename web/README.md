# `web/` — ddd kernel and PWA

The client half of ddd: the offline-first kernel (projection store, sync client, local
query engine, the shared Rust core compiled to Wasm), the `@kernel` plugin contract, the
plugin loader and the PWA. Everything visible in the app is a plugin in
`../plugins/base/`.

```
kernel-api/src/          the @kernel contract (frozen); /kernel.d.ts is generated from it
kernel/src/protocol.ts   the /api/sync wire protocol, mirroring ../backend/PROTOCOL.md
kernel/src/store/        IndexedDB projection store (one store, the whole workspace)
kernel/src/sync/         change feed, lazy document hydration, reconnect policy
kernel/src/query/        the shared query engine (Wasm, in a Worker): filter, search, relations, sort
kernel/src/wasm/         bindings to the shared Rust core; pkg/ is generated
kernel/src/runtime/      the implementation of @kernel over all of the above
app/                     the PWA: boot, auth gate, plugin loader, safe mode, service worker
app/runtime/             one re-export module per blessed runtime-layer specifier
app/e2e/                 Playwright suite for the real app
collab/                  collaboration suite (see collab/README.md)
demo/                    a minimal sync demo page, used as a fixture by the smoke test and harnesses
demo/e2e/                Playwright smoke + two-browser live collaboration against the demo
harness/                 convergence and performance harnesses
../plugins/base/         the base distribution — the visible app
../plugins/examples/     third-party example plugins, built against /kernel.d.ts only
```

The app is `app/`. `demo/` is not the product.

## The two `@kernel`s

- `@kernel` (exact) is the **public plugin contract** in `kernel-api/`. Plugins may import
  only this.
- `@kernel/…` is kernel internals in `kernel/src/`.

One semver covers the `@kernel` surface and the Wasm ABI.
`kernel/src/runtime/contract-parity.ts` fails the typecheck if the contract and the
internals drift apart.

## Running it

Prerequisites for `mise run wasm`: the `wasm32-unknown-unknown` target and a
`wasm-bindgen-cli` whose version matches `backend/crates/core/Cargo.toml` **exactly**.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version <version from backend/crates/core/Cargo.toml>
```

Make sure the rustup `cargo`/`rustc` are the ones on `PATH`; a distro-packaged Rust
usually has no wasm target and no `rustup` to add one.

From the repo root:

```bash
cp .env.example .env       # then put a real SESSION_SECRET in it
mise run web-build         # Wasm core + kernel.d.ts + PWA bundle + base plugins
mise run dev               # mongo in docker + the server on :8080, serving the built app
```

| Task | What it runs |
|---|---|
| `mise run dev` | Mongo + the server on `:8080`, serving the last `web-build` output (one origin, real CSP, nonced import map, service worker). |
| `mise run app` | The app with live reload on `:5174` (Vite), proxying `/api`, `/plugins`, `/importmap.json`, `/kernel.d.ts` and the socket to the server. |
| `mise run dev-hot` | Live reload on `:$PORT` (8080), LAN-exposed, with the server on `PORT+1`. Use it to iterate from a phone's browser. Extra hosts go in `APP_ORIGIN_HOSTS`. |
| `mise run web` | The demo page on `:5173`. |
| `mise run wasm` | Builds `backend/crates/core` (feature `wasm`) into `kernel/src/wasm/pkg/`. Rerun after core changes. |
| `mise run web-build` | `wasm`, then `kernel:dts`, `build:app`, `build:plugins`. |
| `mise run web-check` | Generated-file check, plugin graph check, typecheck, unit tests. |

### Configuration

The server reads these from `.env` (see `.env.example` for the full list):

| Variable | Purpose |
|---|---|
| `WEB_DIST_DIR` | Built PWA (`web/app/dist`). Set it and the server serves the app; unset, the server is API-only (right for `mise run app`). |
| `PLUGINS_DIR` | Installed plugins (`plugins/base/dist`). |
| `KERNEL_DTS_PATH` | The generated contract served at `/kernel.d.ts`. |
| `APP_ORIGIN` | Origins allowed to open the sync socket. |
| `DISABLE_PLUGINS` | Server-side safe mode: every client gets an empty plugin list. |

Gotchas:

- **`APP_ORIGIN` must list the page's origin**, or the WebSocket upgrade is refused with
  **403** before it authenticates: the page loads and never syncs. When the server serves
  the app itself, that is its own origin (e.g. `http://localhost:8080`); for the demo it is
  `http://localhost:5173`.
- **Relative paths resolve against the server's working directory.** `mise run dev` runs in
  `backend/` and passes `../web/app/dist` etc. explicitly. With wrong paths the server
  silently finds nothing, which looks like "plugins failed to load".
- **The Vite dev servers proxy `/api` including the WebSocket**, so cookies, the origin
  allowlist and the socket behave as in production. Point them at another server with
  `DDD_SERVER=http://host:port`. The harnesses read `DDD_SERVER` too; the demo Playwright
  config and the perf harness read the page origin from `DDD_WEB`
  (default `http://127.0.0.1:5173`). Export them for everything involved, or every `/api`
  call 404s.

### npm scripts (in `web/`)

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit`. Passes without building the Wasm package. |
| `npm run test` | Vitest unit tests, including the shared-core parity suite read from `backend/crates/core/corpus/` (self-skips until `mise run wasm` has run). |
| `npm run test:collab` | The collaboration suite (`collab/README.md`). |
| `npm run dev` / `build` / `preview` | Vite, for the demo page. |
| `npm run dev:app` | Vite, for the app. |
| `npm run build:app` | Runtime layer → app bundle → service worker, in that order. |
| `npm run build:plugins` | `plugins/base/*` → `plugins/base/dist/<id>/<version>/`, the layout the server serves. |
| `npm run kernel:dts` | Generates `kernel-api/dist/kernel.d.ts`. |
| `npm run check:generated` | Fails if generated manifest types are stale. |
| `npm run check:plugins` | Checks the plugin dependency graph: versions, cycles, declared imports. |
| `npm run e2e` | Playwright against the demo. Needs a running server and `npx playwright install chromium`; skips when `/api` is unreachable. |
| `npm run e2e:app` | Playwright against the real app. Starts its own server — see below. |
| `npm run harness:convergence` | N simulated clients with random ops and partitions; checks convergence and materialization equality. `--seed=N` replays; also `--clients=`, `--operations=`, `--journal=`. |
| `npm run harness:perf` | 5 000 documents: bootstrap, catch-up, round-trip and client heap. Results in [`../backend/PERF.md`](../backend/PERF.md). |
| `node scripts/build-examples.mjs` | Builds `plugins/examples/*` into `plugins/examples/dist/`. |
| `node scripts/compose-plugins.mjs <dir> [--exclude=…] [--include-examples=…]` | Builds a registry directory from already-built plugins. |

## How the app boots

`app/src/main.tsx` runs these steps in order:

1. **Browser check, then tokens.** A browser without import maps gets a readable message.
   The kernel's default light/dark `--ddd-*` tokens are painted before React, so the boot,
   auth and failure screens are styled before any plugin loads.
2. **Session.** `GET /api/auth/me`; no session shows the auth gate. Browsers use the
   HTTP-only cookie; the Flutter shell uses a bearer token, stored only inside the shell.
   - **A 401 never clears local data.** Mid-session it shows a re-auth overlay over the
     still-mounted workspace. Only an explicit logout clears the stores.
   - **Offline boot works.** `/auth/me` and `/plugins` are never cached by the service
     worker; instead each falls back to what the last successful boot remembered
     (`app/src/boot/cache.ts`). An expired session is reported by the socket (`4401`).
3. **Kernel.** `initKernel` opens the IndexedDB projection, starts sync and the query
   engine, loads the Wasm core and starts settings, so `kernel.settings.get()` is
   synchronous inside `activate()`.
4. **Frame, then plugins.** The shell appears while plugins behind it are still arriving.
   **Every registry host must subscribe** (`useRegistry`): a component that reads
   `registry.get()` once will miss anything registered later.
5. **Import map.** In production the server injects it with the response's CSP nonce; under
   Vite, `app/src/loader/importmap.ts` installs one. Either way there is exactly one React,
   one Yjs, one `@kernel`, and a `plugin:<id>` entry per plugin.
6. **Load in dependency order.** `GET /api/plugins` returns the order (`load.normal`, or
   `load.safe` for `?safe=1`). The loader imports each module, links its `style.css` and
   calls `activate(kernel)`.

### Failures and safe mode

- An `activate()` throw marks that plugin failed, withdraws everything it registered,
  **skips all transitive dependents**, and produces **one aggregated notice**.
- A render-time throw becomes an in-place "plugin X failed" chip plus a notice.
- The whole mount sits in an app-level error boundary, so a broken shell never leaves a
  white page.
- `host.notices` is drawn by whoever holds the mount: `shell-ui`'s bell normally, the
  kernel's own strip when nothing is mounted or the holder crashed. **A replacement shell
  that takes the mount must draw notices.**

Ways out:

| | Effect |
|---|---|
| `?safe=1` | Base distribution only. |
| `?safe=bare` | No plugins; the kernel's own plugin manager. |
| `DISABLE_PLUGINS=1` (server) | Every client gets an empty plugin list; the backend plugin host stops too. |

## Writing a plugin

A plugin is one ES module with a default `activate(kernel)`, plus a manifest. It is
installed **once, on the server**, and every client picks it up: no client rebuild, no
client-side registration.

Start by copying `plugins/examples/alt-editor`: a replacement `edit` mode, a textarea bound
to the document's `Y.Text`.

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
  "kernel": "^3.0",             // checked at install and again by the loader at boot
  "dependencies": { "document-surface": "^2.0" },  // what you import as `plugin:<id>`
  "peerLibraries": { "react": "^18.0.0", "yjs": "^13.0.0" },
  "frontend": { "module": "frontend/index.mjs", "style": "frontend/style.css" }
}
```

Rules:

- **`@kernel` is the only contract.** Types come from `/kernel.d.ts`
  (`npm run kernel:dts`). `plugins/examples/tsconfig.json` points `@kernel` at that
  generated file, so the examples prove they build against it alone.
- **Reach another plugin through its specifier, never its files.**
  `import { addMode } from "plugin:document-surface"`, and list it under `dependencies`.
  Optional ones go under `optionalDependencies` and are reached only with
  `await kernel.plugins.optional(id)`. Types come from that plugin's generated
  `frontend/index.d.ts`. Export what others should use as named exports of `src/index.tsx`.
- **Keep the runtime layer and other plugins external**: `react`, `react-dom`, `yjs`,
  `@kernel`, the CodeMirror and unified/remark packages, and every `plugin:<id>`.
  `plugins/base/_shared/vite.plugin-config.mjs` is the reference build config. Bundling any
  of them gives the plugin its own React or Yjs, and the failure looks like a kernel bug.
  Bundle anything else freely.
- **Metadata writes are splices, never rewrites.** Use `kernel.documents.splice.*` for
  frontmatter values and your own `%%%` section. Parse → re-serialize → replace destroys
  comments and key order and corrupts concurrent edits.

### Build and serve it

For local development, compose a registry directory and point the server at it:

```bash
node scripts/build-examples.mjs                      # plugins/examples/* -> plugins/examples/dist
node scripts/compose-plugins.mjs /tmp/reg \
    --exclude=editor --include-examples=alt-editor
PLUGINS_DIR=/tmp/reg cargo run -- serve              # from backend/
```

To install on a running server, package it with `mise run plugin-package <id>` and install
the `.zip` as an admin, or drop it into `PLUGIN_INBOX_DIR`. New packages are pending until
an admin approves them.

> **Rebuilt a plugin without bumping its version?** Plugin URLs are version-scoped and
> served `immutable`, so a browser that already loaded `1.0.0` keeps its cached copy and no
> reload fixes it. Bump the version or use a fresh browser profile.

## Design notes

- **The projection replicates; CRDTs hydrate lazily.** Every document is readable and
  searchable offline from one IndexedDB store (about 1× the size of the notes). Full
  `Y.Doc`s are fetched when a document is opened, LRU-capped at about 20. A document never
  opened is read-only offline until reconnect.
- **The resume point is the server's `safe_seq`**, stored in the same transaction as the
  rows it describes, never the highest `seq` seen. Getting this wrong loses documents
  silently; see [`../backend/PROTOCOL.md`](../backend/PROTOCOL.md) §2.2.
- **Parsing and filtering are Rust.** `kernel/src/wasm` calls the same code as the server,
  so offline and online behaviour agree. Filter compilation to Mongo stays server-side.
- **Recovery is re-derivation, not replay:** re-subscribe the feed from a watermark, or
  send a state vector and take the diff.
- **The kernel is minimal and the UI is plugins.** The kernel knows one model (a document
  is text); extension-point names are opaque strings to it. Every visible thing, including
  the shell, is a replaceable contribution.
- **One copy of React, Yjs and `@kernel`**, via the server-generated import map. Two copies
  would break hooks, context and `instanceof` across plugin boundaries.

## Wire protocol

[`../backend/PROTOCOL.md`](../backend/PROTOCOL.md) is authoritative for the socket and the
bootstrap stream; this side implements it independently of the server. If the code and
PROTOCOL.md disagree, treat it as a bug. PROTOCOL.md §10 is a conformance checklist;
`harness/src/rest.ts` watches the wire and reports violations.

## Tests against a server

### Credentials

The harnesses and the demo Playwright suite **share one dev account**
(`harness@example.com`): whichever runs first on an empty workspace registers it, the rest
log in. Registration past the first user is invite-only, so separate defaults would lock
each other out.

- `DDD_EMAIL` / `DDD_PASSWORD`: harness and smoke.
- `DDD_SMOKE_EMAIL` / `DDD_SMOKE_PASSWORD`: Playwright smoke only.
- `DDD_INVITE=<token>`: let the harness register on a workspace that already has users.

Against a workspace whose first user is someone else, they fail with the server's refusal.

### App end-to-end suite

```bash
# from the repo root
docker compose up -d --wait mongo
cargo build --manifest-path backend/Cargo.toml --bin ddd
mise run web-build
node web/scripts/build-examples.mjs
cd web && npm run e2e:app
```

The suite starts its own server (`app/e2e/server.mjs`) and **drops its test database before
every run**, because several journeys test the first-user flow. Its registry is the base
distribution plus the `extra-task-states` example.

| Variable | Effect |
|---|---|
| `DDD_APP` | Use a server you started. The database is then not dropped, so use a fresh server for repeatable runs. |
| `DDD_E2E_PORT` | Port (default `8121`). |
| `DDD_E2E_DB` | Database name (default `ddd_e2e`). |
| `DDD_E2E_PLUGINS` | Registry directory instead of the composed default. |
| `DDD_E2E_KEEP_DB=1` | Don't drop the database. |
| `DDD_E2E_BINARY` | Server binary (default `backend/target/debug/ddd`). |

Notable specs in `app/e2e/`:

| Spec | Covers |
|---|---|
| `journeys.spec.ts` | Register, create, edit, tasks, folders (asserting raw text was spliced), properties, offline search and read, two browsers live, themes, Trash, invites. |
| `safe-mode.spec.ts` | A plugin broken on disk: degraded boot with one notice, `?safe=1`, `?safe=bare`, recovery. |
| `acceptance.spec.ts` | Base minus `editor` plus `plugins/examples/alt-editor`: the app works with a separately-authored editor. |
| `mobile-*.spec.ts` | No horizontal overflow at 390 px across every route, settings and admin section. |
| `collab.spec.ts` | Two accounts in two browsers (see `collab/README.md`). |
| `zz-folder-tree.spec.ts`, `zzz-pagination.spec.ts` | Prefixed to run last: they add documents to the shared workspace, which would break other specs' counts and first-page assertions. |

Service workers are blocked in this suite: their immutable plugin cache would serve stale
builds.

Interfaces, file ownership and contribution rules for this tree are in
[`CONTRACTS.md`](CONTRACTS.md).
