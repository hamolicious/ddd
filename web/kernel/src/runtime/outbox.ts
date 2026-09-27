/**
 * Changes made while the server cannot be reached (`dev-docs/resolved/SYNC-DECISIONS.md` §1–§3).
 *
 * Text edits already wait in each note's replica and journal (`sync/doc-hydration.ts`).
 * What they cannot carry are the three writes that are not text: **creating** a note,
 * moving one **to Trash**, and **restoring** it. Those wait here, in order, in the
 * `meta` store (so a reload keeps them), and go to the server on the next connection.
 *
 * Each one shows at once: the list reads the local projection, so a queued change
 * writes a *local row* there ({@link StoredRow.local}). The feed's next row for the id
 * replaces it, so the server stays the source of truth.
 *
 * Three rules keep this safe:
 *
 * - **In order, one tab at a time.** A trash then a restore must arrive as a trash then
 *   a restore; tabs share the queue, so draining takes a Web Lock.
 * - **A note made here is created from its own CRDT state**, never from its text. Its
 *   later edits then merge into it, and a create sent twice (the reply was lost) is
 *   harmless: the second one answers 409, and the server's state is checked to hold ours.
 * - **Nothing typed is dropped.** A note whose id turns out to be taken is saved as a
 *   new note; a change the server refuses is undone locally and the person is told.
 */

import * as Y from "yjs";

import type { StoredRow, ProjectionStore } from "../store/projection-store.js";
import type { DocHydrator } from "../sync/doc-hydration.js";
import type { ParsedDocument } from "../wasm/index.js";
import type { NoticeCenter } from "./notices.js";

export const OUTBOX_KEY = "outbox";

export type OutboxOp =
  | { readonly kind: "create"; readonly id: string; readonly at: number; readonly state: Uint8Array }
  | { readonly kind: "delete" | "restore"; readonly id: string; readonly at: number; readonly before?: StoredRow };

/** `kernel.session.fetch`: throws `{ status, code }` errors; `status: 0` is offline. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** The request did not get a verdict from the server: try again on the next connection. */
export function isTransient(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === undefined || status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;
}

export interface OutboxOptions {
  readonly store: ProjectionStore;
  readonly hydrator: DocHydrator;
  readonly api: ApiFetch;
  readonly notices: NoticeCenter;
  /** `true` when the server is worth asking right now. */
  readonly online: () => boolean;
  /** Save text as a brand-new note (the recovery path). */
  readonly createNote: (text: string) => Promise<string>;
  /** The queue's length changed. */
  readonly onChange?: (ops: readonly OutboxOp[]) => void;
}

type Verdict = "done" | "stop" | "skip";

export class Outbox {
  #draining: Promise<void> | undefined;
  /** Ops already reported as refused this session, so a retry does not repeat the notice. */
  readonly #reported = new Set<string>();

  constructor(private readonly options: OutboxOptions) {}

  async ops(): Promise<OutboxOp[]> {
    return (await this.options.store.getMeta?.<OutboxOp[]>(OUTBOX_KEY)) ?? [];
  }

  async isEmpty(): Promise<boolean> {
    return (await this.ops()).length === 0;
  }

  async add(op: OutboxOp): Promise<void> {
    await this.#update((ops) => [...ops, op]);
    void this.drain();
  }

  /** Send what is queued, oldest first. Stops at the first change the server did not answer. */
  drain(): Promise<void> {
    if (!this.options.online()) return Promise.resolve();
    this.#draining ??= this.#withLock(() => this.#drain()).finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #drain(): Promise<void> {
    const skipped = new Set<string>();
    for (;;) {
      const op = (await this.ops()).find((candidate) => !skipped.has(key(candidate)));
      if (!op || !this.options.online()) return;
      const verdict = await this.#send(op).catch((): Verdict => "stop");
      if (verdict === "stop") return;
      if (verdict === "skip") {
        skipped.add(key(op));
        continue;
      }
      await this.#update((ops) => ops.filter((candidate) => key(candidate) !== key(op)));
    }
  }

