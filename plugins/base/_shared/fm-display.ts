/**
 * **What kind of thing a frontmatter value is, and how to show one to a reader.**
 *
 * `viewer` draws the read-mode properties header above the body from this file. It
 * lives in `_shared` rather than in `viewer` because any plugin that renders `fm` must
 * agree with it: a key that is a date in one place and a string in another is the same
 * class of bug `_shared/machine-docs.ts` exists to prevent — a sidebar counting twelve
 * above a list of eleven — so the typing rules live here once.
 *
 * This is **a convention plugins share, not a kernel concept** (SPEC §2: the kernel
 * knows one domain model, a document is text). Nothing here is written to a document,
 * nothing here is compared against the server, and `PropertyKind` is not a wire type:
 * it is a decision about which control or which rendering a value gets.
 *
 * The rules are deliberately aligned with the shared core's **strict YAML subset**
 * (`crates/core/README.md` §2) rather than with JavaScript's idea of types, because
 * the text comes from YAML and anything that writes a value back does so with a splice
 * the Rust core re-parses. A date is an ISO-8601 **string** in YAML terms — the core canonicalizes
 * it at materialization (SPEC §3.4) — which is why `date` is a presentation kind here
 * and not a separate wire type.
 *
 * Two halves, with a line between them:
 *
 * - **Typing and ordering** ({@link inferKind}, {@link rowsFromFm}).
 * - **Display formatting** ({@link fmDisplayRows}) — used by the read-mode header and
 *   by anything else that shows a value it cannot edit. Every function is pure, total
 *   and DOM-free; the markup is the consuming plugin's business.
 */

import type { CoreValue } from "@kernel";

// ---------------------------------------------------------------------------
// typing and ordering
// ---------------------------------------------------------------------------

/** What kind of value a key holds. `date` is a presentation refinement of `string`. */
export type PropertyKind = "string" | "number" | "boolean" | "date" | "array" | "map" | "null";

export interface PropertyRow {
  readonly key: string;
  readonly value: CoreValue | undefined;
  readonly kind: PropertyKind;
}

/**
 * Keys that come first, in this order. Everything else sorts alphabetically after
 * them — `title` and `path` are the two the whole app reads (title resolution, the
 * folder tree), so burying them under `aliases` would be perverse.
 */
export const PREFERRED_KEY_ORDER: readonly string[] = [
  "title",
  "path",
  "date",
  "due",
  "status",
  "tags",
  "aliases",
];

/** Keys whose value is a date even when it is currently empty or malformed. */
const DATE_KEY = /(^|_)date$|^due$|^created$|^updated$|_at$/;

/** `YYYY-MM-DD`. Exported because the date picker splits on the same shape. */
export const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?(?:\d{2})?)?$/;

export function isDateKey(key: string): boolean {
  return DATE_KEY.test(key);
}

/**
 * Is this string an ISO-8601 date the core would recognise?
 *
 * Calendar validity is checked, because the core checks it: `2026-02-30` does not parse
 * there, so treating it as a date here would put a date picker on a string and lose the
 * user's text the first time they touched the control.
 */
export function isIsoDateLike(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_ONLY.exec(value) ?? ISO_DATE_TIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > daysInMonth(year, month)) return false;
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  return hour <= 23 && minute <= 59 && second <= 60;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Which control — or which rendering — a key/value pair wants. */
export function inferKind(key: string, value: CoreValue | undefined): PropertyKind {
  if (value === undefined || value === null) return isDateKey(key) ? "date" : "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return isIsoDateLike(value) || isDateKey(key) ? "date" : "string";
  return "map";
}

/** One row per frontmatter key, preferred keys first, then alphabetical. */
export function rowsFromFm(
  fm: Readonly<Record<string, CoreValue>> | undefined,
): readonly PropertyRow[] {
  const entries = Object.entries(fm ?? {});
  const rank = (key: string): number => {
    const index = PREFERRED_KEY_ORDER.indexOf(key);
    return index === -1 ? PREFERRED_KEY_ORDER.length : index;
  };
  return entries
    .map(([key, value]) => ({ key, value, kind: inferKind(key, value) }))
    .sort((a, b) => {
      const byRank = rank(a.key) - rank(b.key);
      if (byRank !== 0) return byRank;
      return a.key.localeCompare(b.key, "en", { sensitivity: "base" }) || a.key.localeCompare(b.key);
    });
}

