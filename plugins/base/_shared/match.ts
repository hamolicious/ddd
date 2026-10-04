export interface MatchSnippet {
  readonly text: string;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly line: number;
}

export const MATCH_CONTEXT = 60;

function bodyStart(content: string): number {
  if (!content.startsWith("---\n")) return 0;
  const end = /\n---[ \t]*(\n|$)/.exec(content.slice(3));
  return end ? 3 + end.index + end[0].length : 0;
}

function occurrences(haystack: string, needles: readonly string[]): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const needle of needles) {
    if (needle === "") continue;
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      found.push({ start: at, end: at + needle.length });
      at = haystack.indexOf(needle, at + needle.length);
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function matchSnippet(content: string, terms: readonly string[]): MatchSnippet | undefined {
  const lower = content.toLowerCase();
  const needles = [...new Set(terms.map((term) => term.toLowerCase().trim()))];
  const start = bodyStart(content);
  const first = occurrences(lower.slice(start), needles)[0];
  if (!first) return undefined;
  const at = start + first.start;
  const lineStart = content.lastIndexOf("\n", at - 1) + 1;
  const newline = content.indexOf("\n", at);
  const lineEnd = newline === -1 ? content.length : newline;
  const from = Math.max(lineStart, at - MATCH_CONTEXT);
  const to = Math.min(lineEnd, start + first.end + MATCH_CONTEXT);
  const lead = from > lineStart ? "…" : "";
  const tail = to < lineEnd ? "…" : "";
  const excerpt = content.slice(from, to);
  const ranges = occurrences(excerpt.toLowerCase(), needles).map((range) => ({
    start: range.start + lead.length,
    end: range.end + lead.length,
  }));
  return {
    text: `${lead}${excerpt}${tail}`,
    ranges,
    line: content.slice(0, at).split("\n").length,
  };
}
