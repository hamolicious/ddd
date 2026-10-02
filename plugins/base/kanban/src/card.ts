import type { DocumentRow } from "@kernel";

import { DOC_PREFIX } from "../../_shared/conditions.js";
import { fieldValue } from "../../_shared/dates.js";
import { displayRow, inferKind } from "../../_shared/fm-display.js";

export type CardItem =
  | { readonly kind: "title"; readonly hidden?: boolean }
  | { readonly kind: "content"; readonly hidden?: boolean }
  | { readonly kind: "field"; readonly field: string; readonly hidden?: boolean };

export const DEFAULT_CARD: readonly CardItem[] = [{ kind: "title" }];

const FIELD = /^fm\.[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})*$/;

export function itemKey(item: CardItem): string {
  return item.kind === "field" ? item.field : item.kind;
}

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

export function fieldText(row: DocumentRow, field: string): string {
  return fieldParts(row, field)
    .map((part) => (part.kind === "doc" ? `${DOC_PREFIX}${part.id}` : part.text))
    .join(", ");
}

export type FieldPart = { readonly kind: "doc"; readonly id: string } | { readonly kind: "text"; readonly text: string };

export function fieldParts(row: DocumentRow, field: string): readonly FieldPart[] {
  const key = field.slice("fm.".length);
  const value = fieldValue(row, field);
  const shown = displayRow({ key, value, kind: inferKind(key, value) });
  if (shown.empty) return [];
  return (shown.items ?? [shown.text]).map((item) => {
    const id = docLinkId(item);
    return id === undefined ? { kind: "text", text: item } : { kind: "doc", id };
  });
}

function docLinkId(value: string): string | undefined {
  const text = value.trim();
  if (!text.startsWith(DOC_PREFIX)) return undefined;
  const id = text.slice(DOC_PREFIX.length);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}
