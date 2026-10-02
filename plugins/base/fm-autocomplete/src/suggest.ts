import type { FmField, FmValueCount } from "plugin:indexer";

export interface FieldIndex {
  fmFields(): readonly FmField[];
  fmValues(key: string): readonly FmValueCount[];
  noteOf?(id: string): { readonly title: string; readonly folder: string } | undefined;
}

const DOC_LINK = /^doc:\/\/([A-Za-z0-9_-]+)$/;

export interface Suggestion {
  readonly label: string;
  readonly detail: string;
  readonly insert: string;
}

export interface Suggestions {
  readonly replace: number;
  readonly items: readonly Suggestion[];
}

export const MAX_SUGGESTIONS = 20;

const KEY_LINE = /^([A-Za-z0-9_-]{1,64}):[ \t]+(.*)$/;
const KEY_PREFIX = /^[A-Za-z0-9_-]{1,64}$/;

export function suggest(
  lineBeforeCaret: string,
  documentBeforeCaret: string,
  index: FieldIndex,
): Suggestions | undefined {
  if (!inFrontmatter(documentBeforeCaret)) return undefined;
  const text = lineBeforeCaret.replace(/\r$/, "");
  if (KEY_PREFIX.test(text)) return suggestKeys(text, documentBeforeCaret, index.fmFields());
  return suggestValues(text, (key) => index.fmValues(key), (id) => index.noteOf?.(id));
}

function suggestKeys(typed: string, documentBeforeCaret: string, fields: readonly FmField[]): Suggestions | undefined {
  const needle = typed.toLowerCase();
  const present = keysAbove(documentBeforeCaret);
  const ranked: { field: FmField; rank: number }[] = [];
  for (const field of fields) {
    if (field.machineOnly || field.key.includes(".") || present.has(field.key)) continue;
    const lower = field.key.toLowerCase();
    const rank = lower === needle ? 0 : lower.startsWith(needle) ? 1 : lower.includes(needle) ? 2 : -1;
    if (rank >= 0) ranked.push({ field, rank });
  }
  if (ranked.length === 0) return undefined;
  const items = ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ field }) => ({
      label: field.key,
      detail: field.count === 1 ? "in 1 note" : `in ${field.count} notes`,
      insert: `${field.key}: `,
    }));
  return { replace: typed.length, items };
}

function keysAbove(documentBeforeCaret: string): Set<string> {
  const lines = documentBeforeCaret.split("\n").slice(1, -1);
  const keys = new Set<string>();
  for (const line of lines) {
    const key = /^([A-Za-z0-9_-]{1,64}):/.exec(line)?.[1];
    if (key) keys.add(key);
  }
  return keys;
}

function suggestValues(
  text: string,
  valuesOf: (key: string) => readonly FmValueCount[],
  noteOf: (id: string) => { readonly title: string; readonly folder: string } | undefined,
): Suggestions | undefined {
  const line = KEY_LINE.exec(text);
  const key = line?.[1];
  const rest = line?.[2];
  if (key === undefined || rest === undefined) return undefined;

  const typed = typedValue(rest);
  if (!typed) return undefined;

  const needle = unquote(typed.partial).toLowerCase();
  const candidates = valuesOf(key).filter(
    (entry): entry is FmValueCount & { value: string | number | boolean } => entry.value !== null,
  );
  if (candidates.some((entry) => String(entry.value) === unquote(typed.partial))) return undefined;

  const ranked: { entry: (typeof candidates)[number]; rank: number; note?: { title: string; folder: string } }[] = [];
  for (const entry of candidates) {
    const text = String(entry.value);
    if (typed.taken.has(text)) continue;
    const linked = typeof entry.value === "string" ? DOC_LINK.exec(entry.value)?.[1] : undefined;
    const note = linked === undefined ? undefined : noteOf(linked);
    const rankOf = (candidate: string): number => {
      const lower = candidate.toLowerCase();
      return lower.startsWith(needle) ? 0 : lower.includes(needle) ? 1 : -1;
    };
    const ranks = [rankOf(text), ...(note ? [rankOf(note.title)] : [])].filter((rank) => rank >= 0);
    if (ranks.length > 0) ranked.push({ entry, rank: Math.min(...ranks), ...(note ? { note } : {}) });
  }
  if (ranked.length === 0) return undefined;

  const items: Suggestion[] = ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ entry, note }) => {
      const used = entry.count === 1 ? "1 note" : `${entry.count} notes`;
      return {
        label: note ? note.title || "Untitled" : String(entry.value),
        detail: note?.folder ? `${note.folder} · ${used}` : used,
        insert: yamlScalar(entry.value),
      };
    });
  return { replace: typed.partial.length, items };
}

export function inFrontmatter(documentBeforeCaret: string): boolean {
  const text = documentBeforeCaret.startsWith("﻿") ? documentBeforeCaret.slice(1) : documentBeforeCaret;
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length < 2 || lines[0] !== "---") return false;
  return !lines.slice(1, -1).includes("---");
}

interface Typed {
  readonly partial: string;
  readonly taken: ReadonlySet<string>;
}

function typedValue(rest: string): Typed | undefined {
  if (rest.startsWith("{")) return undefined;
  if (!rest.startsWith("[")) return { partial: rest, taken: new Set() };
  const inner = rest.slice(1);
  if (inner.includes("]")) return undefined;
  const items = inner.split(",");
  const partial = (items.pop() ?? "").replace(/^\s+/, "");
  const taken = new Set(items.map((item) => unquote(item.trim())).filter((item) => item.length > 0));
  return { partial, taken };
}

function unquote(text: string): string {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return text;
  return text.slice(1, text.endsWith(quote) && text.length > 1 ? -1 : undefined);
}

const PLAIN = /^[\p{L}\p{N}_./(][\p{L}\p{N} _./()+-]*$/u;
const RETYPES = /^(?:[-+]?(?:\d|\.\d)|(?:true|false|null|~)$)/i;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;

export function yamlScalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  if (ISO.test(value)) return value;
  if (PLAIN.test(value) && !value.endsWith(" ") && !RETYPES.test(value)) return value;
  return JSON.stringify(value);
}
