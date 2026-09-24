/**
 * The M2 performance gate (SPEC §9 M2): **5 000 documents, 3 concurrent
 * editors — cold boot and steady-state memory measured in an Android webview on
 * mid-range hardware.**
 *
 * This entrypoint measures the parts that can be measured from a workstation:
 *   - `GET /api/sync/bootstrap` wall clock and bytes for 5 000 documents
 *     (target: < 30 s on LAN, SPEC §4.1),
 *   - a **cold client**: a fresh socket whose `since_seq = 0` is answered with
 *     `feed.reset { bootstrap_required }`, bootstraps, and re-subscribes — the
 *     real first-run path, timed end to end,
 *   - feed catch-up latency after N changes,
 *   - per-update round-trip latency with 3 concurrent editors, **and whether
 *     every update was relayed to every peer**,
 *   - client heap in headless Chromium holding the whole projection,
 *   - server-side counters scraped from `/metrics`.
 *
 * **Deferred, on purpose:** the Android-webview numbers. Those are a hardware
 * measurement on mid-range hardware and belong to M5 (SPEC §9 M5 acceptance);
 * this harness prints the desktop-Chromium numbers the device run is compared
 * against. `--seed-only` stops after seeding.
 *
 * ```bash
 * mise run dev            # server + mongo
 * mise run web            # vite on :5173 (only needed for the memory number)
 * npm run harness:perf
 * ```
 */

import { harnessCore } from "./core.js";
import { protocolViolations, recordProtocolViolation, RestClient } from "./rest.js";
import {
  assertConvergence,
  ensureDocuments,
  extraFlag,
  lastDetail,
  parseArgs,
  rng,
  spawnClients,
  type HarnessConfig,
} from "./scenario.js";
import { HarnessClient, sleep } from "./sim-client.js";

export interface PerfReport {
  readonly documents: number;
  readonly bootstrap: { readonly ms: number; readonly bytes: number; readonly pages: number };
  readonly feedCatchupMs: number;
  readonly updateRoundTripMs: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly serverMetrics: Readonly<Record<string, number>>;
  /**
   * Cold start through the real client path: connect → `feed.reset` →
   * bootstrap → re-subscribe → `complete: true`. **Optional addition** to the
   * frozen shape (see the note in `web/CONTRACTS.md` area web-harness).
   */
  readonly coldBoot?: { readonly ms: number; readonly rows: number };
  /** Relay accounting for the 3-concurrent-editor phase. Optional addition. */
  readonly relay?: {
    readonly sent: number;
    readonly delivered: number;
    readonly lost: number;
    readonly converged: boolean;
  };
  /** Headless-Chromium client memory, or why it was skipped. Optional addition. */
  readonly clientMemory?: ClientMemoryReport;
}

export interface ClientMemoryReport {
  readonly measured: boolean;
  readonly skippedBecause?: string;
  /** Rows the page fetched and retained. */
  readonly rows?: number;
  /** In-page bootstrap wall clock (fetch + parse + IndexedDB write). */
  readonly bootstrapMs?: number;
  /** `Performance.getMetrics` (CDP) after the projection is held. */
  readonly jsHeapUsedBytes?: number;
  readonly jsHeapTotalBytes?: number;
  /** `performance.memory.usedJSHeapSize` — quantized, reported for comparability. */
  readonly performanceMemoryUsedBytes?: number;
  readonly documentsBytes?: number;
  readonly idbWriteMs?: number;
}

/** Targets from the SPEC, checked and printed rather than silently assumed. */
export const TARGETS = {
  bootstrapMs: 30_000,
  updateRoundTripP95Ms: 500,
} as const;

