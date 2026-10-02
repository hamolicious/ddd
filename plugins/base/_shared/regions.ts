export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface DocumentRegions {
  readonly frontmatter: Span | null;
  readonly sections: Span | null;
  readonly body: Span;
}

const FM_FENCE = "---";
const SECTION_FENCE = "%%%";
const SECTION_FENCE_OPEN = "%%% ";
const MAX_ID_LEN = 64;

interface Line {
  readonly start: number;
  readonly end: number;
  readonly fullEnd: number;
  readonly content: string;
}

function splitLines(text: string, base: number): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      let end = text.length;
      if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
      out.push({
        start: base + start,
        end: base + end,
        fullEnd: base + text.length,
        content: text.slice(start, end),
      });
      break;
    }
    let end = newline;
    if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
    out.push({
      start: base + start,
      end: base + end,
      fullEnd: base + newline + 1,
      content: text.slice(start, end),
    });
    start = newline + 1;
  }
  return out;
}

export function openFenceId(content: string): string | null {
  if (!content.startsWith(SECTION_FENCE_OPEN)) return null;
  const id = content.slice(SECTION_FENCE_OPEN.length);
  if (id.length === 0 || id.length > MAX_ID_LEN) return null;
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

function findFrontmatter(lines: readonly Line[]): Span | null {
  const first = lines[0];
  if (!first || first.content !== FM_FENCE) return null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && line.content === FM_FENCE) {
      return { start: first.start, end: line.fullEnd };
    }
  }
  return null;
}

function findSectionRun(lines: readonly Line[]): Span | null {
  const pairs: Array<readonly [number, number]> = [];
  let cursor = lines.length;
  for (;;) {
    while (cursor > 0 && (lines[cursor - 1]?.content ?? "").trim() === "") cursor -= 1;
    if (cursor === 0) break;
    const close = cursor - 1;
    if (lines[close]?.content !== SECTION_FENCE) break;
    let open = -1;
    let probe = close;
    while (probe > 0) {
      probe -= 1;
      const content = lines[probe]?.content ?? "";
      if (content === SECTION_FENCE) break;
      if (openFenceId(content) !== null) {
        open = probe;
        break;
      }
    }
    if (open < 0) break;
    pairs.push([open, close]);
    cursor = open;
  }
  if (pairs.length === 0) return null;
  const firstPair = pairs[pairs.length - 1];
  const lastPair = pairs[0];
  const openLine = firstPair ? lines[firstPair[0]] : undefined;
  const closeLine = lastPair ? lines[lastPair[1]] : undefined;
  if (!openLine || !closeLine) return null;
  return { start: openLine.start, end: closeLine.fullEnd };
}

export function regionsOf(text: string): DocumentRegions {
  const base = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lines = splitLines(base === 0 ? text : text.slice(base), base);
  const frontmatter = findFrontmatter(lines);
  const sections = findSectionRun(lines);
  const start = frontmatter ? frontmatter.end : base;
  const end = Math.max(sections ? sections.start : text.length, start);
  return { frontmatter, sections, body: { start, end } };
}

export function bodyStart(text: string): number {
  return regionsOf(text).body.start;
}

export function bodyOf(text: string): string {
  const { body } = regionsOf(text);
  return text.slice(body.start, body.end);
}
