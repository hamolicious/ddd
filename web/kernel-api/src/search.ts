import type { CoreMap, FmValue, Iso8601 } from "./types.js";

export type SearchSourceName = "documents" | "fm" | "links" | "tasks" | "attachments";

export interface SearchDocumentColumns {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly fm_parse_error: boolean;
  readonly materialized_version: string;
  readonly created_at: Iso8601;
  readonly created_by: string | null;
  readonly updated_at: Iso8601;
  readonly updated_by: string | null;
  readonly deleted: boolean;
  readonly deleted_at: Iso8601 | null;
  readonly deleted_by: string | null;
  readonly purged: boolean;
  readonly words: number;
  readonly characters: number;
}

export type SearchDocumentRow = Omit<SearchDocumentColumns, "content" | "words" | "characters">;

export interface SearchFmColumns {
  readonly key: string;
  readonly value: FmValue;
  readonly kind: "string" | "number" | "boolean" | "date" | "null";
  readonly position: number | null;
}

export interface SearchLinkColumns {
  readonly target: string;
  readonly kind: "link" | "embed" | "frontmatter";
  readonly key: string | null;
  readonly count: number;
  readonly state: "live" | "trashed" | "missing";
}

export interface SearchTaskColumns {
  readonly line: number;
  readonly state: "open" | "done" | "other";
  readonly marker: string;
  readonly text: string;
}

export interface SearchAttachmentColumns {
  readonly attachment: string;
  readonly line: number;
}

export interface SearchSourceColumns {
  readonly documents: SearchDocumentColumns;
  readonly fm: SearchFmColumns;
  readonly links: SearchLinkColumns;
  readonly tasks: SearchTaskColumns;
  readonly attachments: SearchAttachmentColumns;
}

type Prefixed<P extends string, T> = { readonly [K in keyof T & string as `${P}${K}`]: T[K] };

export type SearchColumnsOf<S extends SearchSourceName> = S extends "documents"
  ? SearchDocumentColumns
  : SearchSourceColumns[S] & Prefixed<"doc.", SearchDocumentColumns>;

export type SearchDefaultRow<S extends SearchSourceName> = S extends "documents"
  ? SearchDocumentRow
  : Omit<SearchSourceColumns[S], never> & { readonly doc: SearchDocumentRow };

type OpenField<S extends SearchSourceName> = S extends "documents"
  ? `fm.${string}` | `plugins.${string}`
  : `doc.fm.${string}` | `doc.plugins.${string}`;

export type SearchScope = object;

export type SearchField<C extends SearchScope, O extends string> = (keyof C & string) | O;

export type SearchFieldType<C extends SearchScope, F extends string> = F extends keyof C ? C[F] : FmValue;

export type SearchSortKey<C extends SearchScope, O extends string> =
  | SearchField<C, O>
  | `-${SearchField<C, O>}`
  | "relevance"
  | "-relevance";

export type SearchCompareOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export type SearchOp =
  | SearchCompareOp
  | "in"
  | "contains"
  | "contains_any"
  | "any"
  | "every"
  | "text_contains"
  | "text_starts_with"
  | "text_ends_with"
  | "missing"
  | "exists"
  | "is_null"
  | "child_of"
  | "parent_of";

export interface SearchDateLiteral {
  readonly date: string;
}

export type SearchLiteral = string | number | boolean | null | Date | SearchDateLiteral;

type Valueless = "missing" | "exists" | "is_null";

export type SearchValue<Op extends SearchOp, T> = Op extends SearchCompareOp
  ? T | SearchLiteral
  : Op extends "in"
    ? readonly SearchLiteral[] | SearchSubquery
    : Op extends "contains_any"
      ? readonly SearchLiteral[]
      : Op extends "any" | "every"
        ? SearchLiteral | readonly [SearchCompareOp, SearchLiteral]
        : Op extends "child_of" | "parent_of" | "text_contains" | "text_starts_with" | "text_ends_with"
          ? string
          : SearchLiteral;

