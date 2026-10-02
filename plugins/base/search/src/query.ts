import { useEffect, useState } from "react";

import type { DocumentsApi, FilterJson, PlanResult, PlanSubscription, QueryPlan } from "@kernel";

import { DOC_PREFIX, isFieldPathShaped, type ClauseOp } from "../../_shared/conditions.js";

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | { readonly date: string }
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

function lower(field: string, op: QueryOp, values: readonly QueryValue[], deep: boolean): FilterJson {
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

export function bindDocuments(api: DocumentsApi | undefined): void {
  documents = api;
}

export class QueryBuilder {
  readonly #state: State;

  constructor(state: State = EMPTY) {
    this.#state = state;
  }

  text(text: string): QueryBuilder {
    return this.#with({ text: text.trim() });
  }

  filter(field: string, op: QueryOp, value?: QueryValue): QueryBuilder {
    const values = VALUELESS.includes(op) || value === undefined ? [] : [value];
    return this.#condition(() => lower(field, op, values, false));
  }

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

  childOf(id: string, deep = false): QueryBuilder {
    return this.#condition(() => lower("", "child_of", [id], deep));
  }

  parentOf(id: string): QueryBuilder {
    return this.#condition(() => lower("", "parent_of", [id], false));
  }

  where(filter: FilterJson): QueryBuilder {
    return this.#condition(() => filter);
  }

  anyOf(group: (q: QueryBuilder) => QueryBuilder): QueryBuilder {
    return this.#group(group, (nodes) => ({ or: nodes }));
  }

  noneOf(group: (q: QueryBuilder) => QueryBuilder): QueryBuilder {
    return this.#group(group, (nodes) => ({ not: { or: nodes } }));
  }

  sort(field: string): QueryBuilder {
    return this.#sort(field, field);
  }

  sortDesc(field: string): QueryBuilder {
    return this.#sort(field, `-${field}`);
  }

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

  cursor(cursor: string): QueryBuilder {
    return this.#with({ cursor });
  }

  snippets(): QueryBuilder {
    return this.#with({ snippets: true });
  }

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

  run(): Promise<PlanResult> {
    return need().queryPlan(this.plan());
  }

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

function need(): DocumentsApi {
  if (!documents) throw new Error("search is not active yet: run a query from your plugin's activate() or later");
  return documents;
}

export function query(): QueryBuilder {
  return new QueryBuilder();
}

export interface QueryState {
  readonly result?: PlanResult;
  readonly loading: boolean;
  readonly error?: string;
}

export function useQuery(source: QueryBuilder | QueryPlan | undefined): QueryState {
  let plan: QueryPlan | undefined;
  let planError: string | undefined;
  try {
    plan = source instanceof QueryBuilder ? source.plan() : source;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return planError !== undefined ? { loading: false, error: planError } : state;
}
