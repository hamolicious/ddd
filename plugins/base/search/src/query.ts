/**
 * The functional query API: a chain that writes a query plan.
 *
 * ```ts
 * import { query } from "plugin:search";
 *
 * const { rows, total } = await query()
 *   .filter("title", "text_contains", "a")
 *   .sort("fm.key")
 *   .limit(20)
 *   .run();
 * ```
 *
 * The plan is the shared core's (`backend/crates/core/README.md` §6) — the same one
 * the Rust SDK's `Query` builder writes, `POST /api/query` takes and the kernel's
 * engine answers — so a query reads the same in every language and answers the same
 * wherever it runs. The operators are the search's filter rows; each lowers to one
 * filter-DSL node exactly as the core's `query::lower` does.
 *
 * Every step returns a new builder, so a base query can be shared and extended. A
 * mistake (a malformed field, a value the operator cannot take) is kept and thrown
 * by {@link QueryBuilder.plan}, never half-applied.
 */

import { useEffect, useState } from "react";

import type { DocumentsApi, FilterJson, PlanResult, PlanSubscription, QueryPlan } from "@kernel";

import { DOC_PREFIX, isFieldPathShaped, type ClauseOp } from "../../_shared/conditions.js";

/** A value to compare with. Numbers are `int` when whole, `float` otherwise. */
export type QueryValue =
  | string
  | number
  | boolean
  | null
  /** A date or datetime, compared as one: `{ date: "2026-10-01" }`. */
  | { readonly date: string }
  /** A link to a note, as properties hold it (`doc://<id>`): `{ doc: id }`. */
  | { readonly doc: string };

export type QueryOp = ClauseOp;

export class QueryError extends Error {
  override readonly name = "QueryError";
}

interface State {
  readonly text: string;
  readonly conditions: readonly FilterJson[];
  readonly sort: readonly string[];
  readonly trash?: "live" | "trashed" | "all";
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly snippets: boolean;
  readonly error?: string;
}

const EMPTY: State = { text: "", conditions: [], sort: [], snippets: false };

const ORDERING: readonly ClauseOp[] = ["lt", "lte", "gt", "gte"];
const VALUELESS: readonly ClauseOp[] = ["missing", "exists", "is_null"];
const TEXT_MODES: Partial<Record<ClauseOp, string>> = {
  text_contains: "contains",
  text_starts_with: "starts_with",
  text_ends_with: "ends_with",
};

/** The tagged literal for a value. */
function literal(value: QueryValue): unknown {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return { str: value };
    case "boolean":
      return { bool: value };
    case "number":
      if (!Number.isFinite(value)) throw new QueryError(`${value} is not a number a query can hold`);
      return Number.isInteger(value) ? { int: value } : { float: value };
    default:
      return "date" in value ? { date: value.date } : { str: `${DOC_PREFIX}${value.doc}` };
  }
}

/** One condition → one DSL node: the core's `query::lower`, in TypeScript. */
export function lower(field: string, op: QueryOp, values: readonly QueryValue[], deep: boolean): FilterJson {
  const one = (): QueryValue => {
    if (values.length !== 1) throw new QueryError(`\`${op}\` takes one value`);
    return values[0] as QueryValue;
  };
  if (op === "child_of" || op === "parent_of") {
    const id = one();
    if (typeof id !== "string" || id.trim() === "") throw new QueryError(`\`${op}\` takes a note id`);
    return op === "child_of" ? { child_of: { of: id.trim(), deep } } : { parent_of: { of: id.trim() } };
  }

  const path = field.trim();
  if (!isFieldPathShaped(path)) throw new QueryError(`\`${field}\` is not a field: title, content, created_at, updated_at, fm.<key>, plugins.<id>.<key>`);
  if (VALUELESS.includes(op)) return { [op]: { field: path } };

  const mode = TEXT_MODES[op];
  if (mode !== undefined) {
    const value = one();
    if (typeof value !== "string") throw new QueryError(`\`${op}\` takes text`);
    return { text: { field: path, mode, value } };
  }

  if (op === "contains_any") {
    if (values.length === 0) throw new QueryError("`contains_any` takes at least one value");
    const nodes = values.map((value) => ({ contains: { field: path, value: literal(value) } }));
    return nodes.length === 1 ? (nodes[0] as FilterJson) : { or: nodes };
  }

  const value = one();
  if (ORDERING.includes(op) && (value === null || typeof value === "boolean")) {
    throw new QueryError(`\`${op}\` cannot order a true/false or null value`);
  }
  switch (op) {
    case "contains":
      return { contains: { field: path, value: literal(value) } };
    case "any":
    case "every":
      return { [op]: { field: path, op: "eq", value: literal(value) } };
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return { cmp: { field: path, op, value: literal(value) } };
    default:
      throw new QueryError(`unknown operator \`${String(op)}\``);
  }
}

