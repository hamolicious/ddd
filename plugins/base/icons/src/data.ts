/**
 * The icon set, fetched from next to this module as it is needed (`build.mjs` writes it).
 *
 * Drawings come in shards by first character: asking for `home` fetches `h.json`, once,
 * and everything else starting with `h` is then drawn without waiting. The search index is
 * fetched only when something searches. A failed fetch is forgotten so the next ask
 * retries it, rather than leaving that shard blank for the session.
 */

import type { IconIndex } from "./search.js";

/** One `<path>`: its `d`, or its `d` with the few attributes Tabler sets on it. */
export type IconPath = string | { readonly d: string; readonly [attribute: string]: string };

const base = import.meta.url;

const shards = new Map<string, Readonly<Record<string, readonly IconPath[]>>>();
const pending = new Map<string, Promise<void>>();
let index: Promise<IconIndex> | undefined;

const load = async <T,>(file: string): Promise<T> => {
  const response = await fetch(new URL(`tabler/${file}`, base).href);
  if (!response.ok) throw new Error(`icons: ${file}: ${response.status}`);
  return (await response.json()) as T;
};

const shardOf = (name: string): string => name.charAt(0);

/** The drawing, if its shard is already here; `undefined` means "not yet" or "no such icon". */
export function drawingNow(name: string): readonly IconPath[] | undefined {
  return shards.get(shardOf(name))?.[name];
}

/** Fetch `name`'s shard if it is not here yet. */
export function loadDrawing(name: string): Promise<void> {
  const key = shardOf(name);
  if (!/^[a-z0-9]$/.test(key) || shards.has(key)) return Promise.resolve();
  let loading = pending.get(key);
  if (!loading) {
    loading = load<Record<string, readonly IconPath[]>>(`${key}.json`)
      .then((shard) => {
        shards.set(key, shard);
      })
      .finally(() => pending.delete(key));
    pending.set(key, loading);
  }
  return loading;
}

export function loadIndex(): Promise<IconIndex> {
  index ??= load<IconIndex>("index.json").catch((cause: unknown) => {
    index = undefined;
    throw cause;
  });
  return index;
}
