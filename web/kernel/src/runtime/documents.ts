/**
 * `kernel.documents` over the M2 substrate: reads from the local projection and
 * the query engine, writes through the CRDT (open documents) or REST (create,
 * delete, restore).
 *
 * The splice helpers are the part with teeth. SPEC §3.3 forbids parse →
 * re-serialize → replace anywhere near frontmatter, and SPEC §11.2 calls the
 * kernel helper "mandatory discipline" — so the edits are computed by the splice
 * algorithm of `core::splice`, faithfully ported in `runtime/splice.ts` and pinned
 * to the Rust implementation by the shared conformance corpus. The port is the
 * interim state until the Wasm ABI exports the four `plan_*` functions; that file's
 * header says exactly what has to change and who owns it.
 */

import {
  KernelError,
  type CreateDocumentInput,
  type DocumentId,
  type DocumentQuery,
  type DocumentQueryResult,
  type DocumentRow,
  type DocumentSpliceApi,
  type DocumentsApi,
  type FmValue,
  type OpenDocument,
  type QuerySubscription,
  type SearchHit,
  type SearchOptions,
  type SectionLineEdit,
  type SpliceTarget,
  type TextEdit,
} from "@kernel";

import type { QueryEngine } from "../query/index.js";
import type { SyncClient } from "../sync/client.js";
import type { HydratedDoc } from "../sync/doc-hydration.js";
import {
  removeFrontmatterKey,
  removeSection,
  setFrontmatterValue,
  spliceSection,
  type SectionKeyEdit,
} from "./splice.js";

/**
 * The public `SectionLineEdit` onto the algorithm's `Option<Value>`.
 *
 * `remove: true` is `None` — the key's line goes. Everything else is `Some(value)`
 * and is written literally, `null` included, which is the whole reason `remove`
 * exists: `FmValue` already contains `null`, so one field cannot mean both "write
 * this" and "write nothing", and the strict YAML subset of SPEC §3.4 has a `null`
 * scalar that a plugin is entitled to store in its own section.
 */
const sectionEdits = (pluginId: string, edits: readonly SectionLineEdit[]): SectionKeyEdit[] =>
  edits.map((edit) => {
    if (edit.remove === true) return { key: edit.key };
    if (edit.value === null && edit.remove === undefined) warnAboutBareNull(pluginId, edit.key);
    return { key: edit.key, value: edit.value };
  });

/**
 * The one spelling whose meaning changed between kernel 1.0.0 and 1.1.0.
 *
 * Under 1.0.0 `{ key, value: null }` **removed** the key's line; under 1.1.0 it writes the
 * YAML `null` and removal is `remove: true`. The two are byte-identical on the way in, so
 * nothing can refuse the old one — and `KERNEL_API_MAJOR` is still `1`, so a plugin built
 * against 1.0.0 installs, passes the loader's boot re-check, and then quietly accretes
 * `key: null` lines where it meant to clear them. A warning is what is left: it names the
 * change at the call site that made it, which is the only place an author can act on it.
 * `docs/KERNEL-API.md`'s 1.1.0 entry records why this shipped as a minor and what would
 * make it a major.
 *
 * Once per plugin and key. A splice inside a render loop must not turn a migration note
 * into a flood.
 */
const warnedBareNulls = new Set<string>();

function warnAboutBareNull(pluginId: string, key: string): void {
  const seen = `${pluginId}:${key}`;
  if (warnedBareNulls.has(seen)) return;
  warnedBareNulls.add(seen);
  console.warn(
    `[plugin:${pluginId}] spliceSection({ key: "${key}", value: null }) writes the literal ` +
      `\`${key}: null\` since kernel 1.1.0. If you meant to delete the line, pass ` +
      `\`remove: true\`; to silence this, pass \`remove: false\` alongside the null.`,
  );
}

/** `fetch` against `/api`, carrying whatever this session authenticates with. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface DocumentsHostOptions {
  readonly engine: QueryEngine;
  readonly sync: SyncClient;
  readonly api: ApiFetch;
}

/**
 * The splice helpers, per plugin.
 *
 * Three properties hold for every method here, and they are the reason this class
 * exists at all rather than plugins doing their own text surgery:
 *
 * 1. **The plugin id is the kernel's.** `spliceSection` takes no plugin id: it is
 *    always the id this facade was built with (SPEC §3.3 — a plugin writing another
 *    plugin's section is how per-key LWW stops working).
 * 2. **Read, compute and write happen in one synchronous run** over the live
 *    `Y.Text`. Offsets are computed against the text as it is at that instant and
 *    applied before control returns to the event loop, so a remote update cannot
 *    land in between and invalidate them. Every `await` in the flow is *before* the
 *    read (hydrating the document), never between the read and the write.
 * 3. **One transaction per splice**, tagged with a stable origin
 *    (`splice:<plugin-id>`), so `y-codemirror.next` can recognise a write it did not
 *    originate and an `editor` can decide whether its `Y.UndoManager` tracks it.
 */
export class SpliceHost implements DocumentSpliceApi {
  /** Transaction origin for every write this facade makes. */
  readonly origin: string;

  constructor(
    private readonly pluginId: string,
    readonly documents: DocumentsHost,
  ) {
    this.origin = `splice:${pluginId}`;
  }

  setFrontmatterValue(target: SpliceTarget, key: string, value: FmValue): Promise<void> {
    return this.#write(target, (text) => setFrontmatterValue(text, key, value));
  }

