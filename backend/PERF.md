# Performance

Targets: a 5 000-document workspace with 3 concurrent editors; cold boot of
5 000 documents in under 30 s on LAN; update round trip p95 under 500 ms.

Measured by `web/harness/src/perf.ts` (`npm run harness:perf`) against a real
server and a real Mongo. Every number below is one command, not an estimate —
re-run it after any change to the feed, the bootstrap endpoint, or the projection
row shape.

## How to reproduce

```sh
mise run wasm                                  # the harness fails hard without it
docker compose up -d --wait mongo
cd backend && cargo build --bin ddd
MONGO_DATABASE=ddd_perf BIND_ADDR=127.0.0.1:8099 ./target/debug/ddd serve

cd web
npx playwright install chromium                # the client-heap number only
DDD_SERVER=http://127.0.0.1:8099 npx vite --port 5173 --host 127.0.0.1
DDD_SERVER=http://127.0.0.1:8099 DDD_WEB=http://localhost:5173 npm run harness:perf
```

`DDD_SERVER` must be set for **both** Vite and the harness: Vite proxies `/api` to
it, and the in-page measurement loads the demo from the Vite origin. Without it
the browser half fails with `HTTP 404` and the run reports the heap as skipped.

## Results — 2026-09-24

Loopback (server and Mongo on one machine, Mongo in Docker), debug build of the
server. A release build and a real LAN hop both move these numbers; the margins
are wide enough that neither threatens the targets.

| Measurement | Result | Target | Verdict |
|---|---|---|---|
| Bootstrap, 5 000 docs (REST, server-side) | **1 148 ms**, 4.6 MiB, 25 pages | < 30 s | **PASS** — 26× margin |
| Cold client through the real path (`feed.reset` → bootstrap → re-subscribe) | **1 171 ms** for 5 000 rows | < 30 s | **PASS** |
| In-page cold boot (Chromium, demo origin) | **732 ms** bootstrap + **90 ms** IndexedDB write | < 30 s | **PASS** |
| Feed catch-up after 25 changed documents | **23 ms** (25 rows from seq 10088) | — | — |
| Update round trip, 3 concurrent editors | **p50 21 ms, p95 41 ms, max 61 ms** | p95 < 500 ms | **PASS** |
| Relay correctness, 3 editors | **60/60 delivered, 0 lost, converged** | 0 lost | **PASS** |
| Client heap holding 5 000 rows | **10.9 MiB used / 17.8 MiB total** (4.6 MiB of row data) | no numeric target | see below |
| Seeding throughput (harness setup, no target) | 3 234 docs/s | — | — |
| PROTOCOL.md §10 conformance violations | **0** | 0 | **PASS** |

### Convergence

`npm run harness:convergence` — N simulated clients driving the real kernel over
real sockets, randomized ops, partitions and reconnects, asserting CRDT
convergence *and* materialization equality against the Wasm core.

| Run | Result |
|---|---|
| 5 clients, 25 docs, 212 ops, 9 partitions, 15 offline-queued edits | converged, 0 materialization mismatches, 11.7 s |
| 6 clients, seeds 7 / 42 / 1234, 200 ops each | converged, 0 mismatches |
| 6 clients, 700 ops, seeds 3 / 9 (seed 3 includes 2 offline-created documents) | converged, 0 mismatches, ~18 s |

Exit code 0 in every run, with no entries in the protocol-violation report.

### Client memory

10.9 MiB of JS heap for a 5 000-document workspace whose projection is 4.6 MiB of
JSON is ~2.4× the row data, and it is the *bootstrap* peak — the rows pass through
the heap on their way to IndexedDB. It is well inside a webview budget, because the
client holds the projection, not CRDT state.

The harness does not measure an Android webview and reports that measurement as
skipped. The numbers above are the desktop baseline.

## Observations

- **`ddd_rooms` reached 5 000 after seeding.** Every `create` opens a room, and
  rooms evict 10 minutes after their last subscriber, so a bulk import
  leaves one in-memory `Y.Doc` per document for that window. It is not a leak and
  it does not affect these numbers, but a 100 000-document import would need the
  eviction to be pressure-driven rather than purely time-driven.
- **Gauges are sampled, not collected on scrape.** `/metrics` gauges
  (`ddd_documents_total`, `ddd_rooms`, `ddd_feed_head_seq`, `ddd_feed_safe_seq`) refresh
  every 15 s, so a scrape taken within 15 s of boot reports the empty workspace the
  server started with. The `serverMetrics` block in the harness output is taken
  mid-run and shows exactly that; the settled values are correct on the next
  scrape. Normal for a sampled gauge against a 15–60 s Prometheus interval.
- **Idempotent seeding burns ~5 000 sequence numbers per run.** Numbers are
  allocated before the Mongo write (PROTOCOL.md §2.2 makes gaps legal), so
  `feed_head_seq` climbs faster than the document count. Harmless by design.
- **Materialization is synchronous on the write path.** The measured cost is
  `ddd_materialize_duration_seconds_sum / _count` ≈ **1.2 ms** per materialization
  and a p50 round trip of 21 ms, so moving it to the debounce worker would be an
  optimization, not a fix. It stays synchronous because `WriteOutcome` returns the materialized
  `content`/`title`/`materialized_version` that the REST routes hand straight back
  to the caller, so deferring it means returning stale values, which is a
  read-your-writes change and not a local one.
