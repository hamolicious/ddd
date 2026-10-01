/**
 * The search builder: conditions as values, a query as a chain, and a way back to a
 * search the UI can show.
 *
 * ```ts
 * import { search, field, or, not, childOf } from "plugin:search";
 *
 * const open = field("fm.status").eq("open");
 * const rows = await search()
 *   .where(open, field("fm.due").lte(new Date()))
 *   .where(or(field("fm.tags").contains("home"), field("fm.tags").contains("errand")))
 *   .where(not(field("fm.archived").eq(true)))
 *   .where(childOf(projectId, { deep: true }))
 *   .text("milk")
 *   .orderBy("fm.due")
 *   .orderBy("updated_at", "desc")
 *   .limit(20)
 *   .rows();
 * ```
 *
 * What it adds over `query()` (`query.ts`, the first chain, kept as it is):
 *
 * - **A condition is a value.** `field("fm.status").eq("open")` is plain data that can
 *   be kept, shared, put in a list and combined with `and`, `or` and `not`, instead of
 *   a step that only exists inside one chain. A `Date` is a date literal; a note is
 *   `doc(id)`.
 * - **The answer in the shape wanted**: `rows()`, `first()`, `ids()`, `count()`,
 *   `all()` (every page), `run()` (the engine's whole answer) and `live()`; `useQuery`
 *   takes a builder.
 * - **It is a search, not only a query.** Machine-owned documents are left out, as every
 *   search leaves them out, unless `includeMachine()`. `toSpec()` is the same search as
 *   the `SearchSpec` the shell draws, a URL carries and a saved-search note holds, and
 *   `save()` writes that note; `search(spec)` reads one back. Not every query is a
 *   search — nested groups and `oneOf` have no filter row — and `toSpec()` says so.
 *
 * The plan it writes is the shared core's, lowered by the same `lower` as `query()`;
 * a mistake is kept and thrown by `plan()` (and so by every answer), never half-applied.
 */

import type { DocumentRow, FilterJson, PlanResult, PlanSubscription, QueryPlan } from "@kernel";

import {
  isFieldPathShaped,
  newClauseId,
  splitValues,
  type ClauseOp,
  type ValueKind,
} from "../../_shared/conditions.js";
import { withoutMachineDocuments } from "../../_shared/machine-docs.js";

import type { SaveSearchOptions, SearchClause, SearchSort, SearchSpec } from "./api.js";
import { RELEVANCE } from "./filter.js";
import { QueryError, lower, need, type QueryValue } from "./query.js";

/** A value a condition compares with: {@link QueryValue}, or a `Date` (a datetime literal). */
export type SearchValue = QueryValue | Date;

/** A note, as a value: `field("fm.project").eq(doc(id))`. */
export function doc(id: string): { readonly doc: string } {
  return { doc: id };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * A condition on a document. Plain data: `JSON.stringify` keeps it, `and`/`or`/`not`
 * combine it, and `search().where(…)` runs it.
 */
export type Condition =
  | {
      readonly type: "clause";
      /** `""` for `child_of` and `parent_of`, whose value is the note. */
      readonly field: string;
      readonly op: ClauseOp;
      readonly values: readonly QueryValue[];
      readonly deep?: boolean;
    }
  | { readonly type: "oneOf"; readonly field: string; readonly values: readonly QueryValue[] }
  | { readonly type: "group"; readonly combine: "and" | "or"; readonly items: readonly Condition[] }
  | { readonly type: "not"; readonly item: Condition }
  | { readonly type: "raw"; readonly node: FilterJson };

function value(input: SearchValue): QueryValue {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new QueryError("an invalid Date cannot be compared with");
    return { date: input.toISOString() };
  }
  return input;
}

function clause(field: string, op: ClauseOp, values: readonly SearchValue[], deep?: boolean): Condition {
  return { type: "clause", field, op, values: values.map(value), ...(deep === true ? { deep: true } : {}) };
}

/** The conditions a field can be put under. */
export class Field {
  constructor(readonly path: string) {}

  eq(to: SearchValue): Condition {
    return clause(this.path, "eq", [to]);
  }

  ne(to: SearchValue): Condition {
    return clause(this.path, "ne", [to]);
  }

  lt(than: SearchValue): Condition {
    return clause(this.path, "lt", [than]);
  }

