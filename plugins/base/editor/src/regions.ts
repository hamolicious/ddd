/**
 * Where the **machine regions** of a document are, in character offsets, so the editor
 * can fold them (SPEC §3.1, §6.5).
 *
 * ## Why this file exists, and why it is not a parser
 *
 * The shared Rust core already computes exactly these spans — `ParsedDocument` carries
 * `frontmatter_span`, `body_span` and a `span` per `%%%` section — but the client ABI
 * (`backend/crates/core/src/wasm.rs` → `parse_document`) returns only
 * `{title, fm, plugins, fm_parse_error}` and drops every span. `kernel.core` therefore
 * has no way to answer "where does the frontmatter end", and folding needs a range.
 *
 * So this is a **presentation-only line scanner**. It decides what to fold, and nothing
 * else: no value is parsed here, no key is read here, nothing it returns is written
 * anywhere or compared against the server. Get it subtly wrong and a fold is off by a
 * line; the document's meaning is untouched. The moment the ABI exposes the spans, this
 * file becomes a call to `kernel.core` and the tests below become its regression net.
 * (Recorded as an INTEGRATION note against the `wasm` area.)
 *
 * The rules it implements are the core's, from `crates/core/README.md` §1:
 *
 * - Frontmatter opens **only** if the literal first line is `---`, and closes at the
 *   next line that is exactly `---`. Never closed ⇒ there is no frontmatter at all.
 * - A machine-section opening fence is exactly `%%% ` + an id matching
 *   `^[A-Za-z0-9_-]{1,64}$`; the closing fence is exactly `%%%`. Trailing whitespace
 *   on a fence line means it is **not** a fence.
 * - Only the **last contiguous run** of fences at the end of the document counts.
 *   Blank lines are tolerated between sections of the run and after the final fence.
 * - A closing fence with no opener before it ends the run.
 */

/** A half-open range in characters (UTF-16 code units — `Y.Text` and CodeMirror agree). */
export interface Region {
  readonly start: number;
  readonly end: number;
}

export interface SectionRegion extends Region {
  /** The plugin id on the opening fence. */
  readonly id: string;
}

export interface DocumentRegions {
  /** The frontmatter block including both `---` lines, when there is one. */
  readonly frontmatter?: Region;
  /** Each `%%%` section of the trailing run, in document order. */
  readonly sections: readonly SectionRegion[];
  /** The whole trailing run, when there is one — sections plus the blank lines in it. */
  readonly sectionsRun?: Region;
}

const FENCE_OPEN = /^%%% ([A-Za-z0-9_-]{1,64})$/;
const SECTION_ID_CAP = 64;

/**
 * The document as lines, **lazily**.
 *
 * The scan below only ever looks at the head (until the frontmatter closes) and the tail
 * (the trailing `%%%` run), so it must not be given a structure that costs a pass over
 * the whole document to build. That is not a micro-optimisation: the fold service is
 * consulted per visible line on every viewport update, so it runs on every keystroke —
 * and `doc.toString()` plus `split("\n")` on a 1 MB document (SPEC §3.5's cap) is a
 * megabyte of allocation per keystroke, on the mid-range Android of the §8 budget.
 *
 * {@link documentRegions} still takes a string, because that is what the tests and the
 * open-time fold want; the editor passes a reader over CodeMirror's `Text`, which already
 * indexes its own lines, so nothing is copied at all.
 */
export interface LineReader {
  /** Number of lines. A document ending in `\n` has a final empty line, as `split` gives. */
  readonly lines: number;
  /** Total length in UTF-16 code units. */
  readonly length: number;
  /** Line `index` (0-based): its text without the terminator, and its start offset. */
  lineAt(index: number): { readonly text: string; readonly from: number };
}

