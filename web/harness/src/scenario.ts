/**
 * Shared harness plumbing: simulated clients, randomized operation scripts, and
 * the two assertions that matter (SPEC §9 M2).
 *
 * The harness runs in Node against a real server + Mongo (`mise run dev`), driving
 * the *real* kernel code over a real WebSocket — a fake transport would prove
 * nothing about convergence.
 *
 * **FROZEN INTERFACE.**
 */

import type * as Y from "yjs";

import { deepEqual, harnessCore, ulidForIndex } from "./core.js";
import { markersIn, seedDocumentText } from "./ops.js";
import { authenticate, RestClient, type DocumentView } from "./rest.js";
import { HarnessClient, sleep } from "./sim-client.js";

export interface HarnessConfig {
  /** Base URL of the server under test. */
  readonly baseUrl: string;
  /** Credentials: the harness registers/logs in and uses bearer tokens. */
  readonly email: string;
  readonly password: string;
  /** Number of simulated clients. */
  readonly clients: number;
  /** Documents in the workspace (created if missing). */
  readonly documents: number;
  /** Operations each client performs. */
  readonly operations: number;
  /** Deterministic seed — a failing run must be replayable. */
  readonly seed: number;
  /** Probability per operation of a partition (socket drop) or reconnect. */
  readonly chaos: {
    readonly dropSocket: number;
    readonly pauseMs: [number, number];
    readonly concurrentEditors: number;
  };
}

export const DEFAULT_CONFIG: HarnessConfig = {
  baseUrl: process.env.LM_SERVER ?? "http://127.0.0.1:8080",
  email: process.env.LM_EMAIL ?? "harness@example.com",
  password: process.env.LM_PASSWORD ?? "harness-password-1",
  clients: 5,
  documents: 25,
  operations: 200,
  seed: 1,
  chaos: { dropSocket: 0.05, pauseMs: [10, 400], concurrentEditors: 3 },
};

/** A simulated client: a bearer session, a kernel `SyncClient`, and its replicas. */
export interface SimulatedClient {
  readonly name: string;
  readonly token: string;
  connect(): Promise<void>;
  disconnect(code?: number): void;
  open(id: string): Promise<Y.Text>;
  /** Apply one randomized text operation to an open document. */
  edit(id: string, rng: () => number): Promise<void>;
  /** Wait until this client's replica of `id` matches `stateVector`. */
  awaitConvergence(id: string, timeoutMs: number): Promise<void>;
  /** Text of a local replica, for the equality assertions. */
  textOf(id: string): string | undefined;
  close(): Promise<void>;
}

export interface ConvergenceReport {
  readonly documents: number;
  readonly clients: number;
  readonly operations: number;
  readonly durationMs: number;
  /** Documents where replicas disagreed — must be empty. */
  readonly divergent: readonly string[];
  /**
   * Documents where the server's materialized `title`/`fm`/`plugins` disagreed
   * with the Wasm core's parse of the converged text — must be empty
   * (SPEC §9 M2: "convergence + materialization equality").
   */
  readonly materializationMismatches: readonly string[];
}

/** Deterministic PRNG (mulberry32) — same seed, same run. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Parse `--clients=4 --seed=7` style flags over {@link DEFAULT_CONFIG}. */
export function parseArgs(argv: readonly string[] = process.argv.slice(2)): HarnessConfig {
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match as unknown as [string, string, string];
    const field = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const parsed = /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    // The chaos knobs live one level down; a top-level flag for them was silently ignored.
    if (field === "dropSocket" || field === "concurrentEditors") {
      config["chaos"] = { ...(config["chaos"] as HarnessConfig["chaos"]), [field]: parsed };
      continue;
    }
    config[field] = parsed;
  }
  return config as unknown as HarnessConfig;
}

/** Flags the frozen {@link HarnessConfig} has no field for (`--web=`, `--settle=`). */
export function extraFlag(config: HarnessConfig, name: string): string | undefined {
  const value = (config as unknown as Record<string, unknown>)[name];
  return value === undefined ? undefined : String(value);
}

