import {
  TEXT_OPS,
  TREE_OPS,
  VALUELESS_OPS,
  buildLiteral,
  clauseProblem,
  splitValues,
  type Conditions,
  type FilterClause,
  type ValueKind,
} from "../../_shared/conditions.js";
import { MACHINE_KEY } from "../../_shared/machine-docs.js";
import type { SearchSort, SearchSpec } from "./api.js";

import type { FilterDraft, FilterGroup } from "./filter.js";
import { sortTokens } from "./results.js";
import { filterOf } from "./spec.js";

const quote = (text: string): string => JSON.stringify(text);

function literalCode(kind: ValueKind, raw: string): string | undefined {
  const literal = buildLiteral(kind, raw);
  if (literal === undefined) return undefined;
  if (literal === "null") return "null";
  const node = literal as { readonly str?: string; readonly int?: number; readonly float?: number; readonly bool?: boolean; readonly date?: string };
  if (node.str !== undefined) return quote(node.str);
  if (node.int !== undefined) return String(node.int);
  if (node.float !== undefined) return String(node.float);
  if (node.bool !== undefined) return String(node.bool);
  if (node.date !== undefined) return `{ date: ${quote(node.date)} }`;
  return undefined;
}

export function clauseArguments(clause: FilterClause): string | undefined {
  if (clauseProblem(clause) !== undefined) return undefined;
  if (TREE_OPS.includes(clause.op)) {
    const id = quote(clause.value.trim());
    return clause.op === "child_of" && clause.deep === true
      ? `"id", "child_of", ${id}, { deep: true }`
      : `"id", ${quote(clause.op)}, ${id}`;
  }
  const field = quote(clause.field.trim());
  const op = quote(clause.op);
  if (VALUELESS_OPS.includes(clause.op)) return `${field}, ${op}`;
  if (TEXT_OPS.includes(clause.op)) return `${field}, ${op}, ${quote(clause.value.trim())}`;
  if (clause.op === "contains_any") {
    const values = splitValues(clause.value).map((value) => literalCode(clause.kind, value));
    if (values.some((value) => value === undefined)) return undefined;
    return `${field}, ${op}, [${values.join(", ")}]`;
  }
  const value = literalCode(clause.kind, clause.value);
  return value === undefined ? undefined : `${field}, ${op}, ${value}`;
}

function clauseExpression(clause: FilterClause): string | undefined {
  const args = clauseArguments(clause);
  if (args === undefined) return undefined;
  return clause.negate === true ? `w.not(w(${args}))` : `w(${args})`;
}

function conditionsExpression(conditions: Conditions): string | undefined {
  const parts = conditions.clauses.map(clauseExpression).filter((part): part is string => part !== undefined);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return `w.${conditions.combine === "or" ? "or" : "and"}(${parts.join(", ")})`;
}

function groupExpression(group: FilterGroup): string | undefined {
  const inner = conditionsExpression(group);
  if (inner === undefined) return undefined;
  return group.negate === true ? `w.not(${inner})` : inner;
}

export function clauseCode(clause: FilterClause): string | undefined {
  const args = clauseArguments(clause);
  if (args === undefined) return undefined;
  return clause.negate === true ? `.where((w) => w.not(w(${args})))` : `.where(${args})`;
}

export function groupCode(group: FilterGroup): string | undefined {
  const expression = groupExpression(group);
  return expression === undefined ? undefined : `.where((w) => ${expression})`;
}

function whereLines(filter: FilterDraft): readonly string[] {
  const groups = filter.groups ?? [];
  if (filter.combine === "or") {
    const parts = [
      ...filter.clauses.map(clauseExpression),
      ...groups.map(groupExpression),
    ].filter((part): part is string => part !== undefined);
    if (parts.length === 0) return [];
    if (parts.length === 1) return [`.where((w) => ${parts[0]})`];
    return [`.where((w) => w.or(${parts.join(", ")}))`];
  }
  return [...filter.clauses.map(clauseCode), ...groups.map(groupCode)].filter((line): line is string => line !== undefined);
}

export function specCode(spec: SearchSpec, sort: SearchSort): string {
  const filter = filterOf(spec);
  const text = spec.query.trim();
  const fuzzy = spec.fuzzy?.trim() ?? "";
  const lines = [
    ".from()",
    ...(text !== "" ? [`.text(${quote(text)})`] : []),
    ...whereLines(filter),
    ...(filter.includeMachine === true ? [] : [`.where((w) => w.not(w(${quote(`fm.${MACHINE_KEY}`)}, "eq", true)))`]),
    ...(fuzzy !== ""
      ? [`.fuzzy(${quote(fuzzy)})`]
      : [`.sort(${sortTokens(sort, text !== "").map(quote).join(", ")})`, ...(text !== "" ? [".snippets()"] : [])]),
  ];
  return ["kernel.search", ...lines.map((line) => `  ${line}`)].join("\n");
}

export type CodeTokenKind = "plain" | "string" | "number" | "constant" | "function" | "property" | "punctuation";

export interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind;
}

const TOKEN = /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b|([A-Za-z_$][\w$]*)|(=>|[()[\]{}.,])|(\s+|.)/gy;

export function codeTokens(code: string): readonly CodeToken[] {
  const tokens: CodeToken[] = [];
  const push = (text: string, kind: CodeTokenKind): void => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && kind === "plain") tokens[tokens.length - 1] = { text: last.text + text, kind };
    else tokens.push({ text, kind });
  };
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(code); match !== null; match = TOKEN.exec(code)) {
    const [whole, string, number, constant, word, punctuation] = match;
    if (string !== undefined) push(string, "string");
    else if (number !== undefined) push(number, "number");
    else if (constant !== undefined) push(constant, "constant");
    else if (word !== undefined) {
      const before = code[match.index - 1];
      const after = code.slice(TOKEN.lastIndex).match(/^\s*\(/) !== null;
      push(word, before === "." && after ? "function" : before === "." || word === "deep" ? "property" : "plain");
    } else if (punctuation !== undefined) push(punctuation, "punctuation");
    else push(whole, "plain");
  }
  return tokens;
}
