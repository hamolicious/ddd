/**
 * What a card shows, pure: a list of items, top to bottom — the title, a property's value,
 * the note's text — each shown or hidden. The title alone by default.
 *
 * Stored in the board's `card` option as a comma list a person can read: `title`,
 * `content`, or a field path (`fm.status`), each prefixed `!` when hidden —
 * `title,fm.status,!content`. At least one item is always shown: a list that would show
 * nothing is read as the default, and the settings never let the last one go.
 */

import type { DocumentRow } from "@kernel";

import { fieldValue } from "../../_shared/dates.js";
import { displayRow, inferKind } from "../../_shared/fm-display.js";
import { bodyOf } from "../../_shared/regions.js";

export type CardItem =
  | { readonly kind: "title"; readonly hidden?: boolean }
  | { readonly kind: "content"; readonly hidden?: boolean }
  | { readonly kind: "field"; readonly field: string; readonly hidden?: boolean };

export const DEFAULT_CARD: readonly CardItem[] = [{ kind: "title" }];

const FIELD = /^fm\.[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})*$/;

export function itemKey(item: CardItem): string {
  return item.kind === "field" ? item.field : item.kind;
}

/** The items the `card` option names; the default when it names none to show. */
export function parseCard(raw: string): readonly CardItem[] {
  const seen = new Set<string>();
  const items: CardItem[] = [];
  for (const part of raw.split(",")) {
    const text = part.trim();
    const hidden = text.startsWith("!");
    const name = hidden ? text.slice(1).trim() : text;
    const item: CardItem | undefined =
      name === "title" ? { kind: "title" } : name === "content" ? { kind: "content" } : FIELD.test(name) ? { kind: "field", field: name } : undefined;
    if (!item || seen.has(itemKey(item))) continue;
    seen.add(itemKey(item));
    items.push(hidden ? { ...item, hidden: true } : item);
  }
  return items.some((item) => item.hidden !== true) ? items : DEFAULT_CARD;
}

export function serializeCard(items: readonly CardItem[]): string {
  return items.map((item) => `${item.hidden === true ? "!" : ""}${itemKey(item)}`).join(",");
}

/** A property's value as a card line: `""` when the note has none. */
export function fieldText(row: DocumentRow, field: string): string {
  const key = field.slice("fm.".length);
  const value = fieldValue(row, field);
  return displayRow({ key, value, kind: inferKind(key, value) }).text;
}

/**
 * The note's text as a card shows it: the body only (no frontmatter, no plugin sections),
 * its markdown reduced to the words — headings, list and quote markers, emphasis, code
 * ticks, images and link targets gone — and runs of space folded. Capped at `limit`
 * characters; the card clamps it to a few lines.
 */
export function excerpt(content: string | undefined, limit = 280): string {
  if (!content) return "";
  const text = bodyOf(content)
    .replace(/^```[^\n]*\n[\s\S]*?(?:\n```|$)/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[^\]]?\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}
