import type { FilterJson } from "@kernel";

export type ValueKind = "str" | "int" | "float" | "bool" | "date" | "null" | "doc";

export const DOC_PREFIX = "doc://";

export type ClauseOp =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "any"
  | "every"
  | "text_contains"
  | "text_starts_with"
  | "text_ends_with"
  | "missing"
  | "exists"
  | "is_null"
  | "contains_any"
  | "child_of"
  | "parent_of";

export interface FilterClause {
  readonly id: string;
  readonly field: string;
  readonly op: ClauseOp;
  readonly value: string;
  readonly kind: ValueKind;
  readonly deep?: boolean;
  readonly negate?: boolean;
}

export interface Conditions {
  readonly combine: "and" | "or";
  readonly clauses: readonly FilterClause[];
}

export const CLAUSE_OPS: readonly ClauseOp[] = [
  "eq", "ne", "lt", "lte", "gt", "gte", "contains", "any", "every",
  "text_contains", "text_starts_with", "text_ends_with", "missing", "exists", "is_null",
  "contains_any", "child_of", "parent_of",
];

let clauseCounter = 0;

export function newClauseId(): string {
  clauseCounter += 1;
  return `clause-${clauseCounter}`;
}

export const VALUE_KINDS: readonly ValueKind[] = ["str", "int", "float", "bool", "date", "null", "doc"];

export const VALUELESS_OPS: readonly ClauseOp[] = ["missing", "exists", "is_null"];

export const TEXT_OPS: readonly ClauseOp[] = ["text_contains", "text_starts_with", "text_ends_with"];

export const ORDERING_OPS: readonly ClauseOp[] = ["lt", "lte", "gt", "gte"];

const UNORDERED_KINDS: readonly ValueKind[] = ["bool", "null", "doc"];

export const TREE_OPS: readonly ClauseOp[] = ["child_of", "parent_of"];

export const CHILDREN_FIELD = "plugins.folders.children";

export interface ConditionContext {
  readonly childrenOf?: (id: string) => readonly string[] | undefined;
  readonly native?: boolean;
}

const NOTHING: FilterJson = { cmp: { field: "id", op: "eq", value: { str: "" } } };

export function referencedParents(conditions: Conditions): readonly string[] {
  const ids = conditions.clauses
    .filter((clause) => clause.op === "child_of")
    .map((clause) => clause.value.trim())
    .filter((id) => id !== "");
  return [...new Set(ids)].sort();
}

export function treeToWatch(conditions: Conditions): readonly string[] | "all" {
  const deep = conditions.clauses.some((clause) => clause.op === "child_of" && clause.deep === true && clause.value.trim() !== "");
  return deep ? "all" : referencedParents(conditions);
}

