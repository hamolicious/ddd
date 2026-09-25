/**
 * `kernel.documents` — the only domain model the kernel knows: **a document is
 * text** (body + frontmatter + `%%%` machine sections, SPEC §2).
 *
 * Three things live here and nothing else does:
 *
 * 1. **Reads are local.** `query`/`subscribe`/`search` run against the replicated
 *    projection in IndexedDB through the shared Wasm evaluator — online or offline,
 *    live-updating (SPEC §4.1, §4.2). No plugin reaches for `/api/documents` to
 *    browse; the REST endpoints exist for scripts and backend plugins.
 * 2. **Writes to an open document are CRDT text edits.** `open()` hydrates the
 *    `Y.Doc` lazily and hands over the one root `Y.Text`.
 * 3. **Metadata writes are splices, never round-trips** (SPEC §3.3). `splice` is
 *    the *mandatory* path for `fm` values and for a plugin's own `%%%` section:
 *    parse→re-serialize→replace destroys comments and corrupts under concurrent
 *    edits, and whole-section rewrites throw away the per-key LWW that line
 *    splices reconstruct (SPEC §11.2).
 *
 * **FROZEN.**
 */

import type * as Y from "yjs";

import type { CoreMap, FmValue, Iso8601, Unsubscribe } from "./types.js";

export type DocumentId = string;

/** The filter DSL wire form (SPEC §4.2) — ours, not Mongo's. */
export type FilterJson = { readonly [key: string]: unknown };

export type SortDirection = "asc" | "desc";

/** One sort key: a dotted projection path (`title`, `fm.path`, `updated_at`). */
export interface SortKey {
  readonly field: string;
  readonly direction: SortDirection;
}

/**
 * One replicated document row (SPEC §4.1). `content` is the whole materialized
 * text including frontmatter and `%%%` sections — a viewer hides those, it does
 * not get a pre-stripped body.
 */
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
  /** `true` ⇒ permanently purged; the row and any local replica are gone. */
  readonly purged: boolean;
}

export interface DocumentQuery {
  readonly filter?: FilterJson;
  readonly sort?: readonly SortKey[];
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
  /** Default `false`: tombstoned rows are the Trash view's business. */
  readonly includeDeleted?: boolean;
}

export interface DocumentQueryResult {
  readonly rows: readonly DocumentRow[];
  /** Matches before `limit`/`offset` — the count a UI shows. */
  readonly total: number;
}

/** A live query. `result` is always current; `onChange` fires after every change that alters it. */
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
  /** Intersect the ranked hits with a filter. */
  readonly filter?: FilterJson;
}

export interface SearchHit {
  readonly id: DocumentId;
  readonly score: number;
  /** Terms that matched, for highlighting. */
  readonly terms: readonly string[];
}

export type DocumentPhase = "hydrating" | "live" | "error" | "released";

/**
 * A hydrated document. The `Y.Text` is the single source of truth for the whole
 * text; `doc` is there for `y-codemirror.next` and `Y.UndoManager`.
 *
 * `release()` when you are done — the last release unsubscribes from the server
 * and lets the LRU evict the replica (SPEC §4.1).
 */
export interface OpenDocument {
  readonly id: DocumentId;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly phase: DocumentPhase;
  /** Awareness payloads, relayed opaquely in both directions (SPEC §3.2). */
  onAwareness(listener: (payload: Uint8Array) => void): Unsubscribe;
  sendAwareness(payload: Uint8Array): void;
  release(): void;
}

/** A half-open range in **UTF-16 code units** — `Y.Text` indices, not byte offsets. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** Replace `range` with `text`. The one write primitive underneath every splice. */
export interface TextEdit {
  readonly range: TextRange;
  readonly text: string;
}

/**
 * One line of a `%%%` section.
 *
 * `value` is written literally — **`null` writes the YAML `null`**, which the strict
 * subset of SPEC §3.4 has and this shape previously had no way to spell. To delete a
 * key's line instead, set {@link SectionLineEdit.remove}; `value` is then ignored and
 * may be anything.
 *
 * `remove` is an additive optional field (`web/CONTRACTS.md`: the one exception to the
 * frozen surface). It exists because a single `value` field cannot mean both "write
 * this" and "write nothing": `FmValue` already contains `null`, so the older reading —
 * `value: null` deletes — spent the only spelling JSON has for an explicit null on
 * deletion, and the algorithm underneath (`core::splice::SectionLineEdit`, an
 * `Option<Value>`) could express a distinction the contract could not.
 */
