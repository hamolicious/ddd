/**
 * Building the filter DSL from what a person clicked.
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

import type { FilterJson, SortKey } from "@kernel";

import { withoutMachineDocuments } from "../../_shared/machine-docs.js";

/** The value families the DSL compares. `"null"` is the bare-string literal. */
export type ValueKind = "str" | "int" | "float" | "bool" | "date" | "null";

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
  | "is_null";

export interface FilterClause {
  /** Stable row id, for React keys. Not part of the emitted JSON. */
  readonly id: string;
  /** A dotted projection path: `title`, `fm.status`, `plugins.calendar.uid`. */
  readonly field: string;
  readonly op: ClauseOp;
  /** The raw text the user typed. Ignored by the value-less operators. */
  readonly value: string;
  readonly kind: ValueKind;
  /** Wrap the clause in `not`. */
  readonly negate?: boolean;
}

export interface FilterDraft {
  readonly combine: "and" | "or";
  readonly clauses: readonly FilterClause[];
  /**
   * Show machine-owned documents — the ones whose `fm.path` starts with `.`, such as
   * the kernel's per-user settings documents (`_shared/machine-docs.ts`).
   *
   * Off by default, because a workspace of eleven notes reading "12 documents" is
   * wrong about the only question the number answers. It is a **view** default and
   * nothing more: the documents are ordinary documents, and every link to one keeps
   * working whether this is on or off.
   */
  readonly includeMachine?: boolean;
}

/** Operators that take no value. */
export const VALUELESS_OPS: readonly ClauseOp[] = ["missing", "exists", "is_null"];

/** Operators that only make sense against a string field. */
const TEXT_OPS: readonly ClauseOp[] = ["text_contains", "text_starts_with", "text_ends_with"];

/** Ordering operators, refused against `bool`/`null` literals by both engines. */
const ORDERING_OPS: readonly ClauseOp[] = ["lt", "lte", "gt", "gte"];

export interface FieldOption {
  readonly field: string;
  readonly label: string;
  /** The value family the projection guarantees, when it guarantees one. */
  readonly kind?: ValueKind;
  /** `false` ⇒ the server refuses to sort on it (SPEC §4.2 / backend/README.md). */
  readonly sortable: boolean;
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
  { field: "fm.path", label: "Folder (fm.path)", kind: "str", sortable: true },
  { field: "fm.tags", label: "Tags (fm.tags)", sortable: true },
  { field: "fm.status", label: "Status (fm.status)", kind: "str", sortable: true },
  { field: "fm.date", label: "Date (fm.date)", kind: "date", sortable: true },
];

/** Sort keys the *server* accepts, for the sort control. `id` is the tiebreaker. */
export const SORT_OPTIONS: readonly FieldOption[] = [
  { field: "updated_at", label: "Last updated", kind: "date", sortable: true },
  { field: "created_at", label: "Created", kind: "date", sortable: true },
  { field: "title", label: "Title", kind: "str", sortable: true },
  { field: "fm.path", label: "Folder", kind: "str", sortable: true },
  { field: "id", label: "Id", kind: "str", sortable: true },
];

/**
 * "Best match": the search providers' ranking, offered only while a search is on and
 * chosen automatically when one starts. Not a field — no query sorts on it; the list
 * reorders its rows by rank (`DocListView`).
 */
export const RELEVANCE: FieldOption = { field: "relevance", label: "Best match", kind: "str", sortable: true };

/**
 * `deleted_at` is not in {@link SORT_OPTIONS} because the main list never shows a
 * tombstone — but it **is** a sort key now, and the Trash view uses it.
 *
 * It used to be neither: `resolve_field` returned `Missing` for that root and
 * `?sort=deleted_at` was a 400, so Trash ordered its rows in the component after the
 * query, over whatever page came back. The shared core's field space reaches it now
 * (`core::filter::ast::FIXED_ROOTS`), so the ordering is the engine's on both sides.
 */
export const TRASH_SORT_IS_CLIENT_SIDE = false;

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
export function buildClause(clause: FilterClause): FilterJson | undefined {
  const field = clause.field.trim();
  if (!isFieldPathShaped(field)) return undefined;

  const node = buildClauseNode(clause, field);
  if (!node) return undefined;
  return clause.negate === true ? { not: node } : node;
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

  const literal = buildLiteral(clause.kind, clause.value);
  if (literal === undefined) return undefined;

  // Both engines refuse an ordering comparison against a bool or null literal.
  if (ORDERING_OPS.includes(clause.op) && (clause.kind === "bool" || clause.kind === "null")) {
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
 * The whole draft → one filter, or `undefined` for "no filter at all".
 *
 * `undefined` rather than `{"all": "all"}`: a query with no filter is cheaper on both
 * sides, and an empty `and` is a node the reader has to think about.
 */
export function buildFilter(draft: FilterDraft): FilterJson | undefined {
  const nodes: FilterJson[] = [];

  for (const clause of draft.clauses) {
    const node = buildClause(clause);
    if (node) nodes.push(node);
  }

  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0];
  return draft.combine === "or" ? { or: nodes } : { and: nodes };
}

/**
 * The filter the list actually runs: {@link buildFilter} plus the machine-document
 * exclusion, unless the draft asks for them.
 *
 * Kept separate from `buildFilter` because the two answer different questions.
 * `buildFilter` is "what did the user ask for", which is what decides whether an empty
 * result says "no documents yet" or "nothing matches your filter"; this is "what goes
 * on the wire". Folding the exclusion into `buildFilter` would make every list look
 * filtered and turn the first-run empty state into the wrong sentence.
 */
export function buildEffectiveFilter(draft: FilterDraft): FilterJson | undefined {
  const filter = buildFilter(draft);
  return draft.includeMachine === true ? filter : withoutMachineDocuments(filter);
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

  if (ORDERING_OPS.includes(clause.op) && (clause.kind === "bool" || clause.kind === "null")) {
    return "Before and after do not apply to true/false or null.";
  }

  if (buildLiteral(clause.kind, clause.value) === undefined) {
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

/** Clauses the builder dropped, so the UI can mark the rows instead of losing them silently. */
export function invalidClauses(draft: FilterDraft): readonly string[] {
  return draft.clauses.filter((clause) => clauseProblem(clause) !== undefined).map((clause) => clause.id);
}

/**
 * How many conditions the query actually carries — the number the folded filter bar
 * shows, so a collapsed bar is never a silent one.
 *
 * Counted from {@link buildFilter}'s own rules rather than from the row count: a
 * half-typed row produces no clause, and a badge that counted it would say "1
 * condition applied" over a query with none.
 */
export function appliedCount(draft: FilterDraft): number {
  const usable = draft.clauses.filter((clause) => clauseProblem(clause) === undefined).length;
  return usable + (draft.includeMachine === true ? 1 : 0);
}

/** The filter that selects trashed documents (used with `includeDeleted: true`). */
export const TRASHED_ONLY: FilterJson = { cmp: { field: "deleted", op: "eq", value: { bool: true } } };

/** One sort key. `id` is appended by both engines as the final tiebreaker. */
export function buildSort(field: string, direction: "asc" | "desc"): readonly SortKey[] {
  return [{ field, direction }];
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
  };
  const head = `${clause.field} ${labels[clause.op]}`;
  const tail = VALUELESS_OPS.includes(clause.op) ? "" : ` ${clause.value}`;
  return `${clause.negate === true ? "not " : ""}${head}${tail}`;
}