/** A `LineReader` over a plain string. One pass, for callers that already hold the text. */
export function stringLines(text: string): LineReader {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1; // the "\n" we split on
  }
  return {
    lines: lines.length,
    length: text.length,
    lineAt: (index) => ({ text: lines[index] ?? "", from: starts[index] ?? text.length }),
  };
}

/**
 * Locate the machine regions of `text`.
 *
 * Total: any input, however malformed, yields a `DocumentRegions`. Ranges never
 * overlap and never exceed `text.length`.
 */
export function documentRegions(text: string): DocumentRegions {
  return regionsOf(stringLines(text));
}

/** {@link documentRegions} over any {@link LineReader}. */
export function regionsOf(source: LineReader): DocumentRegions {
  // `\r\n` is normalized away before a document is stored (core: `normalize_input`), but
  // an editor buffer is live text, so tolerate a stray `\r` at a fence.
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

  // --- frontmatter -------------------------------------------------------
  let frontmatter: Region | undefined;
  /** The line the frontmatter closes on, or -1. Both scans need it as a floor. */
  let frontmatterEndLine = -1;
  if (count > 1 && at(0) === "---") {
    for (let index = 1; index < count; index++) {
      if (at(index) !== "---") continue;
      frontmatter = { start: 0, end: lineEnd(index) };
      frontmatterEndLine = index;
      break;
    }
    // Unterminated ⇒ no frontmatter at all. Folding to the end of the document
    // because the user has not typed the closing fence yet would be hostile.
  }

  // --- the trailing `%%%` run -------------------------------------------
  // Walked from the end: the run is defined by where the document *stops*, and an
  // earlier well-formed-looking fence in the body must not claim it.
  let cursor = count - 1;
  // A trailing newline makes the last element an empty string; blank lines after the
  // final fence belong to the run, not the body.
  while (cursor >= 0 && at(cursor).trim().length === 0) cursor--;

  const sections: SectionRegion[] = [];
  let runFirstLine: number | undefined;

  while (cursor > frontmatterEndLine) {
    if (at(cursor) !== "%%%") break; // not a closing fence ⇒ the run ends here
    const close = cursor;
    let open = -1;
    for (let index = close - 1; index > frontmatterEndLine; index--) {
      const line = at(index);
      if (line === "%%%") break; // a second closing fence: no opener for this one
      const match = FENCE_OPEN.exec(line);
      if (match && (match[1]?.length ?? 0) <= SECTION_ID_CAP) {
        open = index;
        break;
      }
    }
    if (open < 0) break; // closing fence with no opener ⇒ the run ends here
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

/**
 * The ranges the editor folds on open.
 *
 * `%%%` sections are **always** folded — they are machine-owned data and the prose is
 * what the user came for (SPEC §6.5). The frontmatter fold is a preference, because
 * frontmatter is human-owned (SPEC §3.3) and plenty of people write it by hand.
 *
 * A region shorter than two lines is skipped: CodeMirror cannot fold a range that does
 * not span a line boundary, and a one-line "fold" would just hide text with no handle.
 */
export function foldableRegions(
  text: string,
  options: { readonly frontmatter: boolean } = { frontmatter: true },
): readonly Region[] {
  const regions = documentRegions(text);
  const folds: Region[] = [];
  if (options.frontmatter && regions.frontmatter && spansALineBreak(text, regions.frontmatter)) {
    folds.push(regions.frontmatter);
  }
  for (const section of regions.sections) {
    if (spansALineBreak(text, section)) folds.push(section);
  }
  return folds;
}

function spansALineBreak(text: string, region: Region): boolean {
  return text.slice(region.start, region.end).includes("\n");
}

/** The machine region containing `offset`, if any — what the fold service answers with. */
export function regionAt(text: string, offset: number): Region | undefined {
  const regions = documentRegions(text);
  if (regions.frontmatter && offset >= regions.frontmatter.start && offset <= regions.frontmatter.end) {
    return regions.frontmatter;
  }
  return regions.sections.find((section) => offset >= section.start && offset <= section.end);
}
