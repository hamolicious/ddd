/**
 * Merging results from several providers, and picking the line to show.
 *
 * **Scores from different providers are not comparable.** The local index returns
 * MiniSearch's BM25-ish numbers; the server returns Mongo `$text` order; a future
 * semantic provider would return cosine distances. Adding or averaging them produces a
 * plausible-looking ranking that means nothing. So a provider's *ranking* is what is
 * trusted: each result set is converted to `1/(rank+1)` before merging, and a document
 * found by two providers keeps its best rank and records both attributions.
 *
 * The provider's seat (SPEC §6.5: the local index is seated first by default) breaks
 * ties, which is what makes the offline-correct provider the one whose opinion wins.
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

export interface SnippetRange {
  readonly start: number;
  readonly end: number;
}

export interface Snippet {
  readonly text: string;
  /** Offsets into `text` to highlight. Non-overlapping, ascending. */
  readonly ranges: readonly SnippetRange[];
  /**
   * The **1-based line** of the materialized text this snippet came from, so a result
   * can deep-link to it (`#/doc/<id>?line=42`) rather than only to the document.
   *
   * It is a line of `content` — the whole materialized string, frontmatter and `%%%`
   * sections included — which is the same string the editor holds, so the number means
   * the same thing on both sides. A result whose only match is *in* the frontmatter
   * therefore links into the frontmatter, which is where the match is.
   */
  readonly line: number;
}

/**
 * The line to show under a result, with the matched terms located in it.
 *
 * It searches the whole materialized text, frontmatter and `%%%` sections included.
 * That is deliberate for now and worth knowing: the regions a viewer hides (SPEC §6.5)
 * are identified by *spans*, and `@kernel`'s `CoreApi.parseDocument` returns `fm`,
 * `plugins` and `title` without them — so stripping them here would mean
 * re-implementing the fence rules in TypeScript, which SPEC §2 spends a section
 * forbidding. A match in frontmatter is also a real match.
 */
export function snippetFor(
  content: string | undefined,
  terms: readonly string[],
  options: { readonly maxLength?: number } = {},
): Snippet | undefined {
  if (!content) return undefined;
  const maxLength = options.maxLength ?? 180;
  const needles = terms
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);

  const lines = content.split("\n");
  // The *index* is what carries the line number; `find` alone would lose it.
  let at = -1;
  if (needles.length > 0) {
    at = lines.findIndex((line) => {
      const lower = line.toLowerCase();
      return line.trim() !== "" && needles.some((needle) => lower.includes(needle));
    });
  }
  if (at < 0) at = lines.findIndex((line) => line.trim() !== "");
  const chosen = at < 0 ? undefined : lines[at];
  if (chosen === undefined) return undefined;

  const trimmed = chosen.trim();
  const text = trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
  return { text, ranges: locate(text, needles), line: at + 1 };
}

/** Every occurrence of every needle, merged into non-overlapping ascending ranges. */
function locate(text: string, needles: readonly string[]): readonly SnippetRange[] {
  const lower = text.toLowerCase();
  const found: SnippetRange[] = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const index = lower.indexOf(needle, from);
      if (index === -1) break;
      found.push({ start: index, end: index + needle.length });
      from = index + needle.length;
    }
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: SnippetRange[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

export { splitHighlights } from "../../_shared/highlights.js";
