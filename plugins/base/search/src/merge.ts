/**
 * Merging results from several providers (plugins' own sources, `addProvider`). The
 * workspace's own ranking, and the line shown under a result, are the query engine's.
 *
 * **Scores from different providers are not comparable.** One may return BM25-ish
 * numbers, another an external service's order, a semantic one cosine distances. Adding or averaging them produces a
 * plausible-looking ranking that means nothing. So a provider's *ranking* is what is
 * trusted: each result set is converted to `1/(rank+1)` before merging, and a document
 * found by two providers keeps its best rank and records both attributions.
 *
 * The provider's seat (its `order`) breaks ties.
 */

import type { SearchHit } from "@kernel";

/** One provider's answer, or its failure. A network provider fails offline; that is data. */
export interface ProviderResult {
  readonly providerId: string;
  readonly label: string;
  /** The provider's seat on the `search` port, 0 first: the tie-breaker. */
  readonly order: number;
  readonly hits: readonly SearchHit[];
  /** Set when the provider threw. The UI shows it per provider, never as a dead page. */
  readonly error?: string;
}

export interface MergedHit {
  readonly id: string;
  /** Rank-derived, in (0, 1]. Comparable across providers by construction. */
  readonly score: number;
  readonly terms: readonly string[];
  /** Provider ids that returned this document, best first. */
  readonly providers: readonly string[];
}

/**
 * Merge, de-duplicate by document id, and sort best-first.
 *
 * Deterministic: equal scores break on the winning provider's seat, then on id, so
 * the same query over the same data always lists the same way.
 */
export function mergeHits(results: readonly ProviderResult[], limit?: number): readonly MergedHit[] {
  const merged = new Map<string, { hit: MergedHit; order: number }>();

  for (const result of results) {
    result.hits.forEach((hit, rank) => {
      const score = 1 / (rank + 1);
      const existing = merged.get(hit.id);
      if (!existing) {
        merged.set(hit.id, {
          order: result.order,
          hit: { id: hit.id, score, terms: [...hit.terms], providers: [result.providerId] },
        });
        return;
      }
      const terms = new Set([...existing.hit.terms, ...hit.terms]);
      const better = score > existing.hit.score;
      merged.set(hit.id, {
        order: better ? result.order : existing.order,
        hit: {
          id: hit.id,
          score: Math.max(existing.hit.score, score),
          terms: [...terms],
          providers: better
            ? [result.providerId, ...existing.hit.providers]
            : [...existing.hit.providers, result.providerId],
        },
      });
    });
  }

  const ordered = [...merged.values()].sort((a, b) => {
    if (a.hit.score !== b.hit.score) return b.hit.score - a.hit.score;
    if (a.order !== b.order) return a.order - b.order;
    return a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0;
  });
  const hits = ordered.map((entry) => entry.hit);
  return limit === undefined ? hits : hits.slice(0, limit);
}

export { splitHighlights } from "../../_shared/highlights.js";
