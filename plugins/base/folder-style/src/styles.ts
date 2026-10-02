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
  readonly background?: string;
  readonly icon?: string;
}

export type Styles = ReadonlyMap<string, FolderStyle>;

export function normalizeColor(input: string | undefined): string | undefined {
  const hex = (input ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map((digit) => digit + digit).join("")}`;
  return undefined;
}

const ICON = /^[a-z0-9][a-z0-9-]*$/;

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

export function parseDefaults(background: unknown, icon: unknown): FolderStyle {
  return (
    withStyle(undefined, {
      background: typeof background === "string" ? normalizeColor(background) : undefined,
      icon: typeof icon === "string" && ICON.test(icon) ? icon : undefined,
    }) ?? {}
  );
}

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
  readonly id: string;
  readonly when: Conditions;
  readonly style: FolderStyle;
  readonly name?: string;
}

export function ruleLabel(rule: Rule, index: number): string {
  return rule.name?.trim() || `Rule ${index + 1}`;
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
      ...(typeof raw.name === "string" && raw.name.trim() !== "" ? { name: raw.name.trim() } : {}),
    });
  }
  return rules;
}

export function serializeRules(rules: readonly Rule[]): string[] {
  return rules.map((rule) =>
    JSON.stringify({
      ...(rule.name !== undefined && rule.name.trim() !== "" ? { name: rule.name.trim() } : {}),
      when: {
        combine: rule.when.combine,
        clauses: rule.when.clauses.map(({ field, op, value, kind, deep, negate }) => ({
          field,
          op,
          value,
          kind,
          ...(deep === true && op === "child_of" ? { deep } : {}),
          ...(negate === true ? { negate } : {}),
        })),
      },
      ...(rule.style.background !== undefined ? { background: rule.style.background } : {}),
      ...(rule.style.icon !== undefined ? { icon: rule.style.icon } : {}),
    }),
  );
}

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

function luminance(hex: string): number {
  const channel = (at: number): number => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

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
