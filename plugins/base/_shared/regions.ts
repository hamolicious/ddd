/**
 * The three regions of one document text (SPEC §3.1, §3.4), located by offset.
 *
 * Read mode shows the **body**: the frontmatter block and the trailing `%%%` run are
 * part of the text but are not prose (SPEC §3.1), so `markdown` has to know where they
 * end before it parses anything. It also has to know where the body *starts*, because a
 * task checkbox writes a text splice at an absolute document offset while the pipeline
 * only ever sees the body.
 *
 * Shared, not a dependency: `markdown` renders the body and `indexer` counts and scans it,
 * and the two must agree to the byte about where it is — a link inside a `%%%` section
 * that one of them counts and the other hides is the drift this file exists to prevent.
 *
 * ---
 *
 * **INTEGRATION (area `wasm` / `kernel-runtime`): this file should not exist.**
 *
 * SPEC §2 is explicit that the `%%%` and frontmatter parsers are written once, in Rust,
 * and `backend/crates/core/src/document.rs` already computes exactly what is needed —
 * `ParsedDocument.frontmatter_span`, `body_span`, and `sections_span()`. The Wasm ABI
 * (`backend/crates/core/src/wasm.rs::parse_document`) serializes only
 * `{title, fm, plugins, fm_parse_error}` and throws the spans away, and `CoreApi`
 * (`web/kernel-api/src/kernel.ts`) therefore cannot offer them. So the one thing SPEC
 * §2 forbids — a second implementation of the fence rules — is currently the only way
 * for a *plugin* to find the body.
 *
 * What would fix it, in the order a reviewer should consider it:
 *
 * 1. Add the three spans to the `parse_document` JSON payload, **in UTF-16 code
 *    units**. The Rust spans are UTF-8 byte offsets (`document.rs`, `Span`), while
 *    `Y.Text` and `TextRange` are UTF-16 (`kernel-api/src/documents.ts`), so the
 *    conversion has to happen on the Rust side of the boundary or every caller
 *    re-derives it wrongly on the first non-ASCII character.
 * 2. Surface them on `CoreBindings` and as `CoreApi.documentRegions(text)`.
 * 3. Delete this file; `regionsOf` becomes `kernel.core.documentRegions`.
 *
 * `editor` (area `base-docs`) needs the same three spans to collapse the machine
 * regions (it has its own copy, `editor/src/regions.ts`), `viewer` calls
 * `markdown.bodyOf`, and `indexer` imports this file, so this is one shared need, not a
 * markdown quirk. Until then the code below mirrors the Rust line-for-line and
 * `regions.test.ts` pins the cases that matter.
 *
 * Known, accepted divergence from the Rust: `core::document::normalize_input` converts a
 * **lone CR** to LF before computing spans, which can create lines this scanner does not
 * see. Normalizing here would shift every offset and make splices write to the wrong
 * place, so it is deliberately not done. CRLF is handled (a trailing `\r` is part of the
 * terminator, exactly as `core::yaml::lines` does it) and a leading BOM is skipped.
 */

/** A half-open range in **UTF-16 code units** — `Y.Text` indices, like `TextRange`. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface DocumentRegions {
  /** The frontmatter block including both `---` lines and the closing newline. */
  readonly frontmatter: Span | null;
  /** The whole trailing `%%%` run, first opening fence → end of the last closing fence. */
  readonly sections: Span | null;
  /** What read mode renders: after the frontmatter, before the run. */
  readonly body: Span;
}

/** The frontmatter fence line, byte-exact (`core::frontmatter::FENCE`). */
const FM_FENCE = "---";
/** The closing machine fence, byte-exact (`core::sections::FENCE`). */
const SECTION_FENCE = "%%%";
/** The opening machine fence prefix, byte-exact (`core::sections::FENCE_OPEN`). */
const SECTION_FENCE_OPEN = "%%% ";
/** `core::limits::MAX_KEY_LEN` — the cap a plugin id in a fence must respect. */
const MAX_ID_LEN = 64;

interface Line {
  /** Offset of the first character of the line. */
  readonly start: number;
  /** Offset just past the content, excluding `\r` and `\n`. */
  readonly end: number;
  /** Offset just past the terminator — the next line's `start`. */
  readonly fullEnd: number;
  readonly content: string;
}

/**
 * Split into lines the way `core::yaml::lines` does: only `\n` terminates, a trailing
 * `\r` belongs to the terminator rather than the content, and the last line needs no
 * terminator. `base` is added to every offset so a BOM can be skipped without copying.
 */
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

/**
 * The plugin id of an opening `%%% <id>` fence, or `null`.
 * Mirrors `core::sections::open_fence_id`: exact prefix, `^[A-Za-z0-9_-]{1,64}$` id,
 * and trailing whitespace means it is not a fence.
 */
export function openFenceId(content: string): string | null {
  if (!content.startsWith(SECTION_FENCE_OPEN)) return null;
  const id = content.slice(SECTION_FENCE_OPEN.length);
  if (id.length === 0 || id.length > MAX_ID_LEN) return null;
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/** Mirrors `core::frontmatter::find_block` — the outer span, or `null`. */
function findFrontmatter(lines: readonly Line[]): Span | null {
  const first = lines[0];
  if (!first || first.content !== FM_FENCE) return null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    // `noUncheckedIndexedAccess`: the loop bound makes this total.
    if (line && line.content === FM_FENCE) {
      return { start: first.start, end: line.fullEnd };
    }
  }
  // Opens but never closes ⇒ there is no frontmatter at all (SPEC §3.4).
  return null;
}

/**
 * Mirrors `core::sections::parse`'s backward walk: from the last non-blank line, pair
 * each `%%%` with the nearest preceding `%%% <id>`, and stop at the first line that
 * breaks the run. Anything earlier in the document is body text.
 */
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

/** Locate all three regions. Total: any input, however malformed, yields spans. */
export function regionsOf(text: string): DocumentRegions {
  const base = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lines = splitLines(base === 0 ? text : text.slice(base), base);
  const frontmatter = findFrontmatter(lines);
  const sections = findSectionRun(lines);
  const start = frontmatter ? frontmatter.end : base;
  const end = Math.max(sections ? sections.start : text.length, start);
  return { frontmatter, sections, body: { start, end } };
}

/** Offset of the body's first character — the base a body-relative splice adds to. */
export function bodyStart(text: string): number {
  return regionsOf(text).body.start;
}

/** The body substring: frontmatter and `%%%` sections removed, nothing reformatted. */
export function bodyOf(text: string): string {
  const { body } = regionsOf(text);
  return text.slice(body.start, body.end);
}