  lte(than: SearchValue): Condition {
    return clause(this.path, "lte", [than]);
  }

  gt(than: SearchValue): Condition {
    return clause(this.path, "gt", [than]);
  }

  gte(than: SearchValue): Condition {
    return clause(this.path, "gte", [than]);
  }

  /** `from` and `to` included. */
  between(from: SearchValue, to: SearchValue): Condition {
    return and(this.gte(from), this.lte(to));
  }

  /** Equals one of the values, which must be of one kind. No filter row shows it. */
  oneOf(...values: readonly SearchValue[]): Condition {
    return { type: "oneOf", field: this.path, values: values.map(value) };
  }

  /** A list field holds the value. */
  contains(item: SearchValue): Condition {
    return clause(this.path, "contains", [item]);
  }

  /** A list field holds at least one of the values. */
  containsAny(...items: readonly SearchValue[]): Condition {
    return clause(this.path, "contains_any", items);
  }

  /** Some item of a list field equals the value. */
  any(item: SearchValue): Condition {
    return clause(this.path, "any", [item]);
  }

  /** Every item of a list field equals the value. */
  every(item: SearchValue): Condition {
    return clause(this.path, "every", [item]);
  }

  /** The text holds this, case-insensitively. */
  textContains(text: string): Condition {
    return clause(this.path, "text_contains", [text]);
  }

  startsWith(text: string): Condition {
    return clause(this.path, "text_starts_with", [text]);
  }

  endsWith(text: string): Condition {
    return clause(this.path, "text_ends_with", [text]);
  }

  /** The field is not there at all (`null` is a value, and is not missing). */
  missing(): Condition {
    return clause(this.path, "missing", []);
  }

  exists(): Condition {
    return clause(this.path, "exists", []);
  }

  isNull(): Condition {
    return clause(this.path, "is_null", []);
  }
}

/** A field to put conditions on: `title`, `fm.status`, `plugins.calendar.uid`. */
export function field(path: string): Field {
  return new Field(path);
}

/** Every condition holds. */
export function and(...items: readonly Condition[]): Condition {
  return { type: "group", combine: "and", items };
}

/** At least one condition holds. */
export function or(...items: readonly Condition[]): Condition {
  return { type: "group", combine: "or", items };
}

/** The condition does not hold. */
export function not(item: Condition): Condition {
  return { type: "not", item };
}

/** In note `id`; with `deep`, anywhere below it. */
export function childOf(id: string, options?: { readonly deep?: boolean }): Condition {
  return clause("", "child_of", [id], options?.deep);
}

/** Lists note `id` among its children. */
export function parentOf(id: string): Condition {
  return clause("", "parent_of", [id]);
}

/** A filter-DSL node as it is. */
export function raw(node: FilterJson): Condition {
  return { type: "raw", node };
}

/** The tag of a tagged literal: what `oneOf` needs to agree on. */
function tagOf(literal: unknown): string {
  if (literal === "null") return "null";
  return Object.keys(literal as object)[0] ?? "";
}