declare const condition: unique symbol;

export interface SearchCondition {
  readonly [condition]: true;
}

export interface SearchExpression<C extends SearchScope, O extends string> {
  <F extends SearchField<C, O>, Op extends Valueless>(field: F, op: Op): SearchCondition;
  <F extends SearchField<C, O>, Op extends Exclude<SearchOp, Valueless | "child_of">>(
    field: F,
    op: Op,
    value: SearchValue<Op, SearchFieldType<C, F>>,
  ): SearchCondition;
  <F extends SearchField<C, O>>(
    field: F,
    op: "child_of",
    value: string,
    options?: { readonly deep?: boolean },
  ): SearchCondition;
  and(...conditions: readonly SearchCondition[]): SearchCondition;
  or(...conditions: readonly SearchCondition[]): SearchCondition;
  not(condition: SearchCondition): SearchCondition;
}

declare const textExpression: unique symbol;

export interface SearchTextExpression {
  readonly [textExpression]: true;
}

export interface SearchMatch {
  term(word: string): SearchTextExpression;
  phrase(words: string): SearchTextExpression;
  prefix(start: string): SearchTextExpression;
  and(...expressions: readonly SearchTextExpression[]): SearchTextExpression;
  or(...expressions: readonly SearchTextExpression[]): SearchTextExpression;
  not(expression: SearchTextExpression): SearchTextExpression;
  in(field: "title" | "content" | "fm", expression: SearchTextExpression): SearchTextExpression;
}

export interface SearchSnippet {
  readonly text: string;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly line: number;
}

export interface SearchHitInfo {
  readonly score: number;
  readonly terms: readonly string[];
}

export interface SearchResultOptions {
  readonly total: boolean;
}

export type SearchResult<Row, Opts extends SearchResultOptions = { readonly total: false }> = {
  readonly rows: readonly Row[];
  readonly nextCursor?: string;
  readonly hits?: Readonly<Record<string, SearchHitInfo>>;
} & (Opts["total"] extends true
  ? { readonly total: number }
  : Opts["total"] extends false
    ? { readonly total?: undefined }
    : { readonly total?: number });

export interface SearchWatch<Row, Opts extends SearchResultOptions = { readonly total: false }> {
  readonly result: Omit<SearchResult<Row, Opts>, "total"> & { readonly total: number; readonly start: number };
  onChange(listener: (result: SearchResult<Row, Opts>) => void): () => void;
  window(start: number, count: number): Promise<void>;
  close(): void;
}

export type SearchPlanJson = { readonly source?: SearchSourceName; readonly stages?: readonly unknown[] };

export interface SearchSubquery {
  plan(): SearchPlanJson;
}

type Simplify<T> = { readonly [K in keyof T]: T[K] } & {};

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;

export type SearchSelectItem<C extends SearchScope, O extends string> =
  | SearchField<C, O>
  | { readonly [alias: string]: SearchField<C, O> };

type SelectedOne<C extends SearchScope, Item> = Item extends string
  ? { readonly [K in Item]: SearchFieldType<C, Item> }
  : Item extends { readonly [alias: string]: string }
    ? { readonly [K in keyof Item]: SearchFieldType<C, Item[K]> }
    : never;

export type SearchSelected<C extends SearchScope, Items extends readonly unknown[]> = Simplify<
  UnionToIntersection<SelectedOne<C, Items[number]>>
>;

type Grouped<C extends SearchScope, Fields extends readonly string[]> = Simplify<{
  readonly [K in Fields[number]]: SearchFieldType<C, K>;
}>;

type With<T, K extends string, V> = Simplify<T & { readonly [P in K]: V }>;

export interface SearchAggregateState<C, O extends string, R> {
  readonly scope: C;
  readonly open: O;
  readonly rows: R;
}

