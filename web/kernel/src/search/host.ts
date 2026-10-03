import {
  CapabilityUnavailableError,
  SearchUnavailableError,
  createSearchApi,
  type PluginManifest,
  type SearchApi,
  type SearchPlanJson,
  type SearchResult,
  type SearchResultOptions,
  type SearchWatch,
} from "@kernel";

import { serializeSearchError } from "./errors.js";
import type { ProjectionFeed } from "./feed.js";
import type { SearchRows } from "./projection.js";
import { reviveSearchError } from "./revive.js";

type Result = SearchResult<unknown, SearchResultOptions>;
type WindowedResult = Result & { readonly total: number; readonly start: number };

const HIDDEN_TAB_DELAY_MS = 100;

function schedule(run: () => void): void {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    run();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(once);
  setTimeout(once, typeof requestAnimationFrame === "function" ? HIDDEN_TAB_DELAY_MS : 0);
}

function resultOf(rows: SearchRows): Result {
  return {
    rows: rows.rows,
    ...(rows.total === undefined ? {} : { total: rows.total }),
    ...(rows.nextCursor === undefined ? {} : { nextCursor: rows.nextCursor }),
    ...(rows.hits === undefined ? {} : { hits: rows.hits }),
  } as Result;
}

class LiveSearch implements SearchWatch<unknown, SearchResultOptions> {
  #result: WindowedResult;
  #key: string;
  #sources: ReadonlySet<string>;
  #window: { readonly start: number; readonly count: number } | undefined;
  #closed = false;
  readonly #listeners = new Set<(result: Result) => void>();

  constructor(
    private readonly host: SearchHost,
    private readonly base: SearchPlanJson,
    first: SearchRows,
  ) {
    this.#result = { ...resultOf(first), total: first.total ?? first.rows.length, start: 0 };
    this.#key = JSON.stringify(this.#result);
    this.#sources = new Set(first.sources);
  }

  get result(): WindowedResult {
    return this.#result;
  }

  get closed(): boolean {
    return this.#closed;
  }

  reads(sources: ReadonlySet<string>): boolean {
    for (const source of sources) if (this.#sources.has(source)) return true;
    return false;
  }

  onChange(listener: (result: Result) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async window(start: number, count: number): Promise<void> {
    this.#window = { start: Math.max(0, Math.floor(start)), count: Math.max(0, Math.floor(count)) };
    await this.refresh();
  }

  plan(): SearchPlanJson {
    return LiveSearch.windowed(this.base, this.#window);
  }

  static windowed(base: SearchPlanJson, window?: { readonly start: number; readonly count: number }): SearchPlanJson {
    const stages = [...(base.stages ?? [])];
    if (window) stages.push({ offset: window.start }, { limit: window.count });
    stages.push("with_total");
    return { ...base, stages };
  }

  async refresh(): Promise<void> {
    if (this.#closed) return;
    const rows = await this.host.execute(this.plan());
    if (this.#closed) return;
    this.#sources = new Set(rows.sources);
    const next: WindowedResult = {
      ...resultOf(rows),
      total: rows.total ?? rows.rows.length,
      start: this.#window?.start ?? 0,
    };
    const key = JSON.stringify(next);
    if (key === this.#key) return;
    this.#key = key;
    this.#result = next;
    for (const listener of [...this.#listeners]) listener(next);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.host.forget(this);
  }
}

export class SearchHost {
  readonly #live = new Set<LiveSearch>();
  #dirty = new Set<string>();
  #scheduled = false;

  constructor(private readonly feed: ProjectionFeed | undefined) {
    feed?.onChange((sources) => this.#invalidate(sources));
  }

  async execute(plan: SearchPlanJson): Promise<SearchRows> {
    if (!this.feed) throw new SearchUnavailableError("search is not available in this build");
    try {
      await this.feed.ready;
    } catch (cause) {
      throw new SearchUnavailableError(
        `the search projection could not be built: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      );
    }
    try {
      return await this.feed.run(plan);
    } catch (error) {
      throw reviveSearchError(serializeSearchError(error));
    }
  }

  async run(plan: SearchPlanJson): Promise<Result> {
    return resultOf(await this.execute(plan));
  }

  async watch(plan: SearchPlanJson): Promise<LiveSearch> {
    const first = await this.execute(LiveSearch.windowed(plan));
    const live = new LiveSearch(this, plan, first);
    this.#live.add(live);
    return live;
  }

  forget(live: LiveSearch): void {
    this.#live.delete(live);
  }

  get watching(): number {
    return this.#live.size;
  }

  forPlugin(manifest: PluginManifest, track: (dispose: () => void) => () => void): SearchApi {
    const allowed = manifest.capabilities?.documents?.includes("read") === true;
    const refuse = (): Promise<never> =>
      Promise.reject(
        new CapabilityUnavailableError("documents", `${manifest.id} does not declare documents: read, which search needs`),
      );
    return createSearchApi({
      run: (plan) => (allowed ? this.run(plan) : refuse()),
      watch: async (plan) => {
        if (!allowed) return refuse();
        const live = await this.watch(plan);
        const close = track(() => live.close());
        return {
          get result() {
            return live.result;
          },
          onChange: (listener) => track(live.onChange(listener)),
          window: (start, count) => live.window(start, count),
          close,
        };
      },
    });
  }

  #invalidate(sources: ReadonlySet<string>): void {
    for (const source of sources) this.#dirty.add(source);
    if (this.#scheduled) return;
    this.#scheduled = true;
    schedule(() => {
      this.#scheduled = false;
      const dirty = this.#dirty;
      this.#dirty = new Set();
      for (const live of [...this.#live]) {
        if (live.reads(dirty)) void live.refresh().catch(() => undefined);
      }
    });
  }
}
