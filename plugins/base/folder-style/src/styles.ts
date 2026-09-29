/**
 * Folder looks as they are stored: pure, so tested without a kernel.
 *
 * Settings values are flat (`kernel/src/runtime/settings.ts`), so each note is one line of
 * the `styles` list: `<background> <icon> <note id>`, with `-` for "none".
 * `#e03131 briefcase 01J8Z…`. A note keeps its id through every rename and move, so a look
 * needs no following; one for a note in Trash waits, and is back if the note is restored.
 *
 * Only the background is stored. The text on it is black or white, whichever reads
 * better (`textOn`), so it is worked out rather than chosen.
 *
 * The defaults are two more settings, `defaultBackground` and `defaultIcon`.
 *
 * Rules are a third, `rules`: one JSON line each, conditions and a look —
 * `{"when":{"combine":"and","clauses":[…]},"background":"#e03131","icon":"star"}`.
 *
 * **What a note shows, field by field** (`resolveStyle`): its own, else the first rule it
 * matches that sets the field, else the default. A colour or icon set on the note itself
 * is never overridden.
 */

import {
  CLAUSE_OPS,
  VALUE_KINDS,
  newClauseId,
  type ClauseOp,
  type Conditions,
  type FilterClause,
  type ValueKind,
} from "../../_shared/conditions.js";

export interface FolderStyle {
  /** `#rrggbb`, lower case. */
  readonly background?: string;
  /** An `lm/icons` name. */
  readonly icon?: string;
}

export type Styles = ReadonlyMap<string, FolderStyle>;

/** `#abc`, `#AABBCC` and `aabbcc` → `#aabbcc`; anything else → `undefined`. */
export function normalizeColor(input: string | undefined): string | undefined {
  const hex = (input ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map((digit) => digit + digit).join("")}`;
  return undefined;
}

const ICON = /^[a-z0-9][a-z0-9-]*$/;

/** The stored list; lines that do not parse are dropped, a later line for a note wins. */
export function parseStyles(value: unknown): Styles {
  const styles = new Map<string, FolderStyle>();
  if (!Array.isArray(value)) return styles;
  for (const line of value) {
    if (typeof line !== "string") continue;
    const match = /^(\S+) (\S+) (.+)$/.exec(line);
    if (!match) continue;
    const [, rawBackground = "-", rawIcon = "-", id = ""] = match;
    const background = rawBackground === "-" ? undefined : normalizeColor(rawBackground);
    const icon = rawIcon !== "-" && ICON.test(rawIcon) ? rawIcon : undefined;
    const style = withStyle(undefined, { background, icon });
    if (style) styles.set(id, style);
    else styles.delete(id);
  }
  return styles;
}

/** The two default settings, as stored; either may be empty or not parse, meaning none. */
export function parseDefaults(background: unknown, icon: unknown): FolderStyle {
  return (
    withStyle(undefined, {
      background: typeof background === "string" ? normalizeColor(background) : undefined,
      icon: typeof icon === "string" && ICON.test(icon) ? icon : undefined,
    }) ?? {}
  );
}

/**
 * What a note shows: each field its own, else from the first of `matched` (the looks of
 * the rules it matches, in rule order) that sets it, else the default. `undefined` when
 * nothing has any.
 */
export function resolveStyle(
  style: FolderStyle | undefined,
  defaults: FolderStyle,
  matched: readonly FolderStyle[] = [],
): FolderStyle | undefined {
  const layers = [style, ...matched, defaults];
  return withStyle(undefined, {
    background: layers.find((layer) => layer?.background !== undefined)?.background,
    icon: layers.find((layer) => layer?.icon !== undefined)?.icon,
  });
}

export interface Rule {
  /** For React keys; not stored. */
  readonly id: string;
  readonly when: Conditions;
  readonly style: FolderStyle;
}

let ruleCounter = 0;

export function newRuleId(): string {
  ruleCounter += 1;
  return `rule-${ruleCounter}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseClause(value: unknown): FilterClause | undefined {
  if (!isRecord(value)) return undefined;
  const { field, op, value: text, kind, negate, deep } = value;
  if (typeof field !== "string" || typeof text !== "string") return undefined;
  if (!CLAUSE_OPS.includes(op as ClauseOp) || !VALUE_KINDS.includes(kind as ValueKind)) return undefined;
  return {
    id: newClauseId(),
    field,
    op: op as ClauseOp,
    value: text,
    kind: kind as ValueKind,
    ...(deep === true ? { deep: true } : {}),
    ...(negate === true ? { negate: true } : {}),
  };
}

/** The stored list; a line that does not parse is dropped, and so is a clause within one. */
export function parseRules(value: unknown): readonly Rule[] {
  if (!Array.isArray(value)) return [];
  const rules: Rule[] = [];
  for (const line of value) {
    if (typeof line !== "string") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw) || !isRecord(raw.when)) continue;
    const clauses = Array.isArray(raw.when.clauses) ? raw.when.clauses.map(parseClause) : [];
    rules.push({
      id: newRuleId(),
      when: {
        combine: raw.when.combine === "or" ? "or" : "and",
        clauses: clauses.filter((clause): clause is FilterClause => clause !== undefined),
      },
      style: parseDefaults(raw.background, raw.icon),
    });
  }
  return rules;
}

export function serializeRules(rules: readonly Rule[]): string[] {
  return rules.map((rule) =>
    JSON.stringify({
      when: {
        combine: rule.when.combine,
        clauses: rule.when.clauses.map(({ field, op, value, kind, deep, negate }) => ({
          field,
          op,
          value,
          kind,
          // Only "is inside" reads it; a row switched to another operator drops it.
          ...(deep === true && op === "child_of" ? { deep } : {}),
          ...(negate === true ? { negate } : {}),
        })),
      },
      ...(rule.style.background !== undefined ? { background: rule.style.background } : {}),
      ...(rule.style.icon !== undefined ? { icon: rule.style.icon } : {}),
    }),
  );
}

/** The same once stored: row ids aside. */
export function sameRules(a: readonly Rule[], b: readonly Rule[]): boolean {
  const left = serializeRules(a);
  const right = serializeRules(b);
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

export function sameStyle(a: FolderStyle | undefined, b: FolderStyle | undefined): boolean {
  return a?.background === b?.background && a?.icon === b?.icon;
}

export function serializeStyles(styles: Styles): string[] {
  return [...styles]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, style]) => `${style.background ?? "-"} ${style.icon ?? "-"} ${id}`);
}

/** `base` with `change` laid over it; a field set to `undefined` is cleared. `undefined` when nothing is left. */
export function withStyle(
  base: FolderStyle | undefined,
  change: { readonly background?: string | undefined; readonly icon?: string | undefined },
): FolderStyle | undefined {
  const background = "background" in change ? change.background : base?.background;
  const icon = "icon" in change ? change.icon : base?.icon;
  if (background === undefined && icon === undefined) return undefined;
  return {
    ...(background !== undefined ? { background } : {}),
    ...(icon !== undefined ? { icon } : {}),
  };
}

/** WCAG 2 relative luminance of a `#rrggbb` colour: 0 for black, 1 for white. */
function luminance(hex: string): number {
  const channel = (at: number): number => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Black or white, whichever has more contrast on `background`; white on a tie. */
export function textOn(background: string): "#000000" | "#ffffff" {
  return contrast(background, "#000000") > contrast(background, "#ffffff") ? "#000000" : "#ffffff";
}

export function sameStyles(a: Styles, b: Styles): boolean {
  if (a.size !== b.size) return false;
  for (const [id, style] of a) {
    if (!sameStyle(style, b.get(id))) return false;
  }
  return true;
}
