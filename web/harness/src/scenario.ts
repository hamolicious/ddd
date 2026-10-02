import type * as Y from "yjs";

import { deepEqual, harnessCore, ulidForIndex } from "./core.js";
import { markersIn, seedDocumentText } from "./ops.js";
import { authenticate, RestClient, type DocumentView } from "./rest.js";
import { HarnessClient, sleep } from "./sim-client.js";

export interface HarnessConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly clients: number;
  readonly documents: number;
  readonly operations: number;
  readonly seed: number;
  readonly chaos: {
    readonly dropSocket: number;
    readonly pauseMs: [number, number];
    readonly concurrentEditors: number;
  };
}

export const DEFAULT_CONFIG: HarnessConfig = {
  baseUrl: process.env.DDD_SERVER ?? "http://127.0.0.1:8080",
  email: process.env.DDD_EMAIL ?? "harness@example.com",
  password: process.env.DDD_PASSWORD ?? "harness-password-1",
  clients: 5,
  documents: 25,
  operations: 200,
  seed: 1,
  chaos: { dropSocket: 0.05, pauseMs: [10, 400], concurrentEditors: 3 },
};

export interface SimulatedClient {
  readonly name: string;
  readonly token: string;
  connect(): Promise<void>;
  disconnect(code?: number): void;
  open(id: string): Promise<Y.Text>;
  edit(id: string, rng: () => number): Promise<void>;
  awaitConvergence(id: string, timeoutMs: number): Promise<void>;
  textOf(id: string): string | undefined;
  close(): Promise<void>;
}

export interface ConvergenceReport {
  readonly documents: number;
  readonly clients: number;
  readonly operations: number;
  readonly durationMs: number;
  readonly divergent: readonly string[];
  readonly materializationMismatches: readonly string[];
}

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

export function parseArgs(argv: readonly string[] = process.argv.slice(2)): HarnessConfig {
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match as unknown as [string, string, string];
    const field = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const parsed = /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    if (field === "dropSocket" || field === "concurrentEditors") {
      config["chaos"] = { ...(config["chaos"] as HarnessConfig["chaos"]), [field]: parsed };
      continue;
    }
    config[field] = parsed;
  }
  return config as unknown as HarnessConfig;
}

export function extraFlag(config: HarnessConfig, name: string): string | undefined {
  const value = (config as unknown as Record<string, unknown>)[name];
  return value === undefined ? undefined : String(value);
}

export function settleTimeoutMs(config: HarnessConfig): number {
  const flag = extraFlag(config, "settleMs");
  return flag ? Number(flag) : 45_000;
}

export function runTag(config: HarnessConfig): string {
  return extraFlag(config, "tag") ?? Date.now().toString(36).slice(-5);
}

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

export interface DocumentVerdict {
  readonly id: string;
  readonly converged: boolean;
  readonly materializationEqual: boolean;
  readonly textLength: number;
  readonly lostMarkers: readonly string[];
  readonly duplicatedMarkers: readonly string[];
  readonly notes: readonly string[];
}

export interface ConvergenceDetail {
  readonly verdicts: readonly DocumentVerdict[];
  readonly coreSemanticsVersion: number;
  readonly serverSemanticsVersion: number | undefined;
}

export let lastDetail: ConvergenceDetail | undefined;

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

async function flushedView(rest: RestClient, id: string): Promise<DocumentView> {
  const first = await rest.getDocument(id);
  await sleep(50);
  const second = await rest.getDocument(id);
  return second.materialized_version === first.materialized_version ? first : second;
}

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

export function cheapHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
