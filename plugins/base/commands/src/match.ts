/**
 * Palette matching: a subsequence match with a small, explainable score.
 *
 * Not a fuzzy-search library. The palette ranks tens of commands, all of whose titles
 * the user is half-remembering — "new doc" should find "New document" and "trash"
 * should find "Open Trash". Subsequence matching over `category + title` does that in
 * twenty lines, is stable (same query, same order, always), and has no dependency —
 * which matters because a plugin bundles everything outside the blessed runtime layer
 * (SPEC §6.4).
 */

export interface Matchable {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
}

export interface MatchResult<T extends Matchable> {
  readonly item: T;
  readonly score: number;
  /** Indices in `title` that matched, for highlighting. */
  readonly hits: readonly number[];
}

/**
 * Score one candidate. Higher is better; `undefined` means no match.
 *
 * The ordering it encodes: a prefix of the title beats a word start, which beats a
 * scattered subsequence; matches in the title beat matches that only work by including
 * the category; shorter titles win ties.
 */
export function scoreMatch(query: string, item: Matchable): MatchResult<Matchable> | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { item, score: 0, hits: [] };

  const title = item.title;
  const direct = subsequence(needle, title.toLowerCase());
  if (direct) {
    const bonus = title.toLowerCase().startsWith(needle) ? 1000 : 0;
    return { item, score: bonus + direct.score - title.length / 100, hits: direct.hits };
  }

  // Fall back to the category-qualified spelling ("admin users"), which is how people
  // narrow a palette when several plugins contribute similar titles.
  if (item.category) {
    const combined = `${item.category} ${title}`.toLowerCase();
    const wide = subsequence(needle, combined);
    if (wide) return { item, score: wide.score - 500 - title.length / 100, hits: [] };
  }
  return undefined;
}

/**
 * Rank and sort. Ties break on **category**, then title, then id, so the list never
 * jitters.
 *
 * Category first is what makes the *unfiltered* palette readable, and that is the state
 * it opens in: every score is 0 for an empty query, so the tie-break is the whole
 * ordering. Breaking on title alone interleaved the categories the rows are labelled
 * with — "Admin › Browse snapshots", "Appearance › Change theme", "Admin › Create an
 * invite" — and made a list of twenty-one commands read as unsorted. Uncategorised
 * commands sort first, where a short list of bare titles is easiest to scan.
 */
export function rankMatches<T extends Matchable>(query: string, items: readonly T[]): readonly MatchResult<T>[] {
  const scored: MatchResult<T>[] = [];
  for (const item of items) {
    const result = scoreMatch(query, item);
    if (result) scored.push({ item, score: result.score, hits: result.hits });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const left = a.item.category ?? "";
    const right = b.item.category ?? "";
    if (left !== right) return left < right ? -1 : 1;
    if (a.item.title !== b.item.title) return a.item.title < b.item.title ? -1 : 1;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });
  return scored;
}

/**
 * Is `needle` a subsequence of `haystack`? Both already lower-cased.
 *
 * The score rewards consecutive characters and characters at word starts — the two
 * signals that separate "New document" from "Rename folder" for the query `nd`.
 */
function subsequence(
  needle: string,
  haystack: string,
): { readonly score: number; readonly hits: readonly number[] } | undefined {
  const hits: number[] = [];
  let score = 0;
  let cursor = 0;
  let previous = -2;
  for (const character of needle) {
    if (character === " ") continue;
    const index = haystack.indexOf(character, cursor);
    if (index === -1) return undefined;
    hits.push(index);
    score += 10;
    if (index === previous + 1) score += 8;
    const before = index === 0 ? " " : haystack[index - 1];
    if (before === " " || before === "-" || before === "/" || before === ".") score += 6;
    previous = index;
    cursor = index + 1;
  }
  return { score, hits };
}
