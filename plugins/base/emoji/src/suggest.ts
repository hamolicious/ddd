import type { Emoji, EmojiSet } from "./emojis.js";

export interface Suggestion {
  readonly emoji: string;
  readonly name: string;
  readonly insert: string;
}

export interface Suggestions {
  readonly replace: number;
  readonly items: readonly Suggestion[];
}

export const MAX_SUGGESTIONS = 20;

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

function inCodeSpan(lineBeforeCaret: string): boolean {
  return ((lineBeforeCaret.match(/`/g)?.length ?? 0) & 1) === 1;
}

export function inFrontmatter(documentBeforeCaret: string): boolean {
  const text = documentBeforeCaret.startsWith("﻿") ? documentBeforeCaret.slice(1) : documentBeforeCaret;
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length < 2 || lines[0] !== "---") return false;
  return !lines.slice(1, -1).includes("---");
}

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
