/**
 * The convergence harness (SPEC §9 M2): N simulated clients, randomized
 * operations, partitions and reconnects → **convergence** of every replica and
 * **materialization equality** with the server.
 *
 * ```bash
 * mise run dev                       # server + mongo
 * npm run harness:convergence -- --clients=5 --documents=25 --operations=200 --seed=7
 * ```
 *
 * Exit code 0 only when `divergent` and `materializationMismatches` are both
 * empty. CI runs it (SPEC §8).
 *
 * **What the run loop does, and why each part is there:**
 *
 * | Ingredient | What it is for |
 * |---|---|
 * | randomized text ops (body, frontmatter splices, `%%%` line splices) | the three regions of SPEC §3.1 merge under concurrency |
 * | overlapping editor sets | genuinely concurrent edits to the same document |
 * | socket drops with a pause | partitions; edits keep landing in the local replica |
 * | offline queues | edits made while partitioned must survive the reconnect |
 * | offline document creation | client-minted ULIDs (SPEC §3.5) reaching the server late |
 * | one seeded RNG for every decision | `--seed=N` replays the whole script |
 *
 * Network interleaving is real time and therefore not byte-reproducible; the
 * *operation script* is. `--journal=<path>` writes every decision with its op
 * index, which is what a post-mortem actually needs.
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harnessCore, ulidForIndex } from "./core.js";
import { seedDocumentText, type OpRecord } from "./ops.js";
import { protocolViolations, RestClient } from "./rest.js";
import {
  assertConvergence,
  assertFeedFreshness,
  ensureDocuments,
  extraFlag,
  lastDetail,
  parseArgs,
  rng,
  spawnClients,
  type ConvergenceReport,
  type HarnessConfig,
} from "./scenario.js";
import { HarnessClient, sleep } from "./sim-client.js";

/**
 * Documents whose feed-delivered projection row never caught up (see
 * {@link assertFeedFreshness}). Kept module-level so `main` can fail the run on it
 * without changing the frozen {@link ConvergenceReport} shape.
 */
let staleFeedDocuments: readonly string[] = [];

interface JournalEntry {
  readonly op: number;
  readonly client: string;
  readonly action: "edit" | "drop" | "reconnect" | "create-offline" | "skip";
  readonly documentId?: string;
  readonly detail?: string;
}

