import type { Language, Parser, Query } from "web-tree-sitter";

import type { SyntaxLanguage } from "./api.js";

import { captureClass } from "./captures.js";

export interface Span {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

export type LoadState = "loading" | "ready" | "failed";

export const MAX_HIGHLIGHT_LENGTH = 100_000;
const CACHE_ENTRIES = 256;

const served = import.meta.url;

export interface Engine {
  state(id: string): LoadState | undefined;
  load(language: SyntaxLanguage): Promise<void>;
  highlight(code: string, id: string): readonly Span[] | undefined;
  check(grammar: Uint8Array, highlights: string): Promise<void>;
  forget(id: string): void;
  subscribe(listener: () => void): () => void;
}

interface Loaded {
  readonly language: Language;
  readonly query: Query;
}

export interface EngineOptions {
  readonly base?: string;
  readonly fetchBytes?: (url: string) => Promise<Uint8Array>;
}

export function createEngine({ base = served, fetchBytes = defaultFetch }: EngineOptions = {}): Engine {
  let runtime: Promise<{ parser: Parser; Language: typeof Language; Query: typeof Query }> | undefined;
  const loads = new Map<string, Promise<void>>();
  const states = new Map<string, LoadState>();
  const loaded = new Map<string, Loaded>();
  const cache = new Map<string, readonly Span[]>();
  const listeners = new Set<() => void>();

  const announce = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const runtimeOf = (): NonNullable<typeof runtime> => {
    runtime ??= import("web-tree-sitter").then(async (treeSitter) => {
      await treeSitter.Parser.init({ locateFile: () => new URL("tree-sitter.wasm", base).href });
      return { parser: new treeSitter.Parser(), Language: treeSitter.Language, Query: treeSitter.Query };
    });
    runtime.catch(() => {
      runtime = undefined;
    });
    return runtime;
  };
  let current: Parser | undefined;

  return {
    state: (id) => states.get(id),

    load(language) {
      const pending = loads.get(language.id);
      if (pending && states.get(language.id) !== "failed") return pending;
      states.set(language.id, "loading");
      const load = (async () => {
        try {
          const [instance, wasm, highlights] = await Promise.all([
            runtimeOf(),
            fetchBytes(resolveUrl(language.wasmUrl, base)),
            fetchBytes(resolveUrl(language.highlightsUrl, base)),
          ]);
          current = instance.parser;
          const grammar = await instance.Language.load(wasm);
          loaded.set(language.id, {
            language: grammar,
            query: new instance.Query(grammar, new TextDecoder().decode(highlights)),
          });
          states.set(language.id, "ready");
        } catch (error) {
          states.set(language.id, "failed");
          throw error;
        } finally {
          announce();
        }
      })();
      loads.set(language.id, load);
      return load;
    },

    highlight(code, id) {
      const entry = loaded.get(id);
      if (!entry || !current) return undefined;
      if (code.length > MAX_HIGHLIGHT_LENGTH) return [];
      const key = `${id}\u0000${code}`;
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      current.setLanguage(entry.language);
      const tree = current.parse(code);
      let spans: readonly Span[] = [];
      if (tree) {
        spans = spansOf(
          code.length,
          entry.query.captures(tree.rootNode).map((capture) => ({
            name: capture.name,
            from: capture.node.startIndex,
            to: capture.node.endIndex,
            pattern: capture.patternIndex,
          })),
        );
        tree.delete();
      }
      cache.set(key, spans);
      if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      return spans;
    },

    async check(grammar, highlights) {
      const instance = await runtimeOf();
      let language: Language;
      try {
        language = await instance.Language.load(grammar);
      } catch (error) {
        throw new Error(`That is not a grammar this version of tree-sitter can load (${messageOf(error)})`);
      }
      try {
        new instance.Query(language, highlights).delete();
      } catch (error) {
        throw new Error(`The highlights query does not fit the grammar: ${messageOf(error)}`);
      }
    },

    forget(id) {
      loaded.get(id)?.query.delete();
      loaded.delete(id);
      loads.delete(id);
      states.delete(id);
      for (const key of [...cache.keys()]) if (key.startsWith(`${id}\u0000`)) cache.delete(key);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface Capture {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly pattern: number;
}

export function spansOf(length: number, captures: readonly Capture[]): Span[] {
  const classes: string[] = [];
  const indexOf = new Map<string, number>();
  const paint = new Int32Array(length).fill(-1);
  const ordered = captures
    .map((capture) => ({ ...capture, className: captureClass(capture.name) }))
    .filter((capture) => capture.className && capture.to > capture.from)
    .sort((a, b) => b.to - b.from - (a.to - a.from) || b.pattern - a.pattern);
  for (const capture of ordered) {
    const className = capture.className as string;
    let index = indexOf.get(className);
    if (index === undefined) {
      index = classes.push(className) - 1;
      indexOf.set(className, index);
    }
    paint.fill(index, Math.max(0, capture.from), Math.min(length, capture.to));
  }
  const spans: Span[] = [];
  let start = 0;
  for (let at = 1; at <= length; at += 1) {
    if (at < length && paint[at] === paint[start]) continue;
    const index = paint[start] ?? -1;
    if (index >= 0) spans.push({ from: start, to: at, className: classes[index] as string });
    start = at;
  }
  return spans;
}

function resolveUrl(url: string, base: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : new URL(url, base).href;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultFetch(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
