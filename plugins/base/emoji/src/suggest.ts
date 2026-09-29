/**
 * What to suggest for the text before the caret. Pure, so it is tested without an editor.
 *
 * `:` followed by at least two shortcode characters, at the start of a word, opens the
 * list: `:ta` offers `:tada:`, `:taco:`, … Shortcodes that start with the typed text come
 * first, then ones that contain it, then emoji whose tags or description do. Choosing one
 * writes the whole `:shortcode:`. Nothing is offered in the frontmatter, in a fenced code
 * block, or inside an inline code span on the caret's line.
 */

import type { Emoji, EmojiSet } from "./emojis.js";

export interface Suggestion {
  readonly emoji: string;
  readonly name: string;
  /** What replaces the typed `:partial`. */
  readonly insert: string;
}

export interface Suggestions {
  /** How many characters before the caret a chosen suggestion replaces. */
  readonly replace: number;
  readonly items: readonly Suggestion[];
}

export const MAX_SUGGESTIONS = 20;

/** `:` at the start of a word, then the shortcode typed so far, up to the caret. */
const TYPED = /(?:^|[^\p{L}\p{N}_:]):([a-z0-9_+-]{2,})$/u;

export function suggest(lineBeforeCaret: string, documentBeforeCaret: string, set: EmojiSet): Suggestions | undefined {
  const match = TYPED.exec(lineBeforeCaret);
  if (!match) return undefined;
  const typed = match[1]!;
  const before = lineBeforeCaret.slice(0, lineBeforeCaret.length - typed.length - 1);
  if (inCodeSpan(before) || inFrontmatter(documentBeforeCaret) || inFence(documentBeforeCaret)) return undefined;

  const ranked: { emoji: Emoji; name: string; rank: number; at: number }[] = [];
  set.all.forEach((emoji, at) => {
    let best: { name: string; rank: number } | undefined;
    for (const name of emoji.names) {
      const rank = name === typed ? 0 : name.startsWith(typed) ? 1 : name.includes(typed) ? 2 : -1;
      if (rank >= 0 && (!best || rank < best.rank)) best = { name, rank };
    }
    if (!best && emoji.words.includes(typed.replace(/_/g, " "))) best = { name: emoji.names[0]!, rank: 3 };
    if (best) ranked.push({ emoji, ...best, at });
  });
  if (ranked.length === 0) return undefined;
  ranked.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.at - b.at);

  return {
    replace: typed.length + 1,
    items: ranked.slice(0, MAX_SUGGESTIONS).map(({ emoji, name }) => ({
      emoji: emoji.emoji,
      name,
      insert: `:${name}:`,
    })),
  };
}

/** An odd number of backticks before the caret on this line. */
function inCodeSpan(lineBeforeCaret: string): boolean {
  return ((lineBeforeCaret.match(/`/g)?.length ?? 0) & 1) === 1;
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
  const lines = documentBeforeCaret.split("\n");
  for (const line of lines.slice(0, -1)) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) continue;
    if (open === undefined) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = undefined;
  }
  return open !== undefined;
}