type AggScope<G, C extends SearchScope> = [G] extends [never]
  ? C
  : G extends SearchAggregateState<infer Scope extends SearchScope, string, unknown>
    ? Scope
    : never;
type AggOpen<G, O extends string> = [G] extends [never]
  ? O
  : G extends SearchAggregateState<object, infer Open, unknown>
    ? Open
    : never;
type AggRows<G> = [G] extends [never] ? {} : G extends SearchAggregateState<object, string, infer Rows> ? Rows : never;

type AfterAggregate<S extends SearchSourceName, C extends SearchScope, O extends string, G, A extends string, V, Opts extends SearchResultOptions> =
  SearchBuilder<
    S,
    With<AggRows<G>, A, V>,
    With<AggRows<G>, A, V>,
    never,
    SearchAggregateState<AggScope<G, C>, AggOpen<G, O>, With<AggRows<G>, A, V>>,
    Opts
  >;

export interface SearchFuzzyOptions {
  readonly fields?: readonly ("title" | "content" | "fm")[];
  readonly limit?: number;
  readonly maxDistance?: number;
}

export interface SearchFuzzy<Row> {
  run(): Promise<SearchResult<Row>>;
  watch(): Promise<SearchWatch<Row>>;
  plan(): SearchPlanJson;
}

export interface SearchBuilder<
  S extends SearchSourceName,
  C extends SearchScope,
  Row,
  O extends string,
  G,
  Opts extends SearchResultOptions,
> {
  text(query: string): SearchBuilder<S, With<C, "relevance", number>, Row, O, never, Opts>;
  match(build: (m: SearchMatch) => SearchTextExpression): SearchBuilder<S, With<C, "relevance", number>, Row, O, never, Opts>;
  where<F extends SearchField<C, O>, Op extends Valueless>(field: F, op: Op): SearchBuilder<S, C, Row, O, never, Opts>;
  where<F extends SearchField<C, O>, Op extends Exclude<SearchOp, Valueless | "child_of">>(
    field: F,
    op: Op,
    value: SearchValue<Op, SearchFieldType<C, F>>,
  ): SearchBuilder<S, C, Row, O, never, Opts>;
  where<F extends SearchField<C, O>>(
    field: F,
    op: "child_of",
    value: string,
    options?: { readonly deep?: boolean },
  ): SearchBuilder<S, C, Row, O, never, Opts>;
  where(build: (w: SearchExpression<C, O>) => SearchCondition): SearchBuilder<S, C, Row, O, never, Opts>;
  sort(...keys: readonly SearchSortKey<C, O>[]): SearchBuilder<S, C, Row, O, never, Opts>;
  select<const Items extends readonly SearchSelectItem<C, O>[]>(
    ...items: Items
  ): SearchBuilder<S, SearchSelected<C, Items>, SearchSelected<C, Items>, never, never, Opts>;
  distinct(): SearchBuilder<S, C, Row, O, never, Opts>;
  distinct<const Fields extends readonly SearchField<C, O>[]>(
    ...fields: Fields
  ): SearchBuilder<S, Grouped<C, Fields>, Grouped<C, Fields>, never, never, Opts>;
  groupBy<const Fields extends readonly SearchField<C, O>[]>(...fields: Fields): SearchGroupStart<S, C, O, Grouped<C, Fields>, Opts>;
  count<const A extends string = "count">(as?: A): AfterAggregate<S, C, O, G, A, number, Opts>;
  sum<F extends SearchField<AggScope<G, C>, AggOpen<G, O>>, const A extends string = "sum">(
    field: F,
    as?: A,
  ): AfterAggregate<S, C, O, G, A, number | null, Opts>;
  avg<F extends SearchField<AggScope<G, C>, AggOpen<G, O>>, const A extends string = "avg">(
    field: F,
    as?: A,
  ): AfterAggregate<S, C, O, G, A, number | null, Opts>;
  min<F extends SearchField<AggScope<G, C>, AggOpen<G, O>>, const A extends string = "min">(
    field: F,
    as?: A,
  ): AfterAggregate<S, C, O, G, A, SearchFieldType<AggScope<G, C>, F> | null, Opts>;
  max<F extends SearchField<AggScope<G, C>, AggOpen<G, O>>, const A extends string = "max">(
    field: F,
    as?: A,
  ): AfterAggregate<S, C, O, G, A, SearchFieldType<AggScope<G, C>, F> | null, Opts>;
  collect<F extends SearchField<AggScope<G, C>, AggOpen<G, O>>, const A extends string = "collect">(
    field: F,
    as?: A,
  ): AfterAggregate<S, C, O, G, A, SearchFieldType<AggScope<G, C>, F>[], Opts>;
  limit(n: number): SearchBuilder<S, C, Row, O, never, Opts>;
  offset(n: number): SearchBuilder<S, C, Row, O, never, Opts>;
  cursor(cursor: string): SearchBuilder<S, C, Row, O, never, Opts>;
  withTotal(): SearchBuilder<S, C, Row, O, never, { readonly total: true }>;
  withContent(): SearchBuilder<S, C, S extends "documents" ? With<Row, "content", string> : Row, O, never, Opts>;
  snippets(): SearchBuilder<S, C, With<Row, "snippet", SearchSnippet | null>, O, never, Opts>;
  trash(scope: "live" | "trashed" | "all"): SearchBuilder<S, C, Row, O, G, Opts>;
  fuzzy(query: string, options?: SearchFuzzyOptions): SearchFuzzy<Row>;
  run(): Promise<SearchResult<Row, Opts>>;
  watch(): Promise<SearchWatch<Row, Opts>>;
  plan(): SearchPlanJson;
}