/** How long a document is given to settle before it counts as divergent. */
export function settleTimeoutMs(config: HarnessConfig): number {
  const flag = extraFlag(config, "settleMs");
  return flag ? Number(flag) : 45_000;
}

/**
 * A short label distinguishing this run's markers from a previous run's on the same
 * (deterministically-named) documents. `--tag=` pins it; otherwise it is the clock,
 * which is the one thing about a run that must *not* be reproducible here.
 */
export function runTag(config: HarnessConfig): string {
  return extraFlag(config, "tag") ?? Date.now().toString(36).slice(-5);
}

/**
 * Build `config.clients` simulated clients against a live server.
 * (Registers the first user if the workspace is empty — SPEC §5.1.)
 *
 * Each client gets its **own session**: the socket cap is per session (8,
 * PROTOCOL.md §1.3) and N real devices are N sessions, so sharing one token
 * would test something else. A failed extra login degrades to sharing the first
 * token rather than aborting the run.
 */
export async function spawnClients(config: HarnessConfig): Promise<SimulatedClient[]> {
  const primary = await authenticate(config.baseUrl, config.email, config.password);
  const rest = new RestClient(config.baseUrl, primary);
  const tag = runTag(config);
  const clients: HarnessClient[] = [];

  for (let index = 0; index < config.clients; index += 1) {
    let token = primary;
    if (index > 0) {
      try {
        token = await rest.login(config.email, config.password);
      } catch (error) {
        console.warn(
          `client c${index + 1}: extra login failed (${String(error)}); sharing the primary session`,
        );
      }
    }
    clients.push(
      new HarnessClient({
        name: `c${index + 1}`,
        token,
        baseUrl: config.baseUrl,
        tag,
      }),
    );
  }

  await Promise.all(clients.map((client) => client.connect()));
  return clients;
}

/**
 * Create `count` seed documents with deterministic ids (idempotent: an existing
 * id answers 409 and is reused). Returns the ids in creation order.
 *
 * `reset: true` also rewrites an existing document back to its seed text. The
 * convergence harness wants that: ids are deterministic, so consecutive runs share
 * documents, and a second run would otherwise inherit the first run's text — which
 * quietly breaks any per-run invariant about what the text should contain. The
 * rewrite goes through `PUT`, so it is one CRDT transaction with a minimal diff
 * (SPEC §5.1), not a delete and re-create: the id is never graveyarded.
 */
export async function ensureDocuments(
  rest: RestClient,
  count: number,
  options: {
    readonly salt?: number;
    readonly concurrency?: number;
    readonly reset?: boolean;
    readonly onProgress?: (done: number) => void;
  } = {},
): Promise<string[]> {
  const salt = options.salt ?? 0;
  const concurrency = options.concurrency ?? 16;
  const ids = Array.from({ length: count }, (_, index) => ulidForIndex(index, salt));
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= ids.length) return;
      const id = ids[index] as string;
      const text = seedDocumentText(index, rng(index + salt * 7919 + 1));
      const outcome = await rest.createDocument(id, text);
      if (outcome === "exists" && options.reset) await rest.replaceDocument(id, text);
      done += 1;
      if (done % 250 === 0) options.onProgress?.(done);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, count)) }, worker));
  options.onProgress?.(done);
  return ids;
}

/** Per-document detail behind a report: printed, journalled, never swallowed. */
export interface DocumentVerdict {
  readonly id: string;
  readonly converged: boolean;
  readonly materializationEqual: boolean;
  readonly textLength: number;
  /** Markers written by some client that are missing from the converged text. */
  readonly lostMarkers: readonly string[];
  /** Markers appearing more than once — a merge that duplicated an op. */
  readonly duplicatedMarkers: readonly string[];
  readonly notes: readonly string[];
}

export interface ConvergenceDetail {
  readonly verdicts: readonly DocumentVerdict[];
  readonly coreSemanticsVersion: number;
  readonly serverSemanticsVersion: number | undefined;
}

