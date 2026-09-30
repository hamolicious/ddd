/**
 * Line diffs for the folder mirror: the edits that turn one text into another, and a
 * three-way merge for a note changed on disk and in the app at once.
 *
 * Lines keep their `\n`, so joining them gives the text back byte for byte. The diff trims
 * the common head and tail first and runs a longest-common-subsequence table only over
 * what is left; a middle too big for the table is treated as one replaced block, which is
 * still a correct diff, just a coarse one.
 */

import type { TextEdit } from "@kernel";

/** Base lines `[start, end)` replaced by `lines`. */
export interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

/** Past this many table cells the middle is one hunk (about 16 MB of `Uint32Array`). */
const TABLE_LIMIT = 4_000_000;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/(?<=\n)/);
  return lines;
}

/** The hunks that turn `a` into `b`, in order, non-overlapping. */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  if (aMid.length === 0 && bMid.length === 0) return [];
  if (aMid.length === 0 || bMid.length === 0 || (aMid.length + 1) * (bMid.length + 1) > TABLE_LIMIT) {
    return [{ start: head, end: head + aMid.length, lines: bMid }];
  }

  // lcs[i][j] = LCS length of aMid[i..] and bMid[j..], row-major.
  const cols = bMid.length + 1;
  const lcs = new Uint32Array((aMid.length + 1) * cols);
  for (let i = aMid.length - 1; i >= 0; i -= 1) {
    for (let j = bMid.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        aMid[i] === bMid[j]
          ? lcs[(i + 1) * cols + j + 1]! + 1
          : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: { start: number; lines: string[] } | undefined;
  const close = (end: number): void => {
    if (open) hunks.push({ start: head + open.start, end: head + end, lines: open.lines });
    open = undefined;
  };
  while (i < aMid.length || j < bMid.length) {
    if (i < aMid.length && j < bMid.length && aMid[i] === bMid[j]) {
      close(i);
      i += 1;
      j += 1;
    } else if (j < bMid.length && (i === aMid.length || lcs[i * cols + j + 1]! >= lcs[(i + 1) * cols + j]!)) {
      open ??= { start: i, lines: [] };
      open.lines.push(bMid[j]!);
      j += 1;
    } else {
      open ??= { start: i, lines: [] };
      i += 1;
    }
  }
  close(i);
  return hunks;
}

/**
 * The text edits, in `from`'s character offsets, that turn `from` into `to` — one per
 * changed run of lines, so a CRDT merges them with concurrent edits elsewhere in the note.
 */
export function textEdits(from: string, to: string): TextEdit[] {
  if (from === to) return [];
  const a = splitLines(from);
  const offsets: number[] = [0];
  for (const line of a) offsets.push(offsets[offsets.length - 1]! + line.length);
  return diffLines(a, splitLines(to)).map((hunk) => ({
    range: { start: offsets[hunk.start]!, end: offsets[hunk.end]! },
    text: hunk.lines.join(""),
  }));
}

/** Apply edits (in the original's offsets) to a plain string. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((x, y) => y.range.start - x.range.start)) {
    out = out.slice(0, edit.range.start) + edit.text + out.slice(edit.range.end);
  }
  return out;
}

export type MergeResult = { readonly clean: true; readonly text: string } | { readonly clean: false };

/**
 * Three-way merge by lines. Changes to different lines both land; the same change on both
 * sides lands once; different changes to the same or touching lines are a conflict, and
 * the caller keeps both copies rather than guessing.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) return { clean: true, text: ours };
  if (ours === base) return { clean: true, text: theirs };
  if (theirs === base) return { clean: true, text: ours };

  const baseLines = splitLines(base);
  const tagged = [
    ...diffLines(baseLines, splitLines(ours)).map((hunk) => ({ hunk, side: 0 })),
    ...diffLines(baseLines, splitLines(theirs)).map((hunk) => ({ hunk, side: 1 })),
  ].sort((x, y) => x.hunk.start - y.hunk.start || x.hunk.end - y.hunk.end);

  const out: string[] = [];
  let cursor = 0;
  let k = 0;
  while (k < tagged.length) {
    // Group every hunk that overlaps or touches the running span.
    const group = [tagged[k]!];
    let start = tagged[k]!.hunk.start;
    let end = tagged[k]!.hunk.end;
    k += 1;
    while (k < tagged.length && tagged[k]!.hunk.start <= end) {
      group.push(tagged[k]!);
      end = Math.max(end, tagged[k]!.hunk.end);
      k += 1;
    }
    start = Math.min(start, ...group.map((g) => g.hunk.start));
    out.push(...baseLines.slice(cursor, start));

    const sides = new Set(group.map((g) => g.side));
    const replay = (side: number): string[] => {
      const lines: string[] = [];
      let at = start;
      for (const { hunk } of group.filter((g) => g.side === side)) {
        lines.push(...baseLines.slice(at, hunk.start), ...hunk.lines);
        at = hunk.end;
      }
      lines.push(...baseLines.slice(at, end));
      return lines;
    };
    if (sides.size === 1) {
      out.push(...replay(group[0]!.side));
    } else {
      const left = replay(0);
      const right = replay(1);
      if (left.join("") !== right.join("")) return { clean: false };
      out.push(...left);
    }
    cursor = end;
  }
  out.push(...baseLines.slice(cursor));
  return { clean: true, text: out.join("") };
}
