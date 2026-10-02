export interface Region {
  readonly start: number;
  readonly end: number;
}

export interface SectionRegion extends Region {
  readonly id: string;
}

export interface DocumentRegions {
  readonly frontmatter?: Region;
  readonly sections: readonly SectionRegion[];
  readonly sectionsRun?: Region;
}

const FENCE_OPEN = /^%%% ([A-Za-z0-9_-]{1,64})$/;
const SECTION_ID_CAP = 64;

export interface LineReader {
  readonly lines: number;
  readonly length: number;
  lineAt(index: number): { readonly text: string; readonly from: number };
}

export function stringLines(text: string): LineReader {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return {
    lines: lines.length,
    length: text.length,
    lineAt: (index) => ({ text: lines[index] ?? "", from: starts[index] ?? text.length }),
  };
}

export function documentRegions(text: string): DocumentRegions {
  return regionsOf(stringLines(text));
}

export function regionsOf(source: LineReader): DocumentRegions {
  const count = source.lines;
  const total = source.length;
  const lineStart = (index: number): number =>
    index >= 0 && index < count ? source.lineAt(index).from : total;
  const lineEnd = (index: number): number => {
    if (index < 0 || index >= count) return total;
    const line = source.lineAt(index);
    return Math.min(line.from + line.text.length, total);
  };
  const at = (index: number): string =>
    index >= 0 && index < count ? source.lineAt(index).text.replace(/\r$/, "") : "";

  let frontmatter: Region | undefined;
  let frontmatterEndLine = -1;
  if (count > 1 && at(0) === "---") {
    for (let index = 1; index < count; index++) {
      if (at(index) !== "---") continue;
      frontmatter = { start: 0, end: lineEnd(index) };
      frontmatterEndLine = index;
      break;
    }
  }

  let cursor = count - 1;
  while (cursor >= 0 && at(cursor).trim().length === 0) cursor--;

  const sections: SectionRegion[] = [];
  let runFirstLine: number | undefined;

  while (cursor > frontmatterEndLine) {
    if (at(cursor) !== "%%%") break;
    const close = cursor;
    let open = -1;
    for (let index = close - 1; index > frontmatterEndLine; index--) {
      const line = at(index);
      if (line === "%%%") break;
      const match = FENCE_OPEN.exec(line);
      if (match && (match[1]?.length ?? 0) <= SECTION_ID_CAP) {
        open = index;
        break;
      }
    }
    if (open < 0) break;
    sections.unshift({
      id: FENCE_OPEN.exec(at(open))?.[1] ?? "",
      start: lineStart(open),
      end: lineEnd(close),
    });
    runFirstLine = open;
    cursor = open - 1;
    while (cursor > frontmatterEndLine && at(cursor).trim().length === 0) cursor--;
  }

  const sectionsRun =
    runFirstLine === undefined
      ? undefined
      : { start: lineStart(runFirstLine), end: sections[sections.length - 1]?.end ?? total };

  return frontmatter ? { frontmatter, sections, sectionsRun } : { sections, sectionsRun };
}

export function foldableRegionsOf(regions: DocumentRegions): readonly Region[] {
  return regions.sections;
}

export function foldableRegions(text: string): readonly Region[] {
  return foldableRegionsOf(documentRegions(text)).filter((region) =>
    spansALineBreak(text, region),
  );
}

function spansALineBreak(text: string, region: Region): boolean {
  return text.slice(region.start, region.end).includes("\n");
}

export function regionAt(text: string, offset: number): Region | undefined {
  const regions = documentRegions(text);
  if (regions.frontmatter && offset >= regions.frontmatter.start && offset <= regions.frontmatter.end) {
    return regions.frontmatter;
  }
  return regions.sections.find((section) => offset >= section.start && offset <= section.end);
}