/** The detail of the most recent {@link assertConvergence} call. */
export let lastDetail: ConvergenceDetail | undefined;

/** Assert every replica of every document is identical, and matches the server. */
export async function assertConvergence(
  clients: readonly SimulatedClient[],
  documentIds: readonly string[],
  config: HarnessConfig,
): Promise<ConvergenceReport> {
  const started = Date.now();
  const core = await harnessCore();
  const timeout = settleTimeoutMs(config);
  const harnessClients = clients.filter((client): client is HarnessClient => client instanceof HarnessClient);
  const rest = new RestClient(config.baseUrl, clients[0]?.token);

  // Everyone online, everything flushed: an offline client cannot converge, and
  // a partition left open is a harness bug rather than a server failure.
  for (const client of harnessClients) {
    if (!client.connected) await client.connect();
    await client.flushPendingCreates();
  }

  const divergent: string[] = [];
  const materializationMismatches: string[] = [];
  const verdicts: DocumentVerdict[] = [];

  for (const id of documentIds) {
    const notes: string[] = [];
    const holders = clients.filter((client) => client.textOf(id) !== undefined);
    if (holders.length === 0) {
      verdicts.push({
        id,
        converged: true,
        materializationEqual: true,
        textLength: 0,
        lostMarkers: [],
        duplicatedMarkers: [],
        notes: ["no client holds a replica"],
      });
      continue;
    }

    for (const client of holders) {
      try {
        await client.awaitConvergence(id, timeout);
      } catch (error) {
        notes.push(`${client.name}: ${String(error)}`);
      }
    }

    const texts = holders.map((client) => [client.name, client.textOf(id) ?? ""] as const);
    const distinct = new Set(texts.map(([, text]) => text));
    const converged = distinct.size === 1;
    const text = texts[0]?.[1] ?? "";
    if (!converged) {
      divergent.push(id);
      for (const [name, value] of texts) notes.push(`${name}: ${value.length} chars, sha ${cheapHash(value)}`);
    }

    // No update loss across reconnects: every marker any client ever wrote must
    // appear exactly once in the converged text (see `ops.ts` for why that is a
    // sound test).
    const present = markersIn(text);
    const counts = new Map<string, number>();
    for (const marker of present) counts.set(marker, (counts.get(marker) ?? 0) + 1);
    const expected = new Set<string>();
    for (const client of harnessClients) for (const marker of client.markersOf(id)) expected.add(marker);
    const lostMarkers = [...expected].filter((marker) => (counts.get(marker) ?? 0) === 0);
    const duplicatedMarkers = [...counts].filter(([, n]) => n > 1).map(([marker]) => marker);
    if (lostMarkers.length > 0 || duplicatedMarkers.length > 0) {
      if (!divergent.includes(id)) divergent.push(id);
      if (lostMarkers.length > 0) notes.push(`lost ${lostMarkers.length} marker(s): ${lostMarkers.slice(0, 5).join(", ")}`);
      if (duplicatedMarkers.length > 0) {
        notes.push(`duplicated marker(s): ${duplicatedMarkers.slice(0, 5).join(", ")}`);
      }
    }

    // Materialization equality: the server's derived projection versus the shared
    // core's parse of the very same text (SPEC §9 M2).
    let materializationEqual = true;
    try {
      const view = await flushedView(rest, id);
      const parsed = core.parseAsMaterialized(view.content);
      if (view.content !== text) {
        materializationEqual = false;
        notes.push(
          `server content differs from the converged replicas (${view.content.length} vs ${text.length} chars) — ` +
            "materialization is debounced, but GET forces a flush (SPEC §3.5)",
        );
      }
      if (view.title !== parsed.title) {
        materializationEqual = false;
        notes.push(`title: server ${JSON.stringify(view.title)} vs core ${JSON.stringify(parsed.title)}`);
      }
      if (!deepEqual(view.fm, parsed.fm)) {
        materializationEqual = false;
        notes.push(`fm: server ${JSON.stringify(view.fm)} vs core ${JSON.stringify(parsed.fm)}`);
      }
      if (!deepEqual(view.plugins, parsed.plugins)) {
        materializationEqual = false;
        notes.push(`plugins: server ${JSON.stringify(view.plugins)} vs core ${JSON.stringify(parsed.plugins)}`);
      }
      if (view.fm_parse_error !== parsed.fm_parse_error) {
        materializationEqual = false;
        notes.push(`fm_parse_error: server ${view.fm_parse_error} vs core ${parsed.fm_parse_error}`);
      }
    } catch (error) {
      materializationEqual = false;
      notes.push(`materialization check failed: ${String(error)}`);
    }
    if (!materializationEqual) materializationMismatches.push(id);

    verdicts.push({
      id,
      converged,
      materializationEqual,
      textLength: text.length,
      lostMarkers,
      duplicatedMarkers,
      notes,
    });
  }

  lastDetail = {
    verdicts,
    coreSemanticsVersion: core.semanticsVersion(),
    serverSemanticsVersion: harnessClients[0]?.welcome?.core_semantics_version,
  };

  return {
    documents: documentIds.length,
    clients: clients.length,
    operations: config.operations,
    durationMs: Date.now() - started,
    divergent,
    materializationMismatches,
  };
}

