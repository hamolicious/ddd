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
import type { ParsedDocument } from "../wasm/index.js";
import { NoticeCenter } from "./notices.js";
import { OfflineCopies } from "./offline-copies.js";
import { LocalRows, Outbox, isTransient } from "./outbox.js";
import { mintUlid } from "./ulid.js";
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
 * `dev-docs/resolved/KERNEL-API.md`'s 1.1.0 entry records why this shipped as a minor and what would
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
  readonly notices?: NoticeCenter;
  /** Signed-in user, stamped on rows this device writes before the server does. */
  readonly userId?: string;
  /** The shared core's parser, for those rows' title and frontmatter. */
  readonly parse?: (text: string) => ParsedDocument;
}

/** How long after a connection the offline copies start being refreshed. */
const COPIES_DELAY_MS = 2_000;

/** How long after offline edits are sent a trash elsewhere is still news. */
const TRASHED_WATCH_MS = 30_000;

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
  readonly outbox: Outbox;
  readonly local: LocalRows;
  readonly copies: OfflineCopies;

  readonly #notices: NoticeCenter;

  constructor(private readonly options: DocumentsHostOptions) {
    const store = options.sync.store;
    this.#notices = options.notices ?? new NoticeCenter();
    const parse =
      options.parse ??
      ((): ParsedDocument => {
        throw new Error("no parser");
      });
    this.local = new LocalRows(store, parse, options.userId ?? "");
    this.outbox = new Outbox({
      store,
      hydrator: options.sync.docs,
      api: options.api,
      notices: this.#notices,
      online: () => this.#online(),
      createNote: (text) => this.create({ text }),
      // A queued create is counted by its note; trash and restore have none.
      onChange: (ops) => options.sync.docs.setQueued?.(ops.filter((op) => op.kind !== "create").length),
    });
    this.copies = new OfflineCopies({
      store,
      hydrator: options.sync.docs,
      api: options.api,
      online: () => this.#online(),
    });
  }

  /**
   * Before the socket opens: notes made offline in an earlier session are held back from
   * subscribing until the server has created them (it would answer `not_found`).
   */
  async start(): Promise<void> {
    const ops = await this.outbox.ops().catch(() => []);
    this.options.sync.docs.setQueued(ops.filter((op) => op.kind !== "create").length);
    this.options.sync.docs.holdUntilCreated(ops.filter((op) => op.kind === "create").map((op) => op.id));
    this.copies.start();
  }

  /**
   * After every (re)connect: the queued creates, trashes and restores, in order; then
   * edits made offline in notes that are not open now.
   */
  async afterConnect(): Promise<void> {
    await this.outbox.drain().catch(() => undefined);
    await this.options.sync.docs.sendUnsynced().catch(() => undefined);
    // The offline copies are background work: not in the first moments after sign-in,
    // while the person is starting to use the page.
    setTimeout(() => void this.copies.refresh().catch(() => undefined), COPIES_DELAY_MS);
  }

  /** A local edit the server has not got: shown in the list straight away. */
  onLocalEdit(id: string, text: string): void {
    this.local.edited(id, text);
  }

  /**
   * Offline edits to `id` were just sent. If the note was moved to Trash elsewhere
   * meanwhile, say so: the edits are kept there, and nothing else would tell anyone
   * (`dev-docs/resolved/SYNC-DECISIONS.md` §3). The feed may bring the trash a moment later, so it
   * is watched for a while.
   */
  onOfflineEditsSent(id: string): void {
    const store = this.options.sync.store;
    let done = false;
    const check = async (): Promise<void> => {
      if (done) return;
      const row = await store.get(id).catch(() => undefined);
      if (!row?.deleted || row.local) return;
      const ours = (await this.outbox.ops()).some((op) => op.id === id && op.kind === "delete");
      if (ours) return;
      done = true;
      stop();
      this.#notices.notify({
        id: `kernel:trashed-while-offline:${id}`,
        level: "warning",
        message: `“${row.title}” was moved to Trash while you were offline. Your changes are kept there.`,
        actions: [
          {
            label: "Restore",
            run: () => {
              this.#notices.dismiss(`kernel:trashed-while-offline:${id}`);
              void this.restore(id);
            },
          },
          { label: "Open", run: () => void (location.hash = `#/doc/${id}`) },
        ],
      });
    };
    const unsubscribe = store.subscribe((change) => {
      if (change.applied.includes(id)) void check();
    });
    const timer = setTimeout(() => stop(), TRASHED_WATCH_MS);
    const stop = (): void => {
      unsubscribe();
      clearTimeout(timer);
    };
    void check();
  }

  /** Notes with unsent changes, open or not, plus queued trash and restore. */
  async unsentCount(): Promise<number> {
    const notes = await this.options.sync.docs.unsentIds().catch(() => []);
    const queued = (await this.outbox.ops().catch(() => [])).filter((op) => op.kind !== "create");
    return notes.length + queued.length;
  }

  /**
   * Everything on this device the server has not got, as one Markdown file: each note
   * with unsent changes in full, then any queued trash or restore. The way out when the
   * person cannot sign in again (`dev-docs/resolved/SYNC-DECISIONS.md` §6). `count` is the notes.
   */
  async exportUnsent(): Promise<{ readonly count: number; readonly text: string }> {
    const docs = this.options.sync.docs;
    const store = this.options.sync.store;
    const parts: string[] = [];
    let count = 0;
    for (const id of await docs.unsentIds()) {
      const text = await docs.localText(id);
      if (text === undefined) continue;
      const row = await store.get(id).catch(() => undefined);
      count++;
      parts.push(`<!-- note ${id}: ${row?.title ?? "Untitled"} -->\n\n${text.replace(/\n*$/, "\n")}`);
    }
    const queued = (await this.outbox.ops()).filter((op) => op.kind !== "create");
    if (queued.length > 0) {
      const lines = await Promise.all(
        queued.map(async (op) => {
          const title = (await store.get(op.id).catch(() => undefined))?.title ?? op.id;
          return `- ${op.kind === "delete" ? "Move to Trash" : "Restore"}: ${title}`;
        }),
      );
      parts.push(`<!-- also not sent -->\n\n${lines.join("\n")}\n`);
    }
    const header = `# Unsent changes\n\nSaved ${new Date().toLocaleString()}. These changes were made on this device and never reached the server.\n`;
    return { count, text: [header, ...parts].join("\n---\n\n") };
  }

  /** Worth asking the server now; otherwise changes wait in the outbox. */
  #online(): boolean {
    const status = this.options.sync.state.status;
    return status !== "offline" && status !== "auth-required" && status !== "error";
  }

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
    // Made offline in another tab: not on the server yet, so not to be subscribed.
    if (!this.options.sync.docs?.openIds?.includes(id)) {
      const row = await Promise.resolve()
        .then(() => this.options.sync.store.get(id))
        .catch(() => undefined);
      if (row?.local && row.seq === 0) this.options.sync.docs.holdUntilCreated([id]);
    }
    const hydrated: HydratedDoc = await this.options.sync.open(id);
    return hydrated;
  }

  /**
   * Create a note. The device mints the id and builds the note's CRDT state, and the
   * server creates the note from that state (SPEC §3.5, PROTOCOL.md §3.8). Online, this
   * resolves once the server has it; offline, at once — the note is on this device,
   * editable, and in the list, and it is sent on reconnect (`dev-docs/resolved/SYNC-DECISIONS.md` §1).
   */
  async create(input: CreateDocumentInput): Promise<DocumentId> {
    const id = input.id ?? mintUlid();
    const text = normalizeText(input.text);
    const docs = this.options.sync.docs;
    const state = await docs.seed(id, text);
    if (this.#online() && (await this.outbox.isEmpty())) {
      try {
        await this.options.api("/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, state: toBase64(state) }),
        });
        docs.created(id);
        return id;
      } catch (error) {
        if (!isTransient(error)) {
          await docs.forget(id);
          throw error;
        }
      }
    }
    await this.local.created(id, text);
    await this.outbox.add({ kind: "create", id, at: Date.now(), state });
    return id;
  }

  /** Move to Trash; offline, shown at once and sent on reconnect. */
  async delete(id: DocumentId): Promise<void> {
    await this.#trash(id, true);
  }

  async restore(id: DocumentId): Promise<void> {
    await this.#trash(id, false);
  }

  async #trash(id: DocumentId, deleted: boolean): Promise<void> {
    if (this.#online() && (await this.outbox.isEmpty())) {
      try {
        const path = `/documents/${encodeURIComponent(id)}`;
        await this.options.api(deleted ? path : `${path}/restore`, { method: deleted ? "DELETE" : "POST" });
        return;
      } catch (error) {
        if (!isTransient(error)) throw error;
      }
    }
    const before = await this.local.trashed(id, deleted);
    await this.outbox.add({ kind: deleted ? "delete" : "restore", id, at: Date.now(), ...(before ? { before } : {}) });
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

/** What the server does to text on the way in (SPEC §3.1): no byte-order mark, LF only. */
function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