/** Create `config.documents` documents (idempotent by deterministic ULID seed). */
export async function seedWorkspace(config: HarnessConfig): Promise<string[]> {
  const rest = new RestClient(config.baseUrl, await tokenFor(config));
  const started = Date.now();
  const ids = await ensureDocuments(rest, config.documents, {
    salt: 0,
    concurrency: Number(extraFlag(config, "concurrency") ?? 16),
    onProgress: (done) => {
      const rate = done / Math.max(0.001, (Date.now() - started) / 1000);
      process.stderr.write(`\rseeded ${done}/${config.documents} (${rate.toFixed(0)}/s)`);
    },
  });
  process.stderr.write(`\rseeded ${ids.length}/${config.documents} documents in ${Date.now() - started} ms\n`);
  return ids;
}

let cachedToken: string | undefined;

async function tokenFor(config: HarnessConfig): Promise<string> {
  if (cachedToken) return cachedToken;
  const { authenticate } = await import("./rest.js");
  cachedToken = await authenticate(config.baseUrl, config.email, config.password);
  return cachedToken;
}

export async function run(config: HarnessConfig): Promise<PerfReport> {
  await harnessCore(); // fail fast if the client core is not built
  const ids = await seedWorkspace(config);
  const token = await tokenFor(config);
  const rest = new RestClient(config.baseUrl, token);

  // 1. Bootstrap as the server can serve it (the "< 30 s on LAN" target).
  const bootstrap = await rest.bootstrap({ limit: Number(extraFlag(config, "page") ?? 200) });
  console.error(
    `bootstrap: ${bootstrap.rows} rows, ${bootstrap.pages} pages, ` +
      `${(bootstrap.bytes / 1024 / 1024).toFixed(1)} MiB in ${bootstrap.ms} ms`,
  );

  // 2. A cold client through the real path: since_seq 0 → feed.reset → bootstrap
  //    → re-subscribe → complete.
  const cold = new HarnessClient({ name: "cold", token, baseUrl: config.baseUrl });
  const coldStarted = performance.now();
  await cold.connect();
  await waitFor(() => cold.feedComplete, 120_000, "cold client never reached feed `complete: true`");
  const coldBoot = { ms: Math.round(performance.now() - coldStarted), rows: cold.projection.size };
  console.error(`cold client: ${coldBoot.rows} projection rows in ${coldBoot.ms} ms`);

  // 3. Feed catch-up after N changes, measured by a client resuming from a
  //    watermark it held before the changes.
  const changes = Number(extraFlag(config, "changes") ?? 25);
  const resumeFrom = cold.safeSeq;
  const random = rng(config.seed);
  const touched = new Set<string>();
  while (touched.size < Math.min(changes, ids.length)) {
    const id = ids[Math.floor(random() * ids.length)] as string;
    if (touched.has(id)) continue;
    touched.add(id);
    const view = await rest.getDocument(id);
    await rest.replaceDocument(id, `${view.content}\ncatchup ${touched.size}\n`);
  }
  // Materialization is debounced (~500 ms) and the *feed row* is rewritten with it
  // (SPEC §3.5), so the changes are not in the feed the instant `PUT` returns. Wait
  // for the watermark to settle first; otherwise "catch-up" measures a client that
  // had nothing to catch up on, which is how a meaningless zero gets reported.
  let settledAt = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const probe = await rest.probeBootstrap();
    if (probe.safe_seq === settledAt && probe.safe_seq > resumeFrom) break;
    settledAt = probe.safe_seq;
    await sleep(250);
  }

  const resumer = new HarnessClient({ name: "resume", token, baseUrl: config.baseUrl });
  resumer.safeSeq = resumeFrom;
  const catchupStarted = performance.now();
  await resumer.connect();
  const caughtUp = await settle(
    () =>
      resumer.feedComplete &&
      [...touched].every((id) => (resumer.projection.get(id)?.seq ?? 0) > resumeFrom),
    Number(extraFlag(config, "catchupTimeoutMs") ?? 20_000),
  );
  // A feed that never delivers the changes is a failure, not a slow number — but it
  // must not cost the rest of the report, so it is recorded and the run continues.
  const feedCatchupMs = caughtUp ? Math.round(performance.now() - catchupStarted) : -1;
  if (!caughtUp) {
    const missing = [...touched].filter((id) => (resumer.projection.get(id)?.seq ?? 0) <= resumeFrom);
    recordProtocolViolation(
      "feed catch-up",
      `a client resuming at safe_seq ${resumeFrom} never received rows for ${missing.length}/${touched.size} ` +
        "documents changed after that watermark (PROTOCOL.md §2.2, SPEC §4.1)",
    );
  }
  console.error(
    `feed catch-up after ${touched.size} changed documents: ` +
      (caughtUp ? `${feedCatchupMs} ms` : "NEVER CAUGHT UP") +
      ` (${resumer.stats.feedRows} rows from seq ${resumeFrom})`,
  );
  await resumer.close();

  // 4. Steady state: 3 concurrent editors on one document, every update checked
  //    for relay to every peer.
  const editors = (await spawnClients({
    ...config,
    clients: config.chaos.concurrentEditors,
  })) as HarnessClient[];
  const target = ids[0] as string;
  let delivered = 0;
  let lost = 0;
  const samples: number[] = [];
  try {
    await Promise.all(editors.map((editor) => editor.open(target)));
    const rounds = Number(extraFlag(config, "rounds") ?? 60);
    for (let index = 0; index < rounds; index += 1) {
      const editor = editors[index % editors.length] as HarnessClient;
      const peers = editors.filter((candidate) => candidate !== editor);
      const record = editor.editSync(target, random, "body-marker");
      const marker = record.marker;
      if (!marker) continue;
      const started = performance.now();
      const seen = await settle(
        () => peers.every((peer) => (peer.textOf(target) ?? "").includes(marker)),
        5_000,
      );
      const elapsed = performance.now() - started;
      if (seen) {
        delivered += 1;
        samples.push(elapsed);
      } else {
        lost += 1;
        console.error(`relay lost: ${marker} did not reach every peer within 5 s`);
      }
    }

    const convergence = await assertConvergence(editors, [target], config);
    const converged = convergence.divergent.length === 0 && convergence.materializationMismatches.length === 0;
    if (!converged) {
      console.error("steady-state document did not converge:", JSON.stringify(lastDetail?.verdicts, null, 2));
    }

    const serverMetrics = await rest.metrics();
    const clientMemory = await measureClientMemory(config, token);

    return {
      documents: ids.length,
      bootstrap: { ms: bootstrap.ms, bytes: bootstrap.bytes, pages: bootstrap.pages },
      feedCatchupMs,
      updateRoundTripMs: {
        p50: Math.round(percentile(samples, 0.5)),
        p95: Math.round(percentile(samples, 0.95)),
        max: Math.round(samples.length > 0 ? Math.max(...samples) : 0),
      },
      serverMetrics,
      coldBoot,
      relay: { sent: delivered + lost, delivered, lost, converged },
      clientMemory,
    };
  } finally {
    await cold.close();
    await Promise.all(editors.map((editor) => editor.close()));
  }
}

