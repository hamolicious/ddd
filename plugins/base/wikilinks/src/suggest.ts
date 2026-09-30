/**
 * What to offer for the text before the caret. Pure, so it is tested without an editor.
 *
 * `[[` opens the list, and `![[` opens it to embed: what follows, up to the caret, is
 * matched against note titles. Titles that start with the typed text come first, then
 * ones with a word that does, then ones that contain it, then notes whose folder does.
 * Choosing one writes `[](doc://<id>)` (or `![](doc://<id>)`), link text left empty so
 * read mode draws the note's live title and a rename never leaves a stale label behind.
 * Nothing is offered in the frontmatter, in a fenced code block, or inside an inline
 * code span on the caret's line.
 */

export interface Note {
  readonly id: string;
  readonly title: string;
  /** The folders above it, joined by ` / `; `""` at the root. */
  readonly folder: string;
}

export interface Suggestion extends Note {
  /** What replaces the typed `[[partial`. */
  readonly insert: string;
}

export interface Suggestions {
  /** How many characters before the caret a chosen suggestion replaces. */
  readonly replace: number;
  readonly embed: boolean;
  readonly items: readonly Suggestion[];
}

export const MAX_SUGGESTIONS = 20;

/** `[[` or `![[`, then anything but brackets, up to the caret. */
const TYPED = /(!?)\[\[([^[\]\n]*)$/;

/** The markdown a chosen note is written as. */
export function linkTo(id: string, embed: boolean): string {
  return `${embed ? "!" : ""}[](doc://${id})`;
}

export function suggest(
  lineBeforeCaret: string,
  documentBeforeCaret: string,
  notes: readonly Note[],
  self?: string,
): Suggestions | undefined {
  const match = TYPED.exec(lineBeforeCaret);
  if (!match) return undefined;
  const before = lineBeforeCaret.slice(0, match.index);
  if (inCodeSpan(before) || inFrontmatter(documentBeforeCaret) || inFence(documentBeforeCaret)) return undefined;

  const embed = match[1] === "!";
  const typed = (match[2] ?? "").trim().toLowerCase();
  const ranked: { note: Note; rank: number; at: number }[] = [];
  notes.forEach((note, at) => {
    if (note.id === self) return;
    const rank = rankOf(note, typed);
    if (rank >= 0) ranked.push({ note, rank, at });
  });
  if (ranked.length === 0) return undefined;
  ranked.sort((a, b) => a.rank - b.rank || a.at - b.at);

  return {
    replace: match[0].length,
    embed,
    items: ranked.slice(0, MAX_SUGGESTIONS).map(({ note }) => ({
      id: note.id,
      title: note.title,
      folder: note.folder,
      insert: linkTo(note.id, embed),
    })),
  };
}

function rankOf(note: Note, typed: string): number {
  if (typed === "") return 0;
  const title = note.title.toLowerCase();
  if (title.startsWith(typed)) return 0;
  if (title.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(typed))) return 1;
  if (title.includes(typed)) return 2;
  if (note.folder.toLowerCase().includes(typed)) return 3;
  return -1;
}

/** An odd number of backticks before the `[[` on this line. */
function inCodeSpan(lineBefore: string): boolean {
  return ((lineBefore.match(/`/g)?.length ?? 0) & 1) === 1;
}

/** The document opens with `---` and no closing `---` comes before the caret's line. */
export function inFrontmatter(documentBeforeCaret: string): boolean {
  const text = documentBeforeCaret.startsWith("﻿") ? documentBeforeCaret.slice(1) : documentBeforeCaret;
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length < 2 || lines[0] !== "---") return false;
  return !lines.slice(1, -1).includes("---");
}

/** An odd number of ``` / ~~~ fence lines above the caret's line. */
function inFence(documentBeforeCaret: string): boolean {
  let open: string | undefined;
  for (const line of documentBeforeCaret.split("\n").slice(0, -1)) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) continue;
    if (open === undefined) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = undefined;
  }
  return open !== undefined;
}
