/**
 * The properties `auto-fm` adds, and the value each becomes. Pure, so it is tested here
 * rather than through a note.
 *
 * Stored in settings as one JSON line per property, in order: when two name the same key,
 * the first that applies wins.
 */

import type { CoreMap, FmValue } from "@kernel";

import { newClauseId, type Conditions, type FilterClause } from "../../_shared/conditions.js";

/** `create`: only notes made on this device from now on. `edit`: those, and any note edited here. */
export type Trigger = "create" | "edit";

export interface AutoField {
  /** For React keys; not stored. */
  readonly id: string;
  readonly key: string;
  /** As typed: `{{date}}`, `true`, `3`, `[a, b]`, `"quoted text"`. */
  readonly value: string;
  readonly on: Trigger;
  /** Only notes that match; no conditions is every note. */
  readonly when: Conditions;
}

let fieldCounter = 0;
export function newFieldId(): string {
  fieldCounter += 1;
  return `field-${fieldCounter}`;
}

export const NO_CONDITIONS: Conditions = { combine: "and", clauses: [] };

export function newField(): AutoField {
  return { id: newFieldId(), key: "", value: "", on: "create", when: NO_CONDITIONS };
}

/**
 * Could this be a frontmatter key? Kept to what reads back as the same key: no colon,
 * no line break, nothing YAML would take for a comment, list or quote.
 */
export function isKeyShaped(key: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/.test(key) && key.trim() === key;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The placeholders a value may hold, filled in at the moment the property is added. */
export function fillTokens(raw: string, now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return raw
    .replaceAll("{{date}}", date)
    .replaceAll("{{time}}", time)
    .replaceAll("{{now}}", `${date}T${time}`);
}

/** One scalar as YAML would read it: `true`, `3`, `"3"`, `null`, or text. */
function scalar(text: string): FmValue {
  const trimmed = text.trim();
  const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
  if (quoted) return quoted[1] ?? "";
  if (trimmed === "" || trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** The value a property is added with: placeholders filled, then typed; `[a, b]` is a list. */
export function fieldValue(raw: string, now: Date): FmValue {
  const text = fillTokens(raw, now).trim();
  const list = /^\[(.*)\]$/.exec(text);
  if (list) {
    const inside = (list[1] ?? "").trim();
    return inside === "" ? [] : inside.split(",").map(scalar);
  }
  return scalar(text);
}

/**
 * The fields a note should get: those whose trigger covers this change, with a usable key
 * the note does not have yet — present with any value, even empty, counts as having it.
 * One per key, the first listed.
 */
export function wanted(fields: readonly AutoField[], fm: CoreMap, isNew: boolean): readonly AutoField[] {
  const taken = new Set(Object.keys(fm));
  const out: AutoField[] = [];
  for (const field of fields) {
    const key = field.key.trim();
    if (!isKeyShaped(key) || taken.has(key)) continue;
    if (field.on === "create" && !isNew) continue;
    taken.add(key);
    out.push(field);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseClause(raw: unknown): FilterClause | undefined {
  if (!isRecord(raw)) return undefined;
  const { field, op, value, kind, deep, negate } = raw;
  if (typeof field !== "string" || typeof op !== "string" || typeof value !== "string" || typeof kind !== "string") {
    return undefined;
  }
  return {
    id: newClauseId(),
    field,
    op: op as FilterClause["op"],
    value,
    kind: kind as FilterClause["kind"],
    ...(deep === true ? { deep } : {}),
    ...(negate === true ? { negate } : {}),
  };
}

export function parseFields(value: unknown): readonly AutoField[] {
  if (!Array.isArray(value)) return [];
  const fields: AutoField[] = [];
  for (const line of value) {
    if (typeof line !== "string") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw) || typeof raw.key !== "string") continue;
    const when = isRecord(raw.when) ? raw.when : {};
    const clauses = Array.isArray(when.clauses) ? when.clauses.map(parseClause) : [];
    fields.push({
      id: newFieldId(),
      key: raw.key,
      value: typeof raw.value === "string" ? raw.value : "",
      on: raw.on === "edit" ? "edit" : "create",
      when: {
        combine: when.combine === "or" ? "or" : "and",
        clauses: clauses.filter((clause): clause is FilterClause => clause !== undefined),
      },
    });
  }
  return fields;
}

export function serializeFields(fields: readonly AutoField[]): string[] {
  return fields.map((field) =>
    JSON.stringify({
      key: field.key,
      value: field.value,
      on: field.on,
      ...(field.when.clauses.length > 0
        ? {
            when: {
              combine: field.when.combine,
              clauses: field.when.clauses.map(({ field: path, op, value, kind, deep, negate }) => ({
                field: path,
                op,
                value,
                kind,
                ...(deep === true && op === "child_of" ? { deep } : {}),
                ...(negate === true ? { negate } : {}),
              })),
            },
          }
        : {}),
    }),
  );
}

/** The same once stored: ids aside. */
export function sameFields(a: readonly AutoField[], b: readonly AutoField[]): boolean {
  const left = serializeFields(a);
  const right = serializeFields(b);
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
