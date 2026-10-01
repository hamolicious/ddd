/**
 * Conditions: rows a person fills in ("fm.status is open"), turned into the filter DSL.
 * Shared by `search` (its filter bar) and `folder-style` (its styling rules), with the
 * row editor in `conditions-editor.tsx`.
 *
 * **The DSL is ours, not Mongo's** (SPEC §4.2), and the reason this file is pure and
 * unit-tested is that the same JSON is evaluated in two places: locally by the shared
 * Wasm evaluator over the projection, and — for scripts and integrations — compiled to a
 * Mongo query on the server. A filter this builder emits that the core would reject is
 * not a cosmetic bug: it either 400s or silently matches nothing.
 *
 * So every rule the grammar states is enforced *here*, before anything is emitted:
 *
 * - **Literals are tagged**: `{"str": "x"}`, `{"int": 3}`, `{"float": 1.5}`,
 *   `{"bool": true}`, `{"date": "2026-01-01"}`, and the bare string `"null"`.
 * - **A date literal must parse**, or the whole filter is rejected — so an unfinished
 *   `2026-0` in a text box produces *no clause*, not a 400.
 * - **No implicit array matching, ever.** `contains` is the only way to ask about a list
 *   field, and a `cmp` against a list is false in both directions.
 * - **`missing` is not `null`.** They are separate nodes, offered as separate operators,
 *   because the difference is the whole point of the explicit design.
 * - **Ordering operators are refused against `bool` and `null` literals**, matching what
 *   both the evaluator and the compiler refuse.
 *
 * The one thing it deliberately does not do is validate field *paths* beyond their
 * shape: `fm.anything` is legal and dynamic, and a typo there simply matches nothing —
 * which is the documented behaviour for dynamic fields.
 */

import type { FilterJson } from "@kernel";

/** The value families the DSL compares. `"null"` is the bare-string literal. */
export type ValueKind = "str" | "int" | "float" | "bool" | "date" | "null" | "doc";

/**
 * A `doc` value is a note id, matched as the `doc://<id>` a frontmatter field holds when
 * it points at a note (`parent: doc://01J…`) — the form the indexer counts as a
 * connection. It is a `str` literal on the wire; only the editor and the prefix differ.
 */
export const DOC_PREFIX = "doc://";

/** Operators a clause row can offer. Each maps to exactly one DSL node. */
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
  /** Stable row id, for React keys. Not part of the emitted JSON. */
  readonly id: string;
  /** A dotted projection path: `title`, `fm.status`, `plugins.calendar.uid`. */
  readonly field: string;
  readonly op: ClauseOp;
  /** The raw text the user typed. Ignored by the value-less operators. */
  readonly value: string;
  readonly kind: ValueKind;
  /** For `child_of`: anywhere below the note, not only directly in it. */
  readonly deep?: boolean;
  /** Wrap the clause in `not`. */
  readonly negate?: boolean;
}

/** A set of rows and how they combine. */
export interface Conditions {
  readonly combine: "and" | "or";
  readonly clauses: readonly FilterClause[];
}

/** Every operator, for checking one that was stored. */
export const CLAUSE_OPS: readonly ClauseOp[] = [
  "eq", "ne", "lt", "lte", "gt", "gte", "contains", "any", "every",
  "text_contains", "text_starts_with", "text_ends_with", "missing", "exists", "is_null",
  "contains_any", "child_of", "parent_of",
];

let clauseCounter = 0;

/** A fresh row id. Ids are for React keys and are never stored. */
export function newClauseId(): string {
  clauseCounter += 1;
  return `clause-${clauseCounter}`;
}

/** Every value family, likewise. */
export const VALUE_KINDS: readonly ValueKind[] = ["str", "int", "float", "bool", "date", "null", "doc"];

/** Operators that take no value. */
export const VALUELESS_OPS: readonly ClauseOp[] = ["missing", "exists", "is_null"];

/** Operators that only make sense against a string field. */
export const TEXT_OPS: readonly ClauseOp[] = ["text_contains", "text_starts_with", "text_ends_with"];

/** Ordering operators, refused against `bool`/`null` literals by both engines. */
export const ORDERING_OPS: readonly ClauseOp[] = ["lt", "lte", "gt", "gte"];

/** Value kinds an ordering operator refuses: both engines for bool and null; a document has no order. */
const UNORDERED_KINDS: readonly ValueKind[] = ["bool", "null", "doc"];

/**
 * Operators about the folder tree, whose value is a note id and which ignore the field.
 * The tree is the `children` list in each note's `%%% folders` section, so:
 *
 * - **`parent_of`** X is "my list holds X": a `contains` on {@link CHILDREN_FIELD}.
 * - **`child_of`** X is "X's list holds me", which the DSL cannot join, so it is built
 *   from X's list as the caller last saw it ({@link ConditionContext}), as an `in` of
 *   ids. With `deep`, from X's children, theirs, and so on down. Callers keep the lists
 *   live (`watchChildren` in `conditions-children.ts`): the named notes' for a direct
 *   `child_of`, every note's that has children for a deep one ({@link treeToWatch}).
 */
