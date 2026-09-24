# `web/` — Life Manager kernel and PWA

The client half of Life Manager. **This is M2** ([SPEC](../SPEC.md) §9): the
offline-first substrate — projection store, sync client, local query engine, and
the shared Rust core compiled to Wasm — plus a plain-TypeScript demo page that
exercises it end to end.

No React, no plugin loader, no import maps: those are M3, and the kernel is built
so they are additions rather than rewrites.

```
kernel/src/protocol.ts   the /api/sync wire protocol, mirroring ../backend/PROTOCOL.md
kernel/src/store/        IndexedDB projection store (one store, the whole workspace)
kernel/src/sync/         change feed, lazy document hydration, reconnect policy
kernel/src/query/        filter (Wasm) + sort + full-text search (MiniSearch in a Worker)
kernel/src/wasm/         bindings to the shared Rust core; pkg/ is generated
demo/                    login + live document list + one editable document + service worker
demo/e2e/                the SPEC §8 Playwright smoke, plus two-browser live collaboration
harness/                 convergence and performance harnesses (SPEC §9 M2 gate)
```

## Running it

```bash
cd ..                      # repo root
cp .env.example .env       # then put a real SESSION_SECRET in it
mise run dev               # mongo in docker + the Rust server on :8080
mise run wasm              # build the shared core to Wasm (once, and after core changes)
mise run web               # vite dev server on :5173, /api proxied to :8080
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
| `npm run e2e` | Playwright: the SPEC §8 smoke and two-browser live collaboration. Needs a server and `npx playwright install chromium`; skips with a message when `/api` is unreachable. |
| `npm run harness:convergence` | N simulated clients, randomized ops/partitions → convergence + materialization equality. `--seed=N` replays; `--clients=`/`--operations=`/`--journal=` are the other knobs. |
| `npm run harness:perf` | 5 000 documents: bootstrap, catch-up, round-trip and client-heap numbers. Recorded in [`../backend/PERF.md`](../backend/PERF.md). |
| `mise run wasm` | Builds `backend/crates/core` (feature `wasm`) into `kernel/src/wasm/pkg/`. |

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

Interfaces, file ownership and the rules for filling this scaffold in are in
[`CONTRACTS.md`](CONTRACTS.md).