// ---------------------------------------------------------------------------
// Client memory (headless Chromium)
// ---------------------------------------------------------------------------

/**
 * Hold the whole projection in a real browser and report the heap.
 *
 * It runs against the Vite dev origin (`LM_WEB`, default `http://127.0.0.1:5173`)
 * because that origin proxies `/api` — so the fetch is same-origin, the `Origin`
 * allowlist behaves as in production, and IndexedDB is available. Rows are held in
 * a `Map` *and* written to one IndexedDB store, which is the shape SPEC §4.1
 * prescribes for the client mirror.
 *
 * Skipped (never faked) when the dev server or the Chromium download is missing.
 */
export async function measureClientMemory(
  config: HarnessConfig,
  token: string,
): Promise<ClientMemoryReport> {
  const webUrl = extraFlag(config, "web") ?? process.env.LM_WEB ?? "http://127.0.0.1:5173";
  try {
    const probe = await fetch(webUrl, { method: "GET" });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    await probe.text();
  } catch (error) {
    return {
      measured: false,
      skippedBecause: `no web origin at ${webUrl} (${String(error)}) — start it with \`mise run web\``,
    };
  }

  let browser: Awaited<ReturnType<(typeof import("@playwright/test"))["chromium"]["launch"]>> | undefined;
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");

    const inPage = await page.evaluate(
      async ({ bearer, limit }) => {
        const rows = new Map<string, unknown>();
        let bytes = 0;
        const started = performance.now();
        let cursor: string | null = null;

        for (;;) {
          const query = new URLSearchParams({ limit: String(limit), trash: "all" });
          if (cursor) query.set("cursor", cursor);
          const response = await fetch(`/api/sync/bootstrap?${query.toString()}`, {
            headers: { authorization: `Bearer ${bearer}` },
          });
          if (!response.ok) throw new Error(`bootstrap page failed: HTTP ${response.status}`);
          const text = await response.text();
          bytes += text.length;
          let footer: { next_cursor: string | null; complete: boolean } | undefined;
          for (const line of text.split("\n")) {
            if (line.trim() === "") continue;
            const parsed = JSON.parse(line) as Record<string, unknown> & { type: string };
            if (parsed.type === "row") rows.set(parsed.id as string, parsed);
            else if (parsed.type === "footer") {
              footer = parsed as unknown as { next_cursor: string | null; complete: boolean };
            }
          }
          if (!footer) throw new Error("bootstrap page had no footer");
          if (footer.complete) break;
          cursor = footer.next_cursor;
        }
        const bootstrapMs = performance.now() - started;

        // One IndexedDB store for the whole workspace (SPEC §4.1).
        const idbStarted = performance.now();
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("life-manager-harness-memory", 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (db.objectStoreNames.contains("projection")) db.deleteObjectStore("projection");
            db.createObjectStore("projection", { keyPath: "id" });
          };
          request.onerror = () => reject(request.error ?? new Error("indexedDB.open failed"));
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("projection", "readwrite");
            const store = tx.objectStore("projection");
            for (const row of rows.values()) store.put(row);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error ?? new Error("projection transaction failed"));
          };
        });
        const idbWriteMs = performance.now() - idbStarted;

        (globalThis as unknown as { __harnessRows?: unknown }).__harnessRows = rows;
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return {
          rows: rows.size,
          bytes,
          bootstrapMs,
          idbWriteMs,
          performanceMemoryUsedBytes: memory?.usedJSHeapSize,
        };
      },
      { bearer: token, limit: 200 },
    );

    const metrics = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    const byName = new Map(metrics.metrics.map((metric) => [metric.name, metric.value]));

    return {
      measured: true,
      rows: inPage.rows,
      bootstrapMs: Math.round(inPage.bootstrapMs),
      idbWriteMs: Math.round(inPage.idbWriteMs),
      documentsBytes: inPage.bytes,
      jsHeapUsedBytes: byName.get("JSHeapUsedSize"),
      jsHeapTotalBytes: byName.get("JSHeapTotalSize"),
      performanceMemoryUsedBytes: inPage.performanceMemoryUsedBytes,
    };
  } catch (error) {
    return {
      measured: false,
      skippedBecause: `headless Chromium unavailable or failed (${String(error)}) — \`npx playwright install chromium\``,
    };
  } finally {
    await browser?.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  if (!(await settle(predicate, timeoutMs))) throw new Error(message);
}

