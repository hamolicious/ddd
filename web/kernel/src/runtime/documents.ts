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
  type ListAction,
  type ListPlan,
  type OpenDocument,
  type PlanResult,
  type PlanSubscription,
  type QueryPlan,
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
  frontmatterList,
  removeFrontmatterKey,
  removeSection,
  sectionList,
  setFrontmatterValue,
  spliceSection,
  type SectionKeyEdit,
} from "./splice.js";

const sectionEdits = (pluginId: string, edits: readonly SectionLineEdit[]): SectionKeyEdit[] =>
  edits.map((edit) => {
    if (edit.remove === true) return { key: edit.key };
    if (edit.value === null && edit.remove === undefined) warnAboutBareNull(pluginId, edit.key);
    return { key: edit.key, value: edit.value };
  });

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

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface DocumentsHostOptions {
  readonly engine: QueryEngine;
  readonly sync: SyncClient;
  readonly api: ApiFetch;
  readonly notices?: NoticeCenter;
  readonly userId?: string;
  readonly parse?: (text: string) => ParsedDocument;
}

const COPIES_DELAY_MS = 2_000;

const TRASHED_WATCH_MS = 30_000;

export class SpliceHost implements DocumentSpliceApi {
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

  async frontmatterList(target: SpliceTarget, key: string, action: ListAction): Promise<FmValue | undefined> {
    let popped: FmValue | undefined;
    await this.#write(target, (text) => {
      const plan = frontmatterList(text, key, action);
      popped = plan.popped;
      return plan.edits;
    });
    return popped;
  }

  async sectionList(target: SpliceTarget, key: string, action: ListAction): Promise<FmValue | undefined> {
    let popped: FmValue | undefined;
    await this.#write(target, (text) => {
      const plan = sectionList(text, this.pluginId, key, action);
      popped = plan.popped;
      return plan.edits;
    });
    return popped;
  }

  planFrontmatterList(text: string, key: string, action: ListAction): ListPlan {
    return frontmatterList(text, key, action);
  }

  planSectionList(text: string, key: string, action: ListAction): ListPlan {
    return sectionList(text, this.pluginId, key, action);
  }

  planFrontmatterValue(text: string, key: string, value: FmValue | null): readonly TextEdit[] {
    return setFrontmatterValue(text, key, value);
  }

  planSection(text: string, edits: readonly SectionLineEdit[]): readonly TextEdit[] {
    return spliceSection(text, this.pluginId, sectionEdits(this.pluginId, edits));
  }

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
      onChange: (ops) => options.sync.docs.setQueued?.(ops.filter((op) => op.kind !== "create").length),
    });
    this.copies = new OfflineCopies({
      store,
      hydrator: options.sync.docs,
      api: options.api,
      online: () => this.#online(),
    });
  }

  async start(): Promise<void> {
    const ops = await this.outbox.ops().catch(() => []);
    this.options.sync.docs.setQueued(ops.filter((op) => op.kind !== "create").length);
    this.options.sync.docs.holdUntilCreated(ops.filter((op) => op.kind === "create").map((op) => op.id));
    this.copies.start();
  }

  async afterConnect(): Promise<void> {
    await this.outbox.drain().catch(() => undefined);
    await this.options.sync.docs.sendUnsynced().catch(() => undefined);
    setTimeout(() => void this.copies.refresh().catch(() => undefined), COPIES_DELAY_MS);
  }

  onLocalEdit(id: string, text: string): void {
    this.local.edited(id, text);
  }

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

  async unsentCount(): Promise<number> {
    const notes = await this.options.sync.docs.unsentIds().catch(() => []);
    const queued = (await this.outbox.ops().catch(() => [])).filter((op) => op.kind !== "create");
    return notes.length + queued.length;
  }

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

  async queryPlan(plan: QueryPlan): Promise<PlanResult> {
    return (await this.options.engine.runPlan(plan)) as PlanResult;
  }

  async subscribePlan(plan: QueryPlan): Promise<PlanSubscription> {
    return (await this.options.engine.subscribePlan(plan)) as unknown as PlanSubscription;
  }

  async open(id: DocumentId): Promise<OpenDocument> {
    if (!this.options.sync.docs?.openIds?.includes(id)) {
      const row = await Promise.resolve()
        .then(() => this.options.sync.store.get(id))
        .catch(() => undefined);
      if (row?.local && row.seq === 0) this.options.sync.docs.holdUntilCreated([id]);
    }
    const hydrated: HydratedDoc = await this.options.sync.open(id);
    return hydrated;
  }

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
      queryPlan: (plan) => this.queryPlan(plan),
      subscribePlan: (plan) => this.subscribePlan(plan),
      open: (id) => this.open(id),
      create: (input) => this.create(input),
      delete: (id) => this.delete(id),
      restore: (id) => this.restore(id),
      splice,
    };
  }
}

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