export type SearchGroupStart<
  S extends SearchSourceName,
  C extends SearchScope,
  O extends string,
  G,
  Opts extends SearchResultOptions,
> = Pick<
  SearchBuilder<S, C, G, O, SearchAggregateState<C, O, G>, Opts>,
  "count" | "sum" | "avg" | "min" | "max" | "collect"
>;

export type SearchFrom<S extends SearchSourceName> = SearchBuilder<
  S,
  SearchColumnsOf<S>,
  SearchDefaultRow<S>,
  OpenField<S>,
  never,
  { readonly total: false }
>;

export type AnySearchRow = Readonly<Record<string, unknown>>;

export interface AnySearchBuilder {
  text(query: string): AnySearchBuilder;
  match(build: (m: SearchMatch) => SearchTextExpression): AnySearchBuilder;
  where(field: string, op: SearchOp, value?: unknown, options?: { readonly deep?: boolean }): AnySearchBuilder;
  where(build: (w: SearchExpression<object, string>) => SearchCondition): AnySearchBuilder;
  sort(...keys: readonly string[]): AnySearchBuilder;
  select(...items: readonly (string | { readonly [alias: string]: string })[]): AnySearchBuilder;
  distinct(...fields: readonly string[]): AnySearchBuilder;
  groupBy(...fields: readonly string[]): AnySearchBuilder;
  count(as?: string): AnySearchBuilder;
  sum(field: string, as?: string): AnySearchBuilder;
  avg(field: string, as?: string): AnySearchBuilder;
  min(field: string, as?: string): AnySearchBuilder;
  max(field: string, as?: string): AnySearchBuilder;
  collect(field: string, as?: string): AnySearchBuilder;
  limit(n: number): AnySearchBuilder;
  offset(n: number): AnySearchBuilder;
  cursor(cursor: string): AnySearchBuilder;
  withTotal(): AnySearchBuilder;
  withContent(): AnySearchBuilder;
  snippets(): AnySearchBuilder;
  trash(scope: "live" | "trashed" | "all"): AnySearchBuilder;
  fuzzy(query: string, options?: SearchFuzzyOptions): SearchFuzzy<AnySearchRow>;
  run(): Promise<SearchResult<AnySearchRow, SearchResultOptions>>;
  watch(): Promise<SearchWatch<AnySearchRow, SearchResultOptions>>;
  plan(): SearchPlanJson;
}