export async function run(config: HarnessConfig): Promise<ConvergenceReport> {
  const random = rng(config.seed);
  const started = Date.now();
  const journal: JournalEntry[] = [];

  // Load the core before touching the network: a missing Wasm build should fail
  // in the first second, not after 200 operations.
  const core = await harnessCore();

  const clients = (await spawnClients(config)) as HarnessClient[];
  const rest = new RestClient(config.baseUrl, clients[0]?.token);

  try {
    const semantics = clients[0]?.welcome?.core_semantics_version;
    if (semantics !== undefined && semantics !== core.semanticsVersion()) {
      console.warn(
        `core_semantics_version mismatch: server ${semantics}, harness Wasm core ${core.semanticsVersion()} — ` +
          "the materialization assertion is comparing two different parsers (PROTOCOL.md §1.4)",
      );
    }

    // `reset: true` — the ids are deterministic, so a second run with the same seed
    // edits the same documents; starting each run from the seed text is what makes
    // the run's assertions about its own text meaningful.
    const ids = await ensureDocuments(rest, config.documents, { salt: config.seed, reset: true });
    const createdOffline: string[] = [];

    // Overlapping editor sets: every client opens a deterministic majority of the
    // workspace, so most documents have several concurrent writers.
    const openedBy = new Map<string, string[]>();
    for (const client of clients) {
      const opened: string[] = [];
      for (const id of ids) {
        if (random() < 0.7 || ids.length <= 3) {
          await client.open(id);
          opened.push(id);
        }
      }
      if (opened.length === 0 && ids[0]) {
        await client.open(ids[0]);
        opened.push(ids[0]);
      }
      openedBy.set(client.name, opened);
    }

    /** Op index at which a partitioned client comes back. */
    const offlineUntil = new Map<string, number>();

    for (let op = 0; op < config.operations; op += 1) {
      const client = clients[Math.floor(random() * clients.length)] as HarnessClient;
      const opened = openedBy.get(client.name) ?? [];
      const id = opened[Math.floor(random() * opened.length)];

      // Reconnect anything whose pause has expired, before this op runs.
      for (const [name, until] of [...offlineUntil]) {
        if (op < until) continue;
        offlineUntil.delete(name);
        const peer = clients.find((candidate) => candidate.name === name);
        if (!peer || peer.connected) continue;
        await peer.connect();
        const flushed = await peer.flushPendingCreates();
        journal.push({ op, client: name, action: "reconnect", detail: `flushed ${flushed.length} create(s)` });
      }

      if (random() < config.chaos.dropSocket && client.connected) {
        // A partition: the socket goes, the replica stays, and edits keep landing
        // locally — that is the offline queue (SPEC §4.1).
        client.disconnect();
        const [low, high] = config.chaos.pauseMs;
        const pause = low + Math.floor(random() * Math.max(1, high - low));
        const resumeAt = op + 1 + Math.floor(random() * 6);
        offlineUntil.set(client.name, resumeAt);
        journal.push({ op, client: client.name, action: "drop", detail: `pause ${pause} ms, resume at op ${resumeAt}` });
        await sleep(pause);
        continue;
      }

      // Rarely: mint a document offline. The id is the client's (SPEC §3.5) and
      // the server only learns about it on reconnect.
      if (!client.connected && random() < 0.08 && createdOffline.length < 8) {
        const newId = ulidForIndex(1_000 + createdOffline.length, config.seed);
        client.createOffline(newId, seedDocumentText(900 + createdOffline.length, random));
        createdOffline.push(newId);
        openedBy.get(client.name)?.push(newId);
        journal.push({ op, client: client.name, action: "create-offline", documentId: newId });
        continue;
      }

      if (!id) {
        journal.push({ op, client: client.name, action: "skip", detail: "no open document" });
        continue;
      }

      const record: OpRecord = client.editSync(id, random);
      journal.push({
        op,
        client: client.name,
        action: "edit",
        documentId: id,
        detail: `${record.kind}${record.applied ? "" : " (no-op)"}: ${record.detail}`,
      });

      // Cross the materialization debounce and the live-tail coalescing window
      // every so often, so the run exercises settled state as well as bursts.
      if (op % 25 === 24) await sleep(120);
    }

    // Everyone back online, every pending create flushed, then assert.
    for (const client of clients) {
      if (!client.connected) await client.connect();
      await client.flushPendingCreates();
    }
    await sleep(300);

    const allIds = [...ids, ...createdOffline];
    const report = await assertConvergence(clients, allIds, config);
    const freshness = await assertFeedFreshness(clients, allIds, config);
    staleFeedDocuments = freshness.stale;

    printDetail(config, clients, journal.length, createdOffline.length);
    printProtocolViolations();
    if (freshness.stale.length > 0) {
      console.error(
        `\nFAIL change feed: ${freshness.stale.length}/${freshness.checked} documents never reached the ` +
          "clients' projection mirrors (SPEC §4.1 — the projection replicates over the feed). " +
          `First: ${freshness.stale.slice(0, 5).join(", ")}`,
      );
    }

    const journalPath = extraFlag(config, "journal");
    const failed =
      report.divergent.length > 0 ||
      report.materializationMismatches.length > 0 ||
      freshness.stale.length > 0;
    if (journalPath || failed) {
      // Default to the temp dir: a failing CI run should leave a file behind, not a
      // stray artifact in the repo. `--journal=<path>` puts it wherever you want.
      const path = journalPath ?? join(tmpdir(), `ddd-convergence-seed${config.seed}.json`);
      await writeFile(
        path,
        JSON.stringify(
          { config, journal, detail: lastDetail, report, staleFeedDocuments: freshness.stale },
          null,
          2,
        ),
        "utf8",
      );
      console.error(`journal written to ${path} — replay with --seed=${config.seed}`);
    }

    return { ...report, durationMs: Date.now() - started };
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
}

function printDetail(
  config: HarnessConfig,
  clients: readonly HarnessClient[],
  ops: number,
  createdOffline: number,
): void {
  const detail = lastDetail;
  console.error(
    `\nconvergence: ${clients.length} clients, ${ops} scripted ops, ` +
      `${createdOffline} offline-created document(s), seed ${config.seed}`,
  );
  for (const client of clients) {
    const stats = client.stats;
    console.error(
      `  ${client.name}: sent ${stats.updatesSent} / recv ${stats.updatesReceived} updates, ` +
        `${stats.offlineUpdates} queued offline, ${stats.connects} connects, ` +
        `closes [${stats.closes.map((close) => close.code).join(",")}], ` +
        `feed rows ${stats.feedRows} (safe_seq ${client.safeSeq}), ` +
        `resets ${stats.feedResets}, resyncs ${stats.feedResyncs}/${stats.docResyncs}` +
        (stats.errors.length > 0 ? `, errors: ${stats.errors.slice(0, 3).join(" | ")}` : ""),
    );
  }
  for (const verdict of detail?.verdicts ?? []) {
    if (verdict.converged && verdict.materializationEqual && verdict.notes.length === 0) continue;
    console.error(
      `  ${verdict.id}: converged=${verdict.converged} materialized=${verdict.materializationEqual} ` +
        `(${verdict.textLength} chars)`,
    );
    for (const note of verdict.notes) console.error(`      ${note}`);
  }
}

/**
 * Report every protocol violation the run noticed in passing (PROTOCOL.md §10).
 * Violations on the document/feed/bootstrap surfaces fail the run; anywhere else
 * they are printed, because an auth-route timestamp bug must not stop the
 * convergence gate from running.
 */
function printProtocolViolations(): boolean {
  const violations = protocolViolations();
  if (violations.length === 0) return false;
  console.error("\nprotocol violations (PROTOCOL.md §10 conformance checklist):");
  for (const violation of violations) {
    const times = violation.repeats > 1 ? ` (×${violation.repeats})` : "";
    console.error(
      `  ${violation.contractual ? "FAIL" : "warn"} ${violation.where}${times}: ${violation.detail}`,
    );
  }
  return violations.some((violation) => violation.contractual);
}

async function main(): Promise<void> {
  const config = parseArgs();
  const report = await run(config);
  console.log(JSON.stringify(report, null, 2));
  const failed =
    report.divergent.length > 0 ||
    report.materializationMismatches.length > 0 ||
    staleFeedDocuments.length > 0 ||
    protocolViolations().some((violation) => violation.contractual);
  process.exitCode = failed ? 1 : 0;
}

/**
 * Entry detection, the version that actually works: under `vite-node` the script
 * path never reaches `process.argv` (argv[1] is the `vite-node` bin), so the
 * scaffold's `argv[1].endsWith("convergence.ts")` guard silently ran nothing and
 * exited 0 — a green gate that tested absolutely nothing. This module exists to be
 * executed; it runs unless a test runner imported it, and `DDD_HARNESS_NO_AUTORUN=1`
 * suppresses it for anything else that needs to import `run`.
 */
if (!process.env.VITEST && !process.env.DDD_HARNESS_NO_AUTORUN) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      // Undici keeps sockets alive briefly; a gate that hangs is a gate nobody runs.
      setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
    });
}

export { assertConvergence };
