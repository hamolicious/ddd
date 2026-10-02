export interface Matchable {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
}

export interface MatchResult<T extends Matchable> {
  readonly item: T;
  readonly score: number;
  readonly hits: readonly number[];
}

export function scoreMatch(query: string, item: Matchable): MatchResult<Matchable> | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { item, score: 0, hits: [] };

  const title = item.title;
  const direct = subsequence(needle, title.toLowerCase());
  if (direct) {
    const bonus = title.toLowerCase().startsWith(needle) ? 1000 : 0;
    return { item, score: bonus + direct.score - title.length / 100, hits: direct.hits };
  }

  if (item.category) {
    const combined = `${item.category} ${title}`.toLowerCase();
    const wide = subsequence(needle, combined);
    if (wide) return { item, score: wide.score - 500 - title.length / 100, hits: [] };
  }
  return undefined;
}

export function rankMatches<T extends Matchable>(
  query: string,
  items: readonly T[],
  recency: ReadonlyMap<string, number> = new Map(),
): readonly MatchResult<T>[] {
  const scored: MatchResult<T>[] = [];
  for (const item of items) {
    const result = scoreMatch(query, item);
    if (result) scored.push({ item, score: result.score, hits: result.hits });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const leftUsed = recency.get(a.item.id) ?? Number.POSITIVE_INFINITY;
    const rightUsed = recency.get(b.item.id) ?? Number.POSITIVE_INFINITY;
    if (leftUsed !== rightUsed) return leftUsed < rightUsed ? -1 : 1;
    const left = a.item.category ?? "";
    const right = b.item.category ?? "";
    if (left !== right) return left < right ? -1 : 1;
    if (a.item.title !== b.item.title) return a.item.title < b.item.title ? -1 : 1;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });
  return scored;
}

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