export const TREE_OPS: readonly ClauseOp[] = ["child_of", "parent_of"];

/** Where `folders` keeps a note's children in the projection. */
export const CHILDREN_FIELD = "plugins.folders.children";

/** What a clause needs from outside the row: the children of the notes `child_of` names. */
export interface ConditionContext {
  /** `undefined` for a note not (yet) seen. */
  readonly childrenOf?: (id: string) => readonly string[] | undefined;
  /**
   * Emit `child_of` as the DSL's own node (`{"child_of": {"of", "deep"}}`), which the
   * query engine joins over the folder tree itself — no `childrenOf` needed. Only for a
   * filter that goes to `documents.query` / `queryPlan`: a row-by-row evaluation
   * (`filters.matches`) cannot answer it.
   */
  readonly native?: boolean;
}

/** A node that matches no row: no document has an empty id. */
const NOTHING: FilterJson = { cmp: { field: "id", op: "eq", value: { str: "" } } };

/** The notes `child_of` clauses name, so a caller can watch their lists. */
export function referencedParents(conditions: Conditions): readonly string[] {
  const ids = conditions.clauses
    .filter((clause) => clause.op === "child_of")
    .map((clause) => clause.value.trim())
    .filter((id) => id !== "");
  return [...new Set(ids)].sort();
}

/**
 * The lists `conditions` need: `"all"` — every note with children — when any `child_of`
 * is deep, since a subtree reaches notes nobody named; else the named notes'.
 */
export function treeToWatch(conditions: Conditions): readonly string[] | "all" {
  const deep = conditions.clauses.some((clause) => clause.op === "child_of" && clause.deep === true && clause.value.trim() !== "");
  return deep ? "all" : referencedParents(conditions);
}

/** Every note below `id`, nearest first; a loop in the lists is walked once. */
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

/** `"a, b ,c"` → `["a", "b", "c"]`: the values of a `contains_any`. */
export function splitValues(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

export interface FieldOption {
  readonly field: string;
  readonly label: string;
  /** The value family the projection guarantees, when it guarantees one. */
  readonly kind?: ValueKind;
  /** `false` ⇒ the server refuses to sort on it (SPEC §4.2 / backend/README.md). */
  readonly sortable: boolean;
  /** Holds a list, so "list contains" is the question to ask. Known only from the index. */
  readonly list?: boolean;
}

/**
 * The fixed roots of the field space, plus the two dynamic prefixes as hints.
 *
 * `content` is filterable but **not sortable**, and `deleted` is neither sortable nor
 * useful here (the Trash view owns it) — both per the shared core's own rules, so the UI
 * offers exactly what the engines accept.
 */
export const FIELD_OPTIONS: readonly FieldOption[] = [
  { field: "title", label: "Title", kind: "str", sortable: true },
  { field: "content", label: "Text", kind: "str", sortable: false },
  { field: "created_at", label: "Created", kind: "date", sortable: true },
  { field: "updated_at", label: "Updated", kind: "date", sortable: true },
  { field: "fm.tags", label: "Tags (fm.tags)", sortable: true },
  { field: "fm.status", label: "Status (fm.status)", kind: "str", sortable: true },
  { field: "fm.date", label: "Date (fm.date)", kind: "date", sortable: true },
];

/** Canonical date shapes the core's `Date::parse` accepts, loosely — enough to refuse junk. */
const DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** One tagged literal, or `undefined` when the text cannot be one. */
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
      // A half-typed date must produce no clause rather than a rejected filter.
      return DATE_PATTERN.test(text) && calendarValid(text) ? { date: text } : undefined;
    default:
      return undefined;
  }
}

/** Reject `2026-02-30` here, because the core does and a 400 is worse than no clause. */
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

/** Is the field path shaped like something the core will parse? */
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

/**
 * One clause → one DSL node, or `undefined` when the row is incomplete or the
 * combination is one both engines refuse.
 */
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
  // A parent not seen yet, or with no children, has no children to match.
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
    // `text` is a string operator; the core refuses it against a non-string column.
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

  // Both engines refuse an ordering comparison against a bool or null literal.
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

/**
 * All the rows → one filter, or `undefined` for "no filter at all".
 *
 * `undefined` rather than `{"all": "all"}`: a query with no filter is cheaper on both
 * sides, and an empty `and` is a node the reader has to think about.
 */
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

/**
 * Why a row produces no clause, or `undefined` when it produces one.
 *
 * **This is the definition, and {@link invalidClauses} is derived from it.** They used
 * to be two computations of the same question — `buildClause(...) === undefined` in one
 * place, a fixed "Incomplete" string in the other — which is exactly the shape of bug
 * the audit suspected here (a row marked "not being applied" while the query said
 * otherwise). `filter.test.ts` asserts the equivalence over a matrix rather than
 * trusting that the two stay in step.
 *
 * The sentence matters as much as the boolean. Two of these rows are not *incomplete*
 * at all — they are filled in and refused, and "Incomplete" told the user to type
 * something into a box that was already full.
 */
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

/** A human-readable rendering of a clause, for the chip list. */
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