export interface SearchExecutor {
  run(plan: SearchPlanJson): Promise<SearchResult<unknown, SearchResultOptions>>;
  watch(plan: SearchPlanJson): Promise<SearchWatch<unknown, SearchResultOptions>>;
}

export interface SearchApi {
  from(): SearchFrom<"documents">;
  from<S extends SearchSourceName>(source: S): SearchFrom<S>;
  fromPlan(plan: SearchPlanJson): AnySearchBuilder;
  fromAny(source?: SearchSourceName): AnySearchBuilder;
}

type Stage = unknown;

const TEXT_MODES = {
  text_contains: "contains",
  text_starts_with: "starts_with",
  text_ends_with: "ends_with",
} as const;

function literal(value: unknown): unknown {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === "object" && typeof (value as { date?: unknown }).date === "string") {
    return { date: (value as SearchDateLiteral).date };
  }
  switch (typeof value) {
    case "string":
      return { str: value };
    case "boolean":
      return { bool: value };
    case "number":
      return Number.isInteger(value) ? { int: value } : { float: value };
    default:
      throw new TypeError(`a search value must be a string, number, boolean, null or Date, not ${typeof value}`);
  }
}

function isBuilder(value: unknown): value is { plan(): SearchPlanJson } {
  return typeof value === "object" && value !== null && typeof (value as { plan?: unknown }).plan === "function";
}

function conditionOf(field: string, op: SearchOp, value?: unknown, options?: { readonly deep?: boolean }): unknown {
  switch (op) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return { cmp: { field, op, value: literal(value) } };
    case "in":
      if (isBuilder(value)) return { in_plan: { field, plan: value.plan() } };
      return { in: { field, values: (value as readonly unknown[]).map(literal) } };
    case "contains":
      return { contains: { field, value: literal(value) } };
    case "contains_any":
      return { contains_any: { field, values: (value as readonly unknown[]).map(literal) } };
    case "any":
    case "every": {
      const [inner, operand] = Array.isArray(value) ? (value as [SearchCompareOp, unknown]) : ["eq", value];
      return { [op]: { field, op: inner, value: literal(operand) } };
    }
    case "text_contains":
    case "text_starts_with":
    case "text_ends_with":
      return { text: { field, mode: TEXT_MODES[op], value: String(value) } };
    case "missing":
    case "exists":
    case "is_null":
      return { [op]: { field } };
    case "child_of":
      return { child_of: { field, of: String(value), deep: options?.deep === true } };
    case "parent_of":
      return { parent_of: { field, of: String(value) } };
  }
}

function expression(): SearchExpression<SearchScope, string> {
  const w = ((field: string, op: SearchOp, value?: unknown, options?: { readonly deep?: boolean }) =>
    conditionOf(field, op, value, options)) as unknown as SearchExpression<SearchScope, string>;
  Object.assign(w, {
    and: (...conditions: unknown[]) => ({ and: conditions }),
    or: (...conditions: unknown[]) => ({ or: conditions }),
    not: (inner: unknown) => ({ not: inner }),
  });
  return w;
}

const matcher: SearchMatch = {
  term: (word) => ({ term: word }) as unknown as SearchTextExpression,
  phrase: (words) => ({ phrase: words }) as unknown as SearchTextExpression,
  prefix: (start) => ({ prefix: start }) as unknown as SearchTextExpression,
  and: (...expressions) => ({ and: expressions }) as unknown as SearchTextExpression,
  or: (...expressions) => ({ or: expressions }) as unknown as SearchTextExpression,
  not: (inner) => ({ not: inner }) as unknown as SearchTextExpression,
  in: (field, inner) => ({ in: { field, expr: inner } }) as unknown as SearchTextExpression,
};