/**
 * `GET /api/documents/:id` forces a materialization flush (read-your-writes,
 * SPEC §3.5), but the room may still be mid-debounce for an update that arrived
 * microseconds ago; one retry on a stale `materialized_version` keeps the
 * assertion about materialization *correctness* rather than about timing.
 */
async function flushedView(rest: RestClient, id: string): Promise<DocumentView> {
  const first = await rest.getDocument(id);
  await sleep(50);
  const second = await rest.getDocument(id);
  return second.materialized_version === first.materialized_version ? first : second;
}

/**
 * Does the **change feed** actually carry changes?
 *
 * Convergence and materialization equality are both provable without the feed
 * (the CRDT flows over document frames, and REST reads the projection directly),
 * so a feed that only ever announces *creations* passes both assertions while
 * leaving every client's offline mirror permanently stale — SPEC §4.1 says the
 * projection replicates over the change feed and is what makes every document
 * readable and searchable offline. This check closes that hole: for each document,
 * every client's feed-delivered row must eventually match the server's materialized
 * content.
 *
 * Returns the ids whose rows never caught up within `timeoutMs` (shared across all
 * documents, so a broken feed costs one timeout, not one per document).
 */
export async function assertFeedFreshness(
  clients: readonly SimulatedClient[],
  documentIds: readonly string[],
  config: HarnessConfig,
  timeoutMs = 8_000,
): Promise<{ stale: string[]; checked: number }> {
  const harnessClients = clients.filter(
    (client): client is HarnessClient => client instanceof HarnessClient,
  );
  const rest = new RestClient(config.baseUrl, clients[0]?.token);

  // Only documents this run actually edited, and only clients that hold a replica of
  // them: those are the clients the feed owes a row to. A *missing* row counts as
  // stale — "the feed never mentioned a document you are editing" is the same
  // failure as "the row is out of date", and the more likely one.
  const expected = new Map<string, { content: string; holders: HarnessClient[] }>();
  for (const id of documentIds) {
    const holders = harnessClients.filter((client) => client.textOf(id) !== undefined);
    if (holders.length === 0) continue;
    expected.set(id, { content: (await rest.getDocument(id)).content, holders });
  }

  const deadline = Date.now() + timeoutMs;
  const stale = new Set(expected.keys());
  while (stale.size > 0 && Date.now() < deadline) {
    for (const id of [...stale]) {
      const entry = expected.get(id);
      if (!entry) continue;
      if (entry.holders.every((client) => client.projection.get(id)?.content === entry.content)) {
        stale.delete(id);
      }
    }
    if (stale.size > 0) await sleep(200);
  }
  return { stale: [...stale], checked: expected.size };
}

/** A short, stable digest for log lines (never a correctness check). */
export function cheapHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