let documents: DocumentsApi | undefined;

/** The kernel's documents API, from `activate`. */
export function bindDocuments(api: DocumentsApi | undefined): void {
  documents = api;
}

export class QueryBuilder {
  readonly #state: State;

  constructor(state: State = EMPTY) {
    this.#state = state;
  }

  /** Ranked full-text search over titles, property values and text. */
  text(text: string): QueryBuilder {
    return this.#with({ text: text.trim() });
  }

  /** A condition: `field op value`. Value-less operators (`missing`, `exists`, `is_null`) ignore it. */
  filter(field: string, op: QueryOp, value?: QueryValue): QueryBuilder {
    const values = VALUELESS.includes(op) || value === undefined ? [] : [value];
    return this.#condition(() => lower(field, op, values, false));
  }

  /** A condition taking several values: `contains_any`. */
  filterValues(field: string, op: QueryOp, values: readonly QueryValue[]): QueryBuilder {
    return this.#condition(() => lower(field, op, values, false));
  }

  missing(field: string): QueryBuilder {
    return this.filter(field, "missing");
  }

  exists(field: string): QueryBuilder {
    return this.filter(field, "exists");
  }

  isNull(field: string): QueryBuilder {
    return this.filter(field, "is_null");
  }

  /** In note `id`; with `deep`, anywhere below it. */
  childOf(id: string, deep = false): QueryBuilder {
    return this.#condition(() => lower("", "child_of", [id], deep));
  }

  /** Lists note `id` among its children. */
  parentOf(id: string): QueryBuilder {
    return this.#condition(() => lower("", "parent_of", [id], false));
  }

  /** A filter-DSL node as it is. */
  where(filter: FilterJson): QueryBuilder {
    return this.#condition(() => filter);
  }

  /** The conditions `group` adds, combined with *or*. */
  anyOf(group: (q: QueryBuilder) => QueryBuilder): QueryBuilder {
    return this.#group(group, (nodes) => ({ or: nodes }));
  }

  /** None of the conditions `group` adds: `not (a or b …)`. */
  noneOf(group: (q: QueryBuilder) => QueryBuilder): QueryBuilder {
    return this.#group(group, (nodes) => ({ not: { or: nodes } }));
  }

  /** Sort ascending by a field, after any earlier sort. */
  sort(field: string): QueryBuilder {
    return this.#sort(field, field);
  }

  /** Sort descending by a field, after any earlier sort. */
  sortDesc(field: string): QueryBuilder {
    return this.#sort(field, `-${field}`);
  }

  /** Best match first (while there is text), after any earlier sort. */
  sortRelevance(): QueryBuilder {
    return this.#with({ sort: [...this.#state.sort, "relevance"] });
  }

  trash(trash: "live" | "trashed" | "all"): QueryBuilder {
    return this.#with({ trash });
  }

  limit(limit: number): QueryBuilder {
    return this.#with({ limit });
  }

  offset(offset: number): QueryBuilder {
    return this.#with({ offset });
  }

  /** A previous result's `nextCursor`. */
  cursor(cursor: string): QueryBuilder {
    return this.#with({ cursor });
  }

  /** Each text hit carries the line it matched on. */
  snippets(): QueryBuilder {
    return this.#with({ snippets: true });
  }