/** What a text control shows for a value — the round-trippable, unprettified form. */
export function formatScalar(value: CoreValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => formatScalar(item)).join(", ");
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// display formatting (read-only)
// ---------------------------------------------------------------------------

/** A row of the read-mode properties header. Markup is the caller's business. */
export interface FmDisplayRow {
  readonly key: string;
  readonly kind: PropertyKind;
  /** The value as stored, for a `title` attribute or a `datetime`. */
  readonly raw: string;
  /** What to print. `""` when there is nothing to print — see {@link empty}. */
  readonly text: string;
  /** One string per item, when the value is a list. Absent otherwise. */
  readonly items?: readonly string[];
  /** The value carries nothing a reader can see: `null`, `""`, or an empty list. */
  readonly empty: boolean;
}

/**
 * The read-mode header's rows, in the panel's order.
 *
 * Every key is kept, including ones whose value is empty: a `due` with no date is a
 * fact about the document, and dropping the row would hide which properties exist. `empty` is how the caller decides
 * to grey one out rather than a reason to hide it.
 */
export function fmDisplayRows(
  fm: Readonly<Record<string, CoreValue>> | undefined,
): readonly FmDisplayRow[] {
  return rowsFromFm(fm).map(displayRow);
}

/** {@link fmDisplayRows} for one key. */
export function displayRow(row: PropertyRow): FmDisplayRow {
  const raw = formatScalar(row.value);

  if (row.kind === "array") {
    const items = (Array.isArray(row.value) ? row.value : [])
      .map((item) => formatScalar(item))
      .filter((item) => item.length > 0);
    return {
      key: row.key,
      kind: row.kind,
      raw,
      text: items.join(", "),
      items,
      empty: items.length === 0,
    };
  }

  if (row.value === undefined || row.value === null || raw.length === 0) {
    return { key: row.key, kind: row.kind, raw, text: "", empty: true };
  }

  if (row.kind === "boolean") {
    return {
      key: row.key,
      kind: row.kind,
      raw,
      text: row.value === true ? "Yes" : "No",
      empty: false,
    };
  }

  if (row.kind === "date") {
    return { key: row.key, kind: row.kind, raw, text: formatDateValue(raw), empty: false };
  }

  return { key: row.key, kind: row.kind, raw, text: raw, empty: false };
}

/**
 * An ISO date as a person reads it, in their own locale.
 *
 * **A date-only value is never put through `new Date(string)`.** That parses
 * `2026-09-23` as UTC midnight, and west of Greenwich `toLocaleDateString` then prints
 * the 22nd — a document dated "yesterday" for half the planet. The components are read
 * out of the text and handed to a *local* `Date`, which is the only construction that
 * cannot shift the day.
 *
 * Anything that is not a date the core would recognise is returned unchanged: the
 * header shows what the document says rather than inventing a reading of it.
 */
export function formatDateValue(value: string): string {
  // Validity first, and that ordering is the whole correctness of this function: the
  // shape check alone accepts `2026-02-30`, and a local `Date` built from those
  // components rolls it forward and prints "2 Mar 2026" — a date the document does not
  // contain, shown as though it did. `isIsoDateLike` is the core's calendar rule.
  if (!isIsoDateLike(value)) return value;

  const dateOnly = ISO_DATE_ONLY.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const local = new Date(year, Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    /*
     * `new Date(26, 0, 1)` is **1926**, not year 26: the multi-argument constructor
     * applies JavaScript's two-digit-year rule to any year 0–99, so `0026-01-01` — four
     * digits, a real month and a real day, so `isIsoDateLike` says yes — printed as
     * "1 Jan 1926". That is the failure this function exists to prevent, one line up
     * from the `2026-02-30` guard that prevents the other one: a date the document does
     * not contain, shown as though it did. `setFullYear` is the documented way out, and
     * it is applied unconditionally because it is a no-op for every other year.
     */
    local.setFullYear(year);
    return Number.isNaN(local.getTime())
      ? value
      : local.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