/** A condition → one DSL node. Throws a {@link QueryError}. */
export function lowerCondition(condition: Condition): FilterJson {
  switch (condition.type) {
    case "clause":
      return lower(condition.field, condition.op, condition.values, condition.deep === true);
    case "oneOf": {
      if (condition.values.length === 0) throw new QueryError("`oneOf` takes at least one value");
      // Lower each as an `eq` so the values are typed and checked as any other.
      const literals = condition.values.map((item) => {
        const node = lower(condition.field, "eq", [item], false) as { cmp: { value: unknown } };
        return node.cmp.value;
      });
      const tags = new Set(literals.map(tagOf));
      if (tags.size > 1) throw new QueryError(`\`oneOf\` takes values of one kind, not ${[...tags].join(" and ")}`);
      return { in: { field: condition.field.trim(), values: literals } };
    }
    case "group": {
      const nodes = condition.items.map(lowerCondition);
      if (nodes.length === 0) throw new QueryError(`an empty \`${condition.combine}\` holds no condition`);
      return nodes.length === 1 ? (nodes[0] as FilterJson) : { [condition.combine]: nodes };
    }
    case "not":
      return { not: lowerCondition(condition.item) };
    case "raw":
      return condition.node;
    default:
      throw new QueryError("not a condition");
  }
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export type SortDirection = "asc" | "desc";

interface State {
  readonly text: string;
  readonly conditions: readonly Condition[];
  readonly sort: readonly string[];
  readonly includeMachine: boolean;
  readonly trash?: "live" | "trashed" | "all";
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly snippets: boolean;
}

const EMPTY: State = { text: "", conditions: [], sort: [], includeMachine: false, snippets: false };

interface Bound {
  readonly save: (spec: SearchSpec, options?: SaveSearchOptions) => Promise<string>;
}

let bound: Bound | undefined;

/** What `save` needs, from `activate`. */
export function bindBuilder(api: Bound | undefined): void {
  bound = api;
}

export class SearchBuilder {
  readonly #state: State;

  constructor(state: State = EMPTY) {
    this.#state = state;
  }

  /** Ranked full-text search over titles, property values and text. */
  text(text: string): SearchBuilder {
    return this.#with({ text: text.trim() });
  }

  /** Every condition must hold, besides those given before. */
  where(...conditions: readonly Condition[]): SearchBuilder {
    return this.#with({ conditions: [...this.#state.conditions, ...conditions] });
  }

  /** Sort by a field, after any earlier sort. Ascending unless told otherwise. */
  orderBy(field: string, direction: SortDirection = "asc"): SearchBuilder {
    return this.#with({ sort: [...this.#state.sort, direction === "desc" ? `-${field.trim()}` : field.trim()] });
  }

  /** Best match first (while there is text), after any earlier sort. */
  byRelevance(): SearchBuilder {
    return this.#with({ sort: [...this.#state.sort, "relevance"] });
  }

  /** Machine-owned documents too (`machine: true`), which a search leaves out otherwise. */
  includeMachine(include = true): SearchBuilder {
    return this.#with({ includeMachine: include });
  }

  /** Live documents (the default), the Trash, or both. */
  trash(trash: "live" | "trashed" | "all"): SearchBuilder {
    return this.#with({ trash });
  }

  /** Rows per page; 50 by default. */
  limit(limit: number): SearchBuilder {
    return this.#with({ limit });
  }

  /** Rows to skip; not with a cursor. */
  offset(offset: number): SearchBuilder {
    return this.#with({ offset });
  }

  /** A previous answer's `nextCursor`. */
  cursor(cursor: string): SearchBuilder {
    return this.#with({ cursor });
  }

  /** Each text hit carries the line it matched on. */
  snippets(): SearchBuilder {
    return this.#with({ snippets: true });
  }

  // -- Answers ------------------------------------------------------------

  /** The plan, as JSON — for the kernel, `POST /api/query`, or a saved note. Throws a {@link QueryError}. */
  plan(): QueryPlan {
    const state = this.#state;
    for (const token of state.sort) {
      const field = token.startsWith("-") ? token.slice(1) : token;
      if (field !== "relevance" && !isFieldPathShaped(field)) throw new QueryError(`\`${field}\` is not a sortable field`);
    }
    const nodes = state.conditions.map(lowerCondition);
    const own = nodes.length === 0 ? undefined : nodes.length === 1 ? nodes[0] : { and: nodes };
    const filter = state.includeMachine ? own : withoutMachineDocuments(own);
    return {
      ...(state.text !== "" ? { text: state.text } : {}),
      ...(filter !== undefined ? { filter } : {}),
      ...(state.sort.length > 0 ? { sort: state.sort } : {}),
      ...(state.trash ? { trash: state.trash } : {}),
      ...(state.limit !== undefined ? { limit: state.limit } : {}),
      ...(state.offset !== undefined ? { offset: state.offset } : {}),
      ...(state.cursor !== undefined ? { cursor: state.cursor } : {}),
      ...(state.snippets ? { snippets: true } : {}),
    };
  }

  /** The engine's whole answer, once: rows, total, next cursor and text hits. */
  run(): Promise<PlanResult> {
    return need().queryPlan(this.plan());
  }

  /** The rows of one page. */
  async rows(): Promise<readonly DocumentRow[]> {
    return (await this.run()).rows;
  }

  /** The first row, or `undefined` when nothing matches. */
  async first(): Promise<DocumentRow | undefined> {
    return (await this.limit(1).run()).rows[0];
  }

  /** The ids of one page. */
  async ids(): Promise<readonly string[]> {
    return (await this.rows()).map((row) => row.id);
  }

  /** How many documents match, before paging. */
  async count(): Promise<number> {
    return (await this.limit(1).run()).total;
  }

  /** Every matching row, page after page. Mind the size of what is asked for. */
  async all(): Promise<readonly DocumentRow[]> {
    const rows: DocumentRow[] = [];
    let page = await this.run();
    rows.push(...page.rows);
    while (page.nextCursor !== undefined && page.rows.length > 0) {
      // A cursor pages the plan it came from, and not alongside an offset.
      page = await this.#with({ offset: undefined, cursor: page.nextCursor }).run();
      rows.push(...page.rows);
    }
    return rows;
  }

  /** The answer, live: `result` is always current and `onChange` fires as it changes. */
  live(): Promise<PlanSubscription> {
    return need().subscribePlan(this.plan());
  }

  // -- As a search ----------------------------------------------------------

  /**
   * This search as the `SearchSpec` the shell draws, `encode` writes to a URL and a
   * saved-search note holds. Paging, snippets and `trash` are not part of a search and
   * are left out. Throws a {@link QueryError} for a query no search can show: a group
   * inside a group, `oneOf`, `raw`, more than one sort key, the Trash.
   */
  toSpec(): SearchSpec {
    const state = this.#state;
    if (state.trash !== undefined && state.trash !== "live") throw new QueryError("a search is of live documents; it cannot show the Trash");
    const filter = specFilter(state.conditions);
    const sort = specSort(state.sort);
    return {
      query: state.text,
      filter: { ...filter, ...(state.includeMachine ? { includeMachine: true } : {}) },
      ...(sort ? { sort } : {}),
    };
  }

  /** Save this search to a new note and open it. Resolves to the note's id. */
  save(options?: SaveSearchOptions): Promise<string> {
    if (!bound) throw new Error("search is not active yet: save a search from your plugin's activate() or later");
    return bound.save(this.toSpec(), options);
  }

  #with(patch: Partial<State>): SearchBuilder {
    return new SearchBuilder({ ...this.#state, ...patch });
  }
}

/** A new search: every live document, last updated first — or the one `spec` describes. */
export function search(spec?: SearchSpec): SearchBuilder {
  return spec === undefined ? new SearchBuilder() : fromSpec(spec);
}

// ---------------------------------------------------------------------------
// To and from a SearchSpec
// ---------------------------------------------------------------------------

/** The kind and the text of a value, as a filter row keeps them. */
function rowValue(input: QueryValue): { readonly kind: ValueKind; readonly value: string } {
  if (input === null) return { kind: "null", value: "" };
  switch (typeof input) {
    case "string":
      return { kind: "str", value: input };
    case "boolean":
      return { kind: "bool", value: String(input) };
    case "number":
      return { kind: Number.isInteger(input) ? "int" : "float", value: String(input) };
    default:
      return "date" in input ? { kind: "date", value: input.date } : { kind: "doc", value: input.doc };
  }
}

/** The value a filter row's kind and text mean, or `undefined` for a row that is not one yet. */
function valueOfRow(kind: ValueKind, raw: string): QueryValue | undefined {
  const text = raw.trim();
  switch (kind) {
    case "str":
      return raw === "" ? undefined : raw;
    case "null":
      return null;
    case "bool":
      return text.toLowerCase() === "true" ? true : text.toLowerCase() === "false" ? false : undefined;
    case "int": {
      if (!/^[+-]?\d+$/.test(text)) return undefined;
      const parsed = Number.parseInt(text, 10);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    case "float": {
      const parsed = Number.parseFloat(text);
      return text !== "" && Number.isFinite(parsed) ? parsed : undefined;
    }
    case "date":
      return text === "" ? undefined : { date: text };
    case "doc":
      return text === "" ? undefined : { doc: text };
    default:
      return undefined;
  }
}

function unshowable(what: string): QueryError {
  return new QueryError(`${what} has no filter row: this query cannot be shown as a search`);
}

/** One condition → one filter row. */
function specClause(condition: Condition, negate: boolean): SearchClause {
  switch (condition.type) {
    case "clause": {
      const base = { id: newClauseId(), field: condition.field, op: condition.op };
      const flags = { ...(condition.deep === true ? { deep: true } : {}), ...(negate ? { negate: true } : {}) };
      if (condition.op === "child_of" || condition.op === "parent_of") {
        const [id] = condition.values;
        if (typeof id !== "string") throw new QueryError(`\`${condition.op}\` takes a note id`);
        return { ...base, kind: "str", value: id, ...flags };
      }
      if (condition.values.length === 0) return { ...base, kind: "str", value: "", ...flags };
      const rows = condition.values.map(rowValue);
      const kinds = new Set(rows.map((row) => row.kind));
      if (kinds.size > 1) throw new QueryError(`a filter row holds values of one kind, not ${[...kinds].join(" and ")}`);
      if (condition.op === "contains_any" && rows.some((row) => row.value.includes(","))) {
        throw new QueryError("a `containsAny` value with a comma in it cannot be a filter row");
      }
      const [first] = rows;
      return { ...base, kind: first?.kind ?? "str", value: rows.map((row) => row.value).join(", "), ...flags };
    }
    case "not":
      if (negate) throw unshowable("`not` inside `not`");
      return specClause(condition.item, true);
    case "group":
      throw unshowable(negate ? "a negated group" : "a group inside a group");
    case "oneOf":
      throw unshowable("`oneOf`");
    default:
      throw unshowable("a raw filter");
  }
}

/** The groups of `combine` inside `items`, opened up: `and(a, and(b, c))` is `a, b, c`. */
function flatten(items: readonly Condition[], combine: "and" | "or"): readonly Condition[] {
  return items.flatMap((item) => (item.type === "group" && item.combine === combine ? flatten(item.items, combine) : [item]));
}

function specFilter(conditions: readonly Condition[]): SearchSpec["filter"] {
  const top = flatten(conditions, "and");
  const [only] = top;
  if (top.length === 1 && only !== undefined && only.type === "group" && only.combine === "or") {
    return { combine: "or", clauses: flatten(only.items, "or").map((item) => specClause(item, false)) };
  }
  return { combine: "and", clauses: top.map((item) => specClause(item, false)) };
}

function specSort(sort: readonly string[]): SearchSort | undefined {
  if (sort.length === 0) return undefined;
  const [first, second] = sort;
  if (first === "relevance" && (sort.length === 1 || (sort.length === 2 && second === "-updated_at"))) {
    return { field: RELEVANCE.field, direction: "desc" };
  }
  if (sort.length > 1 || first === undefined) throw new QueryError("a search sorts by one field: this query cannot be shown as a search");
  return first.startsWith("-") ? { field: first.slice(1), direction: "desc" } : { field: first, direction: "asc" };
}

/** The search a spec describes. A row that is not a condition yet (half-typed) is left out, as the shell leaves it out. */
export function fromSpec(spec: SearchSpec): SearchBuilder {
  const conditions = spec.filter.clauses.flatMap((row): Condition[] => {
    const condition = conditionOfRow(row);
    if (condition === undefined) return [];
    return [row.negate === true ? not(condition) : condition];
  });
  let builder = new SearchBuilder().text(spec.query).includeMachine(spec.filter.includeMachine === true);
  if (conditions.length > 0) {
    builder = spec.filter.combine === "or" && conditions.length > 1 ? builder.where(or(...conditions)) : builder.where(...conditions);
  }
  if (spec.sort) {
    builder =
      spec.sort.field === RELEVANCE.field
        ? builder.byRelevance().orderBy("updated_at", "desc")
        : builder.orderBy(spec.sort.field, spec.sort.direction);
  }
  return builder;
}

function conditionOfRow(row: SearchClause): Condition | undefined {
  const op = row.op as ClauseOp;
  if (op === "child_of" || op === "parent_of") {
    const id = row.value.trim();
    if (id === "") return undefined;
    return op === "child_of" ? childOf(id, { deep: row.deep === true }) : parentOf(id);
  }
  const path = row.field.trim();
  if (!isFieldPathShaped(path)) return undefined;
  if (op === "missing" || op === "exists" || op === "is_null") return clause(path, op, []);
  const kind = row.kind as ValueKind;
  if (op === "contains_any") {
    const values = splitValues(row.value).map((item) => valueOfRow(kind, item));
    if (values.length === 0 || values.some((item) => item === undefined)) return undefined;
    return clause(path, op, values as QueryValue[]);
  }
  const item = valueOfRow(kind, row.value);
  return item === undefined ? undefined : clause(path, op, [item]);
}