function selectItems(items: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      out.push({ field: item });
      continue;
    }
    for (const [alias, field] of Object.entries(item as Record<string, string>)) out.push({ field, as: alias });
  }
  return out;
}

class Builder {
  constructor(
    private readonly executor: SearchExecutor,
    private readonly source: SearchSourceName,
    private readonly stages: readonly Stage[],
  ) {}

  #with(stage: Stage): Builder {
    return new Builder(this.executor, this.source, [...this.stages, stage]);
  }

  text(query: string): Builder {
    return this.#with({ text: query });
  }

  match(build: (m: SearchMatch) => SearchTextExpression): Builder {
    return this.#with({ match: build(matcher) });
  }

  where(field: unknown, op?: SearchOp, value?: unknown, options?: { readonly deep?: boolean }): Builder {
    if (typeof field === "function") {
      return this.#with({ where: (field as (w: SearchExpression<SearchScope, string>) => unknown)(expression()) });
    }
    return this.#with({ where: conditionOf(String(field), op as SearchOp, value, options) });
  }

  sort(...keys: readonly string[]): Builder {
    return this.#with({ sort: keys });
  }

  select(...items: readonly unknown[]): Builder {
    return this.#with({ select: selectItems(items) });
  }

  distinct(...fields: readonly string[]): Builder {
    return this.#with({ distinct: fields });
  }

  groupBy(...fields: readonly string[]): Builder {
    return this.#with({ group_by: fields });
  }

  count(as?: string): Builder {
    return this.#with({ count: as === undefined ? {} : { as } });
  }

  sum(field: string, as?: string): Builder {
    return this.#with({ sum: as === undefined ? { field } : { field, as } });
  }

  avg(field: string, as?: string): Builder {
    return this.#with({ avg: as === undefined ? { field } : { field, as } });
  }

  min(field: string, as?: string): Builder {
    return this.#with({ min: as === undefined ? { field } : { field, as } });
  }

  max(field: string, as?: string): Builder {
    return this.#with({ max: as === undefined ? { field } : { field, as } });
  }

  collect(field: string, as?: string): Builder {
    return this.#with({ collect: as === undefined ? { field } : { field, as } });
  }

  limit(n: number): Builder {
    return this.#with({ limit: n });
  }

  offset(n: number): Builder {
    return this.#with({ offset: n });
  }

  cursor(cursor: string): Builder {
    return this.#with({ cursor });
  }

  withTotal(): Builder {
    return this.#with("with_total");
  }

  withContent(): Builder {
    return this.#with("with_content");
  }

  snippets(): Builder {
    return this.#with("snippets");
  }

  trash(scope: "live" | "trashed" | "all"): Builder {
    return this.#with({ trash: scope });
  }

  fuzzy(query: string, options: SearchFuzzyOptions = {}): Builder {
    return this.#with({
      fuzzy: {
        query,
        ...(options.fields ? { fields: options.fields } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.maxDistance === undefined ? {} : { max_distance: options.maxDistance }),
      },
    });
  }

  run(): Promise<SearchResult<unknown, SearchResultOptions>> {
    return this.executor.run(this.plan());
  }

  watch(): Promise<SearchWatch<unknown, SearchResultOptions>> {
    return this.executor.watch(this.plan());
  }

  plan(): SearchPlanJson {
    return { source: this.source, stages: [...this.stages] };
  }
}

export function createSearchApi(executor: SearchExecutor): SearchApi {
  return {
    from: ((source: SearchSourceName = "documents") =>
      new Builder(executor, source, [])) as unknown as SearchApi["from"],
    fromPlan: (plan) =>
      new Builder(executor, plan.source ?? "documents", plan.stages ?? []) as unknown as AnySearchBuilder,
    fromAny: (source = "documents") => new Builder(executor, source, []) as unknown as AnySearchBuilder,
  };
}