  removeFrontmatterKey(target: SpliceTarget, key: string): Promise<void> {
    return this.#write(target, (text) => removeFrontmatterKey(text, key));
  }

  spliceSection(target: SpliceTarget, edits: readonly SectionLineEdit[]): Promise<void> {
    return this.#write(target, (text) => spliceSection(text, this.pluginId, sectionEdits(this.pluginId, edits)));
  }

  removeSection(target: SpliceTarget): Promise<void> {
    return this.#write(target, (text) => removeSection(text, this.pluginId));
  }

  /**
   * Pure. `value: null` writes the literal `null` — the same thing
   * {@link setFrontmatterValue} does with it, because this method's contract is
   * "the edits `setFrontmatterValue` would apply". Removing a key is
   * {@link removeFrontmatterKey}.
   */
  planFrontmatterValue(text: string, key: string, value: FmValue | null): readonly TextEdit[] {
    return setFrontmatterValue(text, key, value);
  }

  /** Pure. `remove: true` deletes the key's line; every other edit writes its value. */
  planSection(text: string, edits: readonly SectionLineEdit[]): readonly TextEdit[] {
    return spliceSection(text, this.pluginId, sectionEdits(this.pluginId, edits));
  }

  /**
   * Hydrate if needed, then read → plan → apply without yielding.
   *
   * A document handed in as an id is opened for the write and released again: a
   * folder drag or a properties edit on a list row must not leave a hydrated replica
   * behind holding a server subscription. A document handed in as an `OpenDocument`
   * belongs to its opener, so it is neither re-opened nor released.
   */
  async #write(target: SpliceTarget, plan: (text: string) => readonly TextEdit[]): Promise<void> {
    if (typeof target !== "string") {
      this.#applyPlan(target, plan);
      return;
    }
    const open = await this.documents.open(target);
    try {
      this.#applyPlan(open, plan);
    } finally {
      open.release();
    }
  }

  #applyPlan(target: OpenDocument, plan: (text: string) => readonly TextEdit[]): void {
    if (target.phase === "error") {
      throw new KernelError(`document "${target.id}" failed to hydrate; nothing was written`, {
        id: target.id,
      });
    }
    if (target.phase === "released") {
      throw new KernelError(`document "${target.id}" has been released`, { id: target.id });
    }
    const edits = plan(target.text.toString());
    this.apply(target, edits, this.origin);
  }

  /**
   * Applying edits needs no Rust: highest offset first, one transaction, so the
   * offsets computed against the pre-edit text stay valid as they are applied.
   */
  apply(target: OpenDocument, edits: readonly TextEdit[], origin?: unknown): void {
    if (edits.length === 0) return;
    const ordered = [...edits].sort((a, b) => b.range.start - a.range.start);
    target.doc.transact(() => {
      for (const edit of ordered) {
        const length = edit.range.end - edit.range.start;
        if (length > 0) target.text.delete(edit.range.start, length);
        if (edit.text.length > 0) target.text.insert(edit.range.start, edit.text);
      }
    }, origin);
  }
}

/**
 * The shared half of `kernel.documents`: one instance per client, wrapped in a
 * per-plugin facade so `splice` can attribute writes to the calling plugin.
 */
export class DocumentsHost {
  constructor(private readonly options: DocumentsHostOptions) {}

  async get(id: DocumentId): Promise<DocumentRow | undefined> {
    const row = await this.options.engine.get(id);
    return row as DocumentRow | undefined;
  }

  async text(id: DocumentId): Promise<string | undefined> {
    return (await this.get(id))?.content;
  }

  async query(query: DocumentQuery): Promise<DocumentQueryResult> {
    return (await this.options.engine.run(query)) as DocumentQueryResult;
  }

  async subscribe(query: DocumentQuery): Promise<QuerySubscription> {
    return (await this.options.engine.subscribe(query)) as unknown as QuerySubscription;
  }

  async search(text: string, options: SearchOptions = {}): Promise<readonly SearchHit[]> {
    return this.options.engine.searchDocuments(text, options);
  }

  async open(id: DocumentId): Promise<OpenDocument> {
    const hydrated: HydratedDoc = await this.options.sync.open(id);
    return hydrated;
  }

  /**
   * Create through REST (SPEC §5.1: the client mints the id, the server stamps the
   * timestamps). The document arrives back through the feed like any other change —
   * there is no second write path into the local store.
   */
  async create(input: CreateDocumentInput): Promise<DocumentId> {
    const response = await this.options.api("/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.id ? { id: input.id, content: input.text } : { content: input.text }),
    });
    const body = (await response.json()) as { id?: string };
    if (typeof body.id !== "string") throw new Error("create: server returned no id");
    return body.id;
  }

  async delete(id: DocumentId): Promise<void> {
    await this.options.api(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async restore(id: DocumentId): Promise<void> {
    await this.options.api(`/documents/${encodeURIComponent(id)}/restore`, { method: "POST" });
  }

  forPlugin(pluginId: string): DocumentsApi {
    const splice = new SpliceHost(pluginId, this);
    return {
      get: (id) => this.get(id),
      text: (id) => this.text(id),
      query: (query) => this.query(query),
      subscribe: (query) => this.subscribe(query),
      search: (text, options) => this.search(text, options),
      open: (id) => this.open(id),
      create: (input) => this.create(input),
      delete: (id) => this.delete(id),
      restore: (id) => this.restore(id),
      splice,
    };
  }
}
