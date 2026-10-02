import type { CoreValue } from "@kernel";
import type { SearchSpec } from "plugin:search";

import { yamlScalar } from "../../_shared/yaml.js";

import { writableField } from "./layout.js";

export const CARD_TITLE = "Untitled";

export const STARTER_COLUMNS = "todo,doing,done";

export const BOARD_OPTIONS: Readonly<Record<string, string>> = { columns: STARTER_COLUMNS };

function scalar(value: CoreValue): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return yamlScalar(value);
  return yamlScalar(JSON.stringify(value));
}

export function noteText(title: string, fm: Readonly<Record<string, CoreValue>> = {}): string {
  const lines = Object.entries(fm).map(([key, value]) => `${key}: ${scalar(value)}`);
  return ["---", `title: ${yamlScalar(title)}`, ...lines, "---", ""].join("\n");
}

export interface CardFields {
  readonly parent?: string;
  readonly fm: Readonly<Record<string, CoreValue>>;
}

export function cardFields(
  spec: SearchSpec,
  group: { readonly field: string; readonly value: CoreValue | undefined },
  lane?: { readonly field: string; readonly value: CoreValue | undefined },
): CardFields {
  const fm: Record<string, CoreValue> = {};
  let parent: string | undefined;
  if (spec.filter.combine === "and") {
    for (const clause of spec.filter.clauses) {
      if (clause.negate === true || clause.value.trim() === "") continue;
      if (clause.op === "child_of" && parent === undefined) parent = clause.value.trim();
      else if (clause.op === "eq" && writableField(clause.field)) fm[clause.field.slice(3)] = literal(clause.kind, clause.value);
    }
  }
  if (lane?.value !== undefined && writableField(lane.field)) fm[lane.field.slice(3)] = lane.value;
  if (group.value !== undefined && writableField(group.field)) fm[group.field.slice(3)] = group.value;
  return { ...(parent !== undefined ? { parent } : {}), fm };
}

function literal(kind: string, raw: string): CoreValue {
  const text = raw.trim();
  if (kind === "int" || kind === "float") {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (kind === "bool") return text.toLowerCase() === "true";
  if (kind === "doc") return `doc://${text}`;
  return raw;
}
