import type * as Y from "yjs";

import type { CoreMap, FmValue, Iso8601, Unsubscribe } from "./types.js";

export type DocumentId = string;

export type FilterJson = { readonly [key: string]: unknown };

export type SortDirection = "asc" | "desc";

export interface SortKey {
  readonly field: string;
  readonly direction: SortDirection;
}

export interface DocumentRow {
  readonly id: DocumentId;
  readonly title: string;
  readonly content?: string;
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
}

export interface DocumentQuery {
  readonly filter?: FilterJson;
  readonly sort?: readonly SortKey[];
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly includeDeleted?: boolean;
}

export interface DocumentQueryResult {
  readonly rows: readonly DocumentRow[];
  readonly total: number;
}

export interface QuerySubscription {
  readonly result: DocumentQueryResult;
  onChange(listener: (result: DocumentQueryResult) => void): Unsubscribe;
  close(): void;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly prefix?: boolean;
  readonly fuzzy?: number | boolean;
  readonly fields?: readonly ("title" | "content" | "fm")[];
  readonly includeDeleted?: boolean;
  readonly filter?: FilterJson;
}

export interface SearchHit {
  readonly id: DocumentId;
  readonly score: number;
  readonly terms: readonly string[];
}

export interface QueryPlan {
  readonly text?: string;
  readonly filter?: FilterJson;
  readonly sort?: readonly string[];
  readonly trash?: "live" | "trashed" | "all";
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly snippets?: boolean;
}

export interface PlanSnippet {
  readonly text: string;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly line: number;
}

export interface PlanHit {
  readonly score: number;
  readonly terms: readonly string[];
  readonly snippet?: PlanSnippet;
}

export interface PlanResult {
  readonly rows: readonly DocumentRow[];
  readonly total: number;
  readonly nextCursor?: string;
  readonly hits: Readonly<Record<DocumentId, PlanHit>>;
}

export interface PlanSubscription {
  readonly result: PlanResult;
  onChange(listener: (result: PlanResult) => void): Unsubscribe;
  close(): void;
}

export type DocumentPhase = "hydrating" | "live" | "error" | "released";

export interface OpenDocument {
  readonly id: DocumentId;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly phase: DocumentPhase;
  onAwareness(listener: (payload: Uint8Array) => void): Unsubscribe;
  sendAwareness(payload: Uint8Array): void;
  release(): void;
}

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface TextEdit {
  readonly range: TextRange;
  readonly text: string;
}

export interface SectionLineEdit {
  readonly key: string;
  readonly value: FmValue | null;
  readonly remove?: boolean;
}

export type ListAction =
  | { readonly action: "push"; readonly value: FmValue }
  | { readonly action: "insert"; readonly index: number; readonly value: FmValue }
  | { readonly action: "remove"; readonly value: FmValue }
  | { readonly action: "pop" };

export interface ListPlan {
  readonly edits: readonly TextEdit[];
  readonly popped?: FmValue;
}

export type SpliceTarget = DocumentId | OpenDocument;

export interface DocumentSpliceApi {
  setFrontmatterValue(target: SpliceTarget, key: string, value: FmValue): Promise<void>;
  removeFrontmatterKey(target: SpliceTarget, key: string): Promise<void>;
  spliceSection(target: SpliceTarget, edits: readonly SectionLineEdit[]): Promise<void>;
  removeSection(target: SpliceTarget): Promise<void>;
  frontmatterList(target: SpliceTarget, key: string, action: ListAction): Promise<FmValue | undefined>;
  sectionList(target: SpliceTarget, key: string, action: ListAction): Promise<FmValue | undefined>;

  planFrontmatterValue(text: string, key: string, value: FmValue | null): readonly TextEdit[];
  planSection(text: string, edits: readonly SectionLineEdit[]): readonly TextEdit[];
  planFrontmatterList(text: string, key: string, action: ListAction): ListPlan;
  planSectionList(text: string, key: string, action: ListAction): ListPlan;
  apply(target: OpenDocument, edits: readonly TextEdit[], origin?: unknown): void;
}

export interface CreateDocumentInput {
  readonly id?: DocumentId;
  readonly text: string;
}

export interface DocumentsApi {
  get(id: DocumentId): Promise<DocumentRow | undefined>;
  text(id: DocumentId): Promise<string | undefined>;
  query(query: DocumentQuery): Promise<DocumentQueryResult>;
  subscribe(query: DocumentQuery): Promise<QuerySubscription>;
  search(text: string, options?: SearchOptions): Promise<readonly SearchHit[]>;
  queryPlan(plan: QueryPlan): Promise<PlanResult>;
  subscribePlan(plan: QueryPlan): Promise<PlanSubscription>;
  open(id: DocumentId): Promise<OpenDocument>;
  create(input: CreateDocumentInput): Promise<DocumentId>;
  delete(id: DocumentId): Promise<void>;
  restore(id: DocumentId): Promise<void>;
  readonly splice: DocumentSpliceApi;
}