  /** The plan, as JSON — for the kernel, `POST /api/query`, or a saved note. Throws a {@link QueryError}. */
  plan(): QueryPlan {
    const state = this.#state;
    if (state.error !== undefined) throw new QueryError(state.error);
    const { conditions } = state;
    const filter =
      conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : { and: [...conditions] };
    return {
      ...(state.text !== "" ? { text: state.text } : {}),
      ...(filter ? { filter } : {}),
      ...(state.sort.length > 0 ? { sort: state.sort } : {}),
      ...(state.trash ? { trash: state.trash } : {}),
      ...(state.limit !== undefined ? { limit: state.limit } : {}),
      ...(state.offset !== undefined ? { offset: state.offset } : {}),
      ...(state.cursor !== undefined ? { cursor: state.cursor } : {}),
      ...(state.snippets ? { snippets: true } : {}),
    };
  }

  /** Answer it once, locally: rows, total, next cursor and text hits. */
  run(): Promise<PlanResult> {
    return need().queryPlan(this.plan());
  }

  /** Answer it live, locally. */
  subscribe(): Promise<PlanSubscription> {
    return need().subscribePlan(this.plan());
  }

  #with(patch: Partial<State>): QueryBuilder {
    return new QueryBuilder({ ...this.#state, ...patch });
  }

  #condition(node: () => FilterJson): QueryBuilder {
    if (this.#state.error !== undefined) return this;
    try {
      return this.#with({ conditions: [...this.#state.conditions, node()] });
    } catch (error) {
      return this.#with({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  #group(group: (q: QueryBuilder) => QueryBuilder, combine: (nodes: FilterJson[]) => FilterJson): QueryBuilder {
    const inner = group(new QueryBuilder()).#state;
    if (inner.error !== undefined) return this.#with({ error: this.#state.error ?? inner.error });
    if (inner.conditions.length === 0) return this;
    return this.#condition(() => combine([...inner.conditions]));
  }

  #sort(field: string, token: string): QueryBuilder {
    if (!isFieldPathShaped(field.trim())) {
      return this.#with({ error: this.#state.error ?? `\`${field}\` is not a sortable field` });
    }
    return this.#with({ sort: [...this.#state.sort, token.trim()] });
  }
}

/** The kernel's documents API; throws while this plugin is not active. */
export function need(): DocumentsApi {
  if (!documents) throw new Error("search is not active yet: run a query from your plugin's activate() or later");
  return documents;
}

/** A new, empty query: every live document, last updated first. */
export function query(): QueryBuilder {
  return new QueryBuilder();
}

export interface QueryState {
  /** The current answer; the last one while a new plan loads. */
  readonly result?: PlanResult;
  readonly loading: boolean;
  /** The plan was refused, or the engine failed. */
  readonly error?: string;
}

/** Anything that writes a plan: a `QueryBuilder`, a `SearchBuilder`. */
export interface Plannable {
  plan(): QueryPlan;
}

function isPlannable(source: Plannable | QueryPlan): source is Plannable {
  return typeof (source as Partial<Plannable>).plan === "function";
}

/**
 * A React hook: the query's answer, live. Pass a builder (`query()`, `search()`) or a
 * plan; a new one with the same content does not re-subscribe.
 */
export function useQuery(source: Plannable | QueryPlan | undefined): QueryState {
  let plan: QueryPlan | undefined;
  let planError: string | undefined;
  try {
    plan = source !== undefined && isPlannable(source) ? source.plan() : source;
  } catch (error) {
    planError = error instanceof Error ? error.message : String(error);
  }
  const key = plan === undefined ? "" : JSON.stringify(plan);
  const [state, setState] = useState<QueryState>({ loading: plan !== undefined });

  useEffect(() => {
    if (plan === undefined) return undefined;
    let closed = false;
    let subscription: PlanSubscription | undefined;
    setState((previous) => ({ ...previous, loading: true }));
    need()
      .subscribePlan(plan)
      .then((live) => {
        if (closed) {
          live.close();
          return;
        }
        subscription = live;
        setState({ result: live.result, loading: false });
        live.onChange((result) => setState({ result, loading: false }));
      })
      .catch((error: unknown) => {
        if (!closed) setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      closed = true;
      subscription?.close();
    };
    // `key` is the plan's content: a new object with the same content is the same query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return planError !== undefined ? { loading: false, error: planError } : state;
}