async function settle(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/** Print the numbers against their targets — the point of the exercise. */
export function printReport(report: PerfReport): void {
  const verdict = (ok: boolean): string => (ok ? "PASS" : "MISS");
  const lines = [
    "",
    `documents                 ${report.documents}`,
    `bootstrap (REST, server)  ${report.bootstrap.ms} ms, ${(report.bootstrap.bytes / 1048576).toFixed(1)} MiB, ` +
      `${report.bootstrap.pages} pages  [target < ${TARGETS.bootstrapMs} ms: ${verdict(report.bootstrap.ms < TARGETS.bootstrapMs)}]`,
    `cold client (real path)   ${report.coldBoot?.ms ?? "-"} ms for ${report.coldBoot?.rows ?? "-"} rows  ` +
      `[target < ${TARGETS.bootstrapMs} ms: ${verdict((report.coldBoot?.ms ?? Infinity) < TARGETS.bootstrapMs)}]`,
    `feed catch-up             ${report.feedCatchupMs} ms`,
    `update round trip         p50 ${report.updateRoundTripMs.p50} ms, p95 ${report.updateRoundTripMs.p95} ms, ` +
      `max ${report.updateRoundTripMs.max} ms  [p95 < ${TARGETS.updateRoundTripP95Ms} ms: ${verdict(report.updateRoundTripMs.p95 < TARGETS.updateRoundTripP95Ms)}]`,
    `relay (3 editors)         ${report.relay?.delivered ?? 0}/${report.relay?.sent ?? 0} delivered, ` +
      `${report.relay?.lost ?? 0} lost, converged=${report.relay?.converged ?? false}  ` +
      `[target 0 lost: ${verdict((report.relay?.lost ?? 1) === 0 && (report.relay?.converged ?? false))}]`,
    report.clientMemory?.measured
      ? `client heap (chromium)   ${fmtMiB(report.clientMemory.jsHeapUsedBytes)} used / ` +
        `${fmtMiB(report.clientMemory.jsHeapTotalBytes)} total holding ${report.clientMemory.rows} rows ` +
        `(in-page bootstrap ${report.clientMemory.bootstrapMs} ms, IndexedDB write ${report.clientMemory.idbWriteMs} ms)`
      : `client heap (chromium)   skipped — ${report.clientMemory?.skippedBecause ?? "not attempted"}`,
    "",
    "Android webview (mid-range hardware) is the other half of the SPEC §9 M2 gate and is",
    "a device measurement: deferred to M5 hardware, compared against the numbers above.",
    "",
  ];
  console.error(lines.join("\n"));
}

function fmtMiB(bytes: number | undefined): string {
  return bytes === undefined ? "-" : `${(bytes / 1048576).toFixed(1)} MiB`;
}

async function main(): Promise<void> {
  // 5 000 documents is the gate (SPEC §9 M2), so that — not `DEFAULT_CONFIG`'s 25 —
  // is the default here. `--documents=` still wins; `extraFlag` cannot tell a flag
  // from a default, so the flag is looked for where it actually is.
  const parsed = parseArgs();
  const documentsGiven = process.argv.some((arg) => arg.startsWith("--documents="));
  const config: HarnessConfig = { ...parsed, documents: documentsGiven ? parsed.documents : 5_000 };
  if (process.argv.includes("--seed-only")) {
    const ids = await seedWorkspace(config);
    console.log(JSON.stringify({ seeded: ids.length }, null, 2));
    return;
  }
  const report = await run(config);
  printReport(report);
  const violations = protocolViolations();
  if (violations.length > 0) {
    console.error("protocol violations (PROTOCOL.md §10 conformance checklist):");
    for (const violation of violations) {
      const times = violation.repeats > 1 ? ` (×${violation.repeats})` : "";
      console.error(
        `  ${violation.contractual ? "FAIL" : "warn"} ${violation.where}${times}: ${violation.detail}`,
      );
    }
    if (violations.some((violation) => violation.contractual)) process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
  // Relay loss and divergence are correctness failures, not slow numbers.
  if ((report.relay?.lost ?? 0) > 0 || report.relay?.converged === false) process.exitCode = 1;
  if (process.argv.includes("--strict")) {
    if (report.bootstrap.ms >= TARGETS.bootstrapMs) process.exitCode = 1;
    if (report.updateRoundTripMs.p95 >= TARGETS.updateRoundTripP95Ms) process.exitCode = 1;
  }
}

// See the note in `convergence.ts`: under `vite-node` the script path is not in
// `process.argv`, so an `argv[1]`-based guard never fires.
if (!process.env.VITEST && !process.env.LM_HARNESS_NO_AUTORUN) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      // Undici sockets and Chromium pipes can outlive the work; do not hang CI.
      setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
    });
}
