export interface Note {
  readonly id: string;
  readonly title: string;
  readonly folder: string;
}

export interface Suggestion extends Note {
  readonly insert: string;
}

export interface Suggestions {
  readonly replace: number;
  readonly embed: boolean;
  readonly items: readonly Suggestion[];
}

export const MAX_SUGGESTIONS = 20;

const TYPED = /(!?)\[\[([^[\]\n]*)$/;

export function linkTo(id: string, embed: boolean, frontmatter = false): string {
  return frontmatter ? `doc://${id}` : `${embed ? "!" : ""}[](doc://${id})`;
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
  const frontmatter = inFrontmatter(documentBeforeCaret);
  if (!frontmatter && (inCodeSpan(before) || inFence(documentBeforeCaret))) return undefined;

  const embed = !frontmatter && match[1] === "!";
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
      insert: linkTo(note.id, embed, frontmatter),
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

function inCodeSpan(lineBefore: string): boolean {
  return ((lineBefore.match(/`/g)?.length ?? 0) & 1) === 1;
}

export function inFrontmatter(documentBeforeCaret: string): boolean {
  const text = documentBeforeCaret.startsWith("﻿") ? documentBeforeCaret.slice(1) : documentBeforeCaret;
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length < 2 || lines[0] !== "---") return false;
  return !lines.slice(1, -1).includes("---");
}

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