export interface SectionLineEdit {
  readonly key: string;
  readonly value: FmValue | null;
  /**
   * Delete the key's line. A key that is not there is not an error.
   *
   * **Spell it `false` when you are writing a `null` on purpose.** Under kernel 1.0.0 a
   * bare `{ key, value: null }` *deleted* the line, and the two spellings are identical on
   * the way in, so the kernel writes the null (this contract) and warns once, naming the
   * change. `remove: false` is how a caller says which of the two they meant.
   */
  readonly remove?: boolean;
}

/** Anything a splice can be aimed at: an id, or an already-open document. */
export type SpliceTarget = DocumentId | OpenDocument;

/**
 * The splice helpers (SPEC §3.3, §6.4). Every method computes its edits with the
 * **shared Rust core** — the same code the server's `splice_section` host function
 * runs — and applies them in one `Y.Doc` transaction.
 *
 * Two rules a caller cannot opt out of:
 *
 * - A plugin may splice **only its own** `%%%` section. `spliceSection` takes no
 *   plugin id: it is the calling plugin's, always. Writing another plugin's
 *   section is how per-key LWW stops working.
 * - Frontmatter is human-owned (SPEC §3.3). `setFrontmatterValue` replaces one
 *   key's value span; it never reformats, reorders or re-serializes the block, and
 *   it is the only sanctioned way for a UI (properties panel, folder drag) to
 *   write `fm`.
 */
export interface DocumentSpliceApi {
  /** Set or insert one frontmatter key's value. Creates the block if absent. */
  setFrontmatterValue(target: SpliceTarget, key: string, value: FmValue): Promise<void>;
  /** Remove one frontmatter key's line. A missing key is not an error. */
  removeFrontmatterKey(target: SpliceTarget, key: string): Promise<void>;
  /** Line-splice the calling plugin's own `%%%` section. Creates it if absent. */
  spliceSection(target: SpliceTarget, edits: readonly SectionLineEdit[]): Promise<void>;
  /** Remove the calling plugin's whole `%%%` section (uninstall/cleanup). */
  removeSection(target: SpliceTarget): Promise<void>;

  /**
   * The edits that `setFrontmatterValue` would apply, against a text you already
   * hold. Pure; for previews, tests, and callers batching several writes into one
   * transaction with {@link apply}.
   */
  planFrontmatterValue(text: string, key: string, value: FmValue | null): readonly TextEdit[];
  /** The edits `spliceSection` would apply. Pure. */
  planSection(text: string, edits: readonly SectionLineEdit[]): readonly TextEdit[];
  /**
   * Apply edits to an open document in one transaction, highest offset first.
   * `origin` is passed to the `Y.Doc` transaction so an editor can recognise its
   * own writes (`y-codemirror.next` needs this to avoid echoing them back).
   */
  apply(target: OpenDocument, edits: readonly TextEdit[], origin?: unknown): void;
}

export interface CreateDocumentInput {
  /** Client-mintable ULID (SPEC §3.5). Omit and the kernel mints one. */
  readonly id?: DocumentId;
  /** The full text, frontmatter and sections included. */
  readonly text: string;
}

export interface DocumentsApi {
  /** One projection row from the local store. */
  get(id: DocumentId): Promise<DocumentRow | undefined>;
  /** The materialized text from the local store (`undefined` if unknown offline). */
  text(id: DocumentId): Promise<string | undefined>;
  /** One-shot local query. */
  query(query: DocumentQuery): Promise<DocumentQueryResult>;
  /** Live local query; re-runs only when a change can alter the result. */
  subscribe(query: DocumentQuery): Promise<QuerySubscription>;
  /** Ranked full-text search over the local index (SPEC §4.2). */
  search(text: string, options?: SearchOptions): Promise<readonly SearchHit[]>;
  /** Hydrate for editing. Reference-counted: every `open` needs a `release`. */
  open(id: DocumentId): Promise<OpenDocument>;
  /** Create from full text. Resolves once the server has accepted the id. */
  create(input: CreateDocumentInput): Promise<DocumentId>;
  /** Tombstone → Trash for 30 days (SPEC §3.5). Not a purge. */
  delete(id: DocumentId): Promise<void>;
  /** Restore a tombstoned document. */
  restore(id: DocumentId): Promise<void>;
  readonly splice: DocumentSpliceApi;
}