  async #send(op: OutboxOp): Promise<Verdict> {
    const { api } = this.options;
    const path = `/documents/${encodeURIComponent(op.id)}`;
    try {
      if (op.kind === "create") {
        await api("/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: op.id, state: toBase64(op.state) }),
        });
        this.options.hydrator.created(op.id);
        return "done";
      }
      await api(op.kind === "delete" ? path : `${path}/restore`, { method: op.kind === "delete" ? "DELETE" : "POST" });
      return "done";
    } catch (error) {
      if (isTransient(error)) return "stop";
      const status = (error as { status?: number }).status;
      if (op.kind === "create") return this.#createRefused(op, status, error);
      // Trashing a note that is gone, or already where it was asked to go: done.
      if (status === 404 || status === 410 || status === 409) return "done";
      await this.#undo(op);
      this.#report(op, `${await this.#title(op.id)} could not be ${op.kind === "delete" ? "moved to Trash" : "restored"}: ${message(error)}`);
      return "done";
    }
  }

  async #createRefused(op: Extract<OutboxOp, { kind: "create" }>, status: number | undefined, error: unknown): Promise<Verdict> {
    if (status === 409 && (await this.#serverHolds(op))) {
      // Ours: the first attempt landed and its reply was lost.
      this.options.hydrator.created(op.id);
      return "done";
    }
    if (status === 409 || status === 410) {
      // The id belongs to another note. Nothing typed is lost: it becomes a new note.
      const text = (await this.options.hydrator.localText(op.id)) ?? "";
      await this.options.hydrator.forget(op.id);
      await this.options.store.deleteLocal?.([op.id]);
      const created = await this.options.createNote(text);
      this.options.notices.notify({
        id: `kernel:outbox:${op.id}`,
        level: "warning",
        message: "A note made offline could not keep its id, so it was saved as a new note.",
        actions: [{ label: "Open it", run: () => void (location.hash = `#/doc/${created}`) }],
      });
      return "done";
    }
    // Refused as it is (too large, say): it stays on this device and is offered again
    // next time; the rest of the queue goes on without it.
    this.#report(op, `${await this.#title(op.id)} is on this device only: the server refused it (${message(error)}).`);
    return "skip";
  }

  /** The server's copy already contains the state this device created the note from. */
  async #serverHolds(op: Extract<OutboxOp, { kind: "create" }>): Promise<boolean> {
    try {
      const response = await this.options.api(`/documents/${encodeURIComponent(op.id)}?format=crdt`, {
        headers: { accept: "application/octet-stream" },
      });
      const server = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(new Uint8Array(await response.arrayBuffer())));
      for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(op.state))) {
        if ((server.get(client) ?? 0) < clock) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Put back the row as it was before a refused trash or restore. */
  async #undo(op: Extract<OutboxOp, { kind: "delete" | "restore" }>): Promise<void> {
    const current = await this.options.store.get(op.id);
    if (op.before && current?.local) await this.options.store.putLocal?.([op.before]);
  }

  #report(op: OutboxOp, text: string): void {
    if (this.#reported.has(key(op))) return;
    this.#reported.add(key(op));
    this.options.notices.notify({ id: `kernel:outbox:${key(op)}`, level: "error", message: text });
  }

  async #title(id: string): Promise<string> {
    const row = await this.options.store.get(id).catch(() => undefined);
    return row ? `“${row.title}”` : "A note";
  }

  async #update(change: (ops: OutboxOp[]) => OutboxOp[]): Promise<void> {
    const next = change(await this.ops());
    await this.options.store.setMeta?.(OUTBOX_KEY, next);
    this.options.onChange?.(next);
  }

  async #withLock(run: () => Promise<void>): Promise<void> {
    const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
    if (!locks) return run();
    await locks.request("life-manager:outbox", run);
  }
}

/**
 * Local rows: what the list shows for a change the server does not have yet. Each one
 * starts from the row as it is now, so a newer row from the feed is never rolled back
 * past what it says, only has this device's unsent change laid over it.
 */
export class LocalRows {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: ProjectionStore,
    private readonly parse: (text: string) => ParsedDocument,
    private readonly userId: string,
  ) {}

  /** A note made on this device. */
  async created(id: string, text: string): Promise<void> {
    if (await this.store.get(id)) return;
    const now = new Date().toISOString();
    await this.store.putLocal?.([
      {
        id,
        seq: 0,
        ...this.#derive(text),
        content: text,
        materialized_version: "local",
        created_at: now,
        created_by: this.userId,
        updated_at: now,
        updated_by: this.userId,
        deleted: false,
        deleted_at: null,
        deleted_by: null,
        purged: false,
      } as StoredRow,
    ]);
  }

  /** An edit that has not reached the server; coalesced, since it fires per keystroke. */
  edited(id: string, text: string): void {
    const pending = this.#timers.get(id);
    if (pending !== undefined) clearTimeout(pending);
    this.#timers.set(
      id,
      setTimeout(() => {
        this.#timers.delete(id);
        void this.#edited(id, text);
      }, 250),
    );
  }

  async #edited(id: string, text: string): Promise<void> {
    const row = await this.store.get(id);
    if (!row || row.content === text) return;
    await this.store.putLocal?.([
      { ...row, ...this.#derive(text), content: text, updated_at: new Date().toISOString(), updated_by: this.userId },
    ]);
  }

  /** Trash or restore, before the server has it. */
  async trashed(id: string, deleted: boolean): Promise<StoredRow | undefined> {
    const row = await this.store.get(id);
    if (!row) return undefined;
    const now = new Date().toISOString();
    await this.store.putLocal?.([
      deleted
        ? { ...row, deleted: true, deleted_at: now, deleted_by: this.userId }
        : { ...row, deleted: false, deleted_at: null, deleted_by: null },
    ]);
    return row;
  }

  #derive(text: string): Pick<StoredRow, "title" | "fm" | "plugins" | "fm_parse_error"> {
    try {
      const parsed = this.parse(text);
      return { title: parsed.title, fm: parsed.fm, plugins: parsed.plugins, fm_parse_error: parsed.fm_parse_error };
    } catch {
      // No Wasm core: a title from the first line keeps the list readable.
      const first = text.split("\n").find((line) => line.trim() !== "")?.replace(/^#+\s*/, "").trim();
      return { title: first || "Untitled", fm: {}, plugins: {}, fm_parse_error: false };
    }
  }
}

const key = (op: OutboxOp): string => `${op.kind}:${op.id}:${op.at}`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
