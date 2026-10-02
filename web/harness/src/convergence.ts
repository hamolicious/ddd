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

    const ids = await ensureDocuments(rest, config.documents, { salt: config.seed, reset: true });
    const createdOffline: string[] = [];

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

    const offlineUntil = new Map<string, number>();

    for (let op = 0; op < config.operations; op += 1) {
      const client = clients[Math.floor(random() * clients.length)] as HarnessClient;
      const opened = openedBy.get(client.name) ?? [];
      const id = opened[Math.floor(random() * opened.length)];

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
        client.disconnect();
        const [low, high] = config.chaos.pauseMs;
        const pause = low + Math.floor(random() * Math.max(1, high - low));
        const resumeAt = op + 1 + Math.floor(random() * 6);
        offlineUntil.set(client.name, resumeAt);
        journal.push({ op, client: client.name, action: "drop", detail: `pause ${pause} ms, resume at op ${resumeAt}` });
        await sleep(pause);
        continue;
      }

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

      if (op % 25 === 24) await sleep(120);
    }

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

if (!process.env.VITEST && !process.env.DDD_HARNESS_NO_AUTORUN) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
    });
}

export { assertConvergence };
