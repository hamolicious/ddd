/**
 * Reading a typed value back out of what the user typed, plus the date picker's halves
 * and the key rules the "add property" row enforces.
 *
 * **Which kind of value a key holds, and how to order the rows, moved to
 * `_shared/fm-display.ts`** and is re-exported below. Two plugins render `fm` — this
 * panel and `viewer`'s read-mode header — and a key that is a date in one and a string
 * in the other is the bug that file exists to prevent. Nothing about the answers
 * changed; only where they are decided. A third-party plugin that cannot import the
 * base distribution's internal file gets the same answers through this plugin's API
 * (`PropertiesApi.display`).
 *
 * What is left here is the *write* half, and it is pure, total, unit-tested, and
 * deliberately aligned with the shared core's **strict YAML subset**
 * (`crates/core/README.md` §2) rather than with JavaScript's idea of types. That
 * alignment is the whole point: the panel writes *value text* into the document with a
 * splice, the server re-parses that text with the Rust core, and the projection comes
 * back with whatever type the core decided. If `parseScalarInput` disagreed with the
 * core — if it wrote `12` meaning a string — the row would come back a number and the
 * panel would appear to have changed the type behind the user's back.
 *
 * So the rules here are the core's rules:
 *
 * - `true`/`True`/`TRUE` (and the `false` family) are booleans; nothing else is.
 * - `null`/`Null`/`NULL`/`~`/empty are null.
 * - Unquoted digits are int or float; `1e3` is a float.
 * - Quoting is how a user forces a string: `"12"` is the string `12`.
 * - A date is an ISO-8601 string. It stays a *string* in YAML terms — the core
 *   canonicalizes it at materialization (SPEC §3.4) — which is why `date` is a
 *   presentation kind there and not a separate wire type.
 */

import type { CoreValue } from "@kernel";

import { ISO_DATE_ONLY, isIsoDateLike } from "../../_shared/fm-display.js";

export {
  PREFERRED_KEY_ORDER,
  formatScalar,
  inferKind,
  isDateKey,
  isIsoDateLike,
  rowsFromFm,
  type PropertyKind,
  type PropertyRow,
} from "../../_shared/fm-display.js";

// ---------------------------------------------------------------------------
// text ⇄ value
// ---------------------------------------------------------------------------

const BOOL_TRUE = new Set(["true", "True", "TRUE"]);
const BOOL_FALSE = new Set(["false", "False", "FALSE"]);
const NULLISH = new Set(["", "null", "Null", "NULL", "~"]);
const INT = /^[+-]?\d+$/;
const FLOAT = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Read a scalar the way the core's YAML subset would read it.
 *
 * Quoting is preserved as an escape hatch and consumed here: a user who types `"12"`
 * means the string, and the splice helper will re-quote it on the way into the document.
 */
export function parseScalarInput(raw: string): CoreValue {
  const text = raw.trim();
  if (NULLISH.has(text)) return null;
  if (BOOL_TRUE.has(text)) return true;
  if (BOOL_FALSE.has(text)) return false;
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    const inner = text.slice(1, -1);
    return text.startsWith("'") ? inner.replace(/''/g, "'") : inner;
  }
  if (INT.test(text)) {
    const value = Number(text);
    // Beyond 2^53 the number is not the number the user typed; keep their text.
    return Number.isSafeInteger(value) ? value : raw.trim();
  }
  if (FLOAT.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : raw.trim();
  }
  return raw.trim();
}

/*
 * `formatScalar` — what a text control shows for a value, and the inverse of
 * {@link parseScalarInput} — is re-exported from `_shared/fm-display.ts` at the top of
 * this file. It is the *unprettified* form on purpose: the panel's controls have to
 * round-trip through `parseScalarInput`, so a date must come back as the text the
 * document holds, not as "Sep 23, 2026". The read-mode header's prettified form is
 * `fmDisplayRows` in the same module.
 */

/**
 * Split a comma-separated list the way a YAML flow sequence reads, respecting quotes
 * and nested brackets so `tags: [a, "b, c"]` survives a round trip through the control.
 */
export function parseListInput(raw: string): readonly CoreValue[] {
  const items: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let current = "";
  for (const character of raw) {
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[" || character === "{") depth++;
    if (character === "]" || character === "}") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item.length > 0).map(parseScalarInput);
}

// ---------------------------------------------------------------------------
// the date picker's halves
// ---------------------------------------------------------------------------

export interface DateParts {
  /** `YYYY-MM-DD`, or `""` when there is no usable date. */
  readonly date: string;
  /** `HH:MM` when the value carries a time; `undefined` for a date-only value. */
  readonly time?: string;
}

/** Split an ISO value into what `<input type="date">` and `<input type="time">` want. */
export function splitDateValue(value: CoreValue | undefined): DateParts {
  if (typeof value !== "string" || !isIsoDateLike(value)) return { date: "" };
  const dateOnly = ISO_DATE_ONLY.exec(value);
  if (dateOnly) return { date: value };
  // `Date` is the browser's parser, not a second implementation of ours: the value is
  // already known to be ISO-8601, and the halves below are UI state, never stored.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { date: value.slice(0, 10) };
  return { date: isoDate(parsed), time: isoTime(parsed) };
}

/**
 * Build the value to store.
 *
 * With no time this is `YYYY-MM-DD` — already one of the two canonical shapes, so no
 * conversion happens and no timezone is involved. With a time, the local wall clock the
 * picker collected is converted to the canonical UTC form, which is what makes
 * lexicographic sorting chronological (SPEC §3.4).
 */
export function joinDateValue(date: string, time?: string): string {
  if (!ISO_DATE_ONLY.test(date)) return date;
  if (!time || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return date;
  const local = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`);
  if (Number.isNaN(local.getTime())) return date;
  return local.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
const isoDate = (value: Date): string =>
  `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
const isoTime = (value: Date): string => `${pad(value.getHours())}:${pad(value.getMinutes())}`;

/**
 * Frontmatter keys must match `^[A-Za-z0-9_-]{1,64}$` — a key outside it is dropped
 * from `fm` with the text left untouched and `fm_parse_error` set (SPEC §3.4). The
 * "add property" row refuses such a key up front rather than writing a line that
 * silently never materializes.
 */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function keyProblem(key: string, existing: readonly string[] = []): string | undefined {
  const trimmed = key.trim();
  if (trimmed.length === 0) return "A property needs a name.";
  if (!KEY_PATTERN.test(trimmed)) {
    return "A name may use letters, digits, underscore and hyphen only, up to 64 characters.";
  }
  if (existing.includes(trimmed)) return `“${trimmed}” is already set on this document.`;
  return undefined;
}
