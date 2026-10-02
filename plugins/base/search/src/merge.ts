import type { SearchHit } from "@kernel";

export interface ProviderResult {
  readonly providerId: string;
  readonly label: string;
  readonly order: number;
  readonly hits: readonly SearchHit[];
  readonly error?: string;
}

export interface MergedHit {
  readonly id: string;
  readonly score: number;
  readonly terms: readonly string[];
  readonly providers: readonly string[];
}

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