export function descendants(id: string, childrenOf: (id: string) => readonly string[] | undefined): readonly string[] {
  const seen = new Set([id]);
  const found: string[] = [];
  const queue = [id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of childrenOf(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

export function splitValues(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

export interface FieldOption {
  readonly field: string;
  readonly label: string;
  readonly kind?: ValueKind;
  readonly sortable: boolean;
  readonly list?: boolean;
}

export const FIELD_OPTIONS: readonly FieldOption[] = [
  { field: "title", label: "Title", kind: "str", sortable: true },
  { field: "content", label: "Text", kind: "str", sortable: false },
  { field: "created_at", label: "Created", kind: "date", sortable: true },
  { field: "updated_at", label: "Updated", kind: "date", sortable: true },
  { field: "fm.tags", label: "Tags (fm.tags)", sortable: true },
  { field: "fm.status", label: "Status (fm.status)", kind: "str", sortable: true },
  { field: "fm.date", label: "Date (fm.date)", kind: "date", sortable: true },
];

const DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;

export function buildLiteral(kind: ValueKind, raw: string): unknown | undefined {
  const text = raw.trim();
  switch (kind) {
    case "null":
      return "null";
    case "str":
      return text === "" ? undefined : { str: raw };
    case "int": {
      if (!/^[+-]?\d+$/.test(text)) return undefined;
      const value = Number.parseInt(text, 10);
      return Number.isSafeInteger(value) ? { int: value } : undefined;
    }
    case "float": {
      const value = Number.parseFloat(text);
      return text !== "" && Number.isFinite(value) ? { float: value } : undefined;
    }
    case "bool": {
      const lower = text.toLowerCase();
      if (lower === "true") return { bool: true };
      if (lower === "false") return { bool: false };
      return undefined;
    }
    case "doc":
      return text === "" ? undefined : { str: `${DOC_PREFIX}${text}` };
    case "date":
      return DATE_PATTERN.test(text) && calendarValid(text) ? { date: text } : undefined;
    default:
      return undefined;
  }
}

function calendarValid(text: string): boolean {
  const [datePart = ""] = text.split(/[Tt ]/, 1);
  const [yearText = "", monthText = "", dayText = ""] = datePart.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1) return false;
  const lengths = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] ?? 0);
}

const isLeap = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function isFieldPathShaped(field: string): boolean {
  const segments = field.split(".");
  if (segments.length === 0 || segments.length > 7) return false;
  if (!segments.every((segment) => /^[A-Za-z0-9_-]{1,64}$/.test(segment))) return false;
  const root = segments[0] as string;
  if (root === "fm" || root === "plugins") return segments.length >= 2;
  return (
    segments.length === 1 &&
    ["id", "title", "content", "created_at", "updated_at", "deleted_at", "deleted"].includes(root)
  );
}

export function buildClause(clause: FilterClause, context: ConditionContext = {}): FilterJson | undefined {
  const node = TREE_OPS.includes(clause.op)
    ? buildTreeNode(clause, context)
    : isFieldPathShaped(clause.field.trim())
      ? buildClauseNode(clause, clause.field.trim())
      : undefined;
  if (!node) return undefined;
  return clause.negate === true ? { not: node } : node;
}

function buildTreeNode(clause: FilterClause, context: ConditionContext): FilterJson | undefined {
  const id = clause.value.trim();
  if (id === "") return undefined;
  if (clause.op === "parent_of") return { contains: { field: CHILDREN_FIELD, value: { str: id } } };
  if (context.native === true) return { child_of: { of: id, ...(clause.deep === true ? { deep: true } : {}) } };
  const childrenOf = context.childrenOf ?? (() => undefined);
  const children = clause.deep === true ? descendants(id, childrenOf) : (childrenOf(id) ?? []);
  if (children.length === 0) return NOTHING;
  return { in: { field: "id", values: children.map((child) => ({ str: child })) } };
}

function buildClauseNode(clause: FilterClause, field: string): FilterJson | undefined {
  if (VALUELESS_OPS.includes(clause.op)) {
    switch (clause.op) {
      case "missing":
        return { missing: { field } };
      case "exists":
        return { exists: { field } };
      default:
        return { is_null: { field } };
    }
  }

  if (TEXT_OPS.includes(clause.op)) {
    if (clause.kind !== "str") return undefined;
    const value = clause.value.trim();
    if (value === "") return undefined;
    const mode =
      clause.op === "text_contains"
        ? "contains"
        : clause.op === "text_starts_with"
          ? "starts_with"
          : "ends_with";
    return { text: { field, mode, value } };
  }

  if (clause.op === "contains_any") {
    const literals = splitValues(clause.value).map((value) => buildLiteral(clause.kind, value));
    if (literals.length === 0 || literals.some((literal) => literal === undefined)) return undefined;
    const nodes = literals.map((value) => ({ contains: { field, value } }));
    return nodes.length === 1 ? nodes[0] : { or: nodes };
  }

  const literal = buildLiteral(clause.kind, clause.value);
  if (literal === undefined) return undefined;

  if (ORDERING_OPS.includes(clause.op) && UNORDERED_KINDS.includes(clause.kind)) {
    return undefined;
  }

  switch (clause.op) {
    case "contains":
      return { contains: { field, value: literal } };
    case "any":
      return { any: { field, op: "eq", value: literal } };
    case "every":
      return { every: { field, op: "eq", value: literal } };
    default:
      return { cmp: { field, op: clause.op, value: literal } };
  }
}

export function buildConditions(conditions: Conditions, context: ConditionContext = {}): FilterJson | undefined {
  const nodes: FilterJson[] = [];

  for (const clause of conditions.clauses) {
    const node = buildClause(clause, context);
    if (node) nodes.push(node);
  }

  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0];
  return conditions.combine === "or" ? { or: nodes } : { and: nodes };
}

export function clauseProblem(clause: FilterClause): string | undefined {
  if (TREE_OPS.includes(clause.op)) return clause.value.trim() === "" ? "Choose a note." : undefined;

  const field = clause.field.trim();
  if (field === "") return "Name a property, such as fm.status.";
  if (!isFieldPathShaped(field)) {
    return "That is not a property path. Try title, updated_at or fm.something.";
  }

  if (VALUELESS_OPS.includes(clause.op)) return undefined;

  if (TEXT_OPS.includes(clause.op)) {
    if (clause.kind !== "str") return "Text matching needs the text value type.";
    return clause.value.trim() === "" ? "Type the text to match." : undefined;
  }

  if (ORDERING_OPS.includes(clause.op) && UNORDERED_KINDS.includes(clause.kind)) {
    return "Before and after do not apply to true/false, null or a document.";
  }

  if (clause.op === "contains_any") {
    const values = splitValues(clause.value);
    if (values.length === 0) return "Type the values, separated by commas.";
    const bad = values.find((value) => buildLiteral(clause.kind, value) === undefined);
    if (bad !== undefined) return `"${bad}" cannot be used with this value type.`;
    return undefined;
  }

  if (buildLiteral(clause.kind, clause.value) === undefined) {
    if (clause.kind === "doc") return "Choose a note.";
    if (clause.value.trim() === "") return "Type a value to compare against.";
    switch (clause.kind) {
      case "date":
        return "That is not a date. Try 2026-09-23.";
      case "int":
        return "That is not a whole number.";
      case "float":
        return "That is not a number.";
      case "bool":
        return "Type true or false.";
      default:
        return "That value cannot be used here.";
    }
  }
  return undefined;
}

export function describeClause(clause: FilterClause): string {
  const labels: Readonly<Record<ClauseOp, string>> = {
    eq: "is",
    ne: "is not",
    lt: "is before/less than",
    lte: "is at most",
    gt: "is after/greater than",
    gte: "is at least",
    contains: "list contains",
    any: "any item is",
    every: "every item is",
    text_contains: "contains",
    text_starts_with: "starts with",
    text_ends_with: "ends with",
    missing: "is missing",
    exists: "exists",
    is_null: "is null",
    contains_any: "list contains any of",
    child_of: clause.deep === true ? "is anywhere inside" : "is inside",
    parent_of: "contains note",
  };
  const head = TREE_OPS.includes(clause.op) ? labels[clause.op] : `${clause.field} ${labels[clause.op]}`;
  const tail = VALUELESS_OPS.includes(clause.op) ? "" : ` ${clause.value}`;
  return `${clause.negate === true ? "not " : ""}${head}${tail}`;
}
