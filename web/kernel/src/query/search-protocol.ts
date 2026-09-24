/**
 * The message protocol between {@link WorkerSearchIndex} and the search worker.
 *
 * Internal to `query/` — it is not part of the kernel's public surface and may
 * change whenever both halves change together. Everything crossing the port is
 * structured-cloneable: projection rows, ids, plain option objects.
 */

import type { ProjectionRow } from "../protocol.js";
import type { SearchHit, SearchOptions, SearchStats } from "./search.js";

export type SearchRequest =
  | { readonly op: "open" }
  | { readonly op: "upsert"; readonly rows: readonly ProjectionRow[] }
  | { readonly op: "remove"; readonly ids: readonly string[] }
  | { readonly op: "search"; readonly query: string; readonly options?: SearchOptions }
  | { readonly op: "persist"; readonly safeSeq: number }
  | { readonly op: "stats" }
  /**
   * A rebuild streams: `first` starts a fresh index, each message carries a page
   * of rows, and `last` installs it. An `AsyncIterable` cannot be posted, and
   * buffering 5 000 rows of up to 1 MiB into one message to avoid the chunking
   * would defeat the point of doing this off the main thread (SPEC §9 M2).
   */
  | {
      readonly op: "rebuild";
      readonly rows: readonly ProjectionRow[];
      readonly first: boolean;
      readonly last: boolean;
    }
  | { readonly op: "close" };

export type SearchResponseValue = void | readonly SearchHit[] | SearchStats;

export interface SearchRequestEnvelope {
  readonly id: number;
  readonly request: SearchRequest;
}

export type SearchResponseEnvelope =
  | { readonly id: number; readonly ok: true; readonly value: SearchResponseValue }
  | { readonly id: number; readonly ok: false; readonly error: string };
