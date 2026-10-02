import type { FolderStatus, Kernel } from "@kernel";
import { addSection } from "plugin:settings";

import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";

import { merge3, textEdits } from "./merge.js";
import { LocalFolderSettings } from "./Settings.js";
import { FolderSync, ForeignFolderError, replicaLoading, type SyncDeps, type SyncNote } from "./sync.js";

type FoldersModule = typeof import("plugin:folders");
type AttachmentsModule = typeof import("plugin:attachments");

let foldersModule: FoldersModule | undefined;
let attachmentsModule: AttachmentsModule | undefined;

const LOCK_NAME = "ddd-local-folder";
const DISMISSED_KEY = "ddd.local-folder.dismissed";
const PROMPT_NOTICE = "local-folder.prompt";
const RECONNECT_NOTICE = "local-folder.reconnect";
const HELD_NOTICE = "local-folder.held";
const CONFLICT_NOTICE = "local-folder.conflicts";
const PAGE = 1000;
const RESCAN_MS = { watched: 30_000, polled: 4_000 };
const FULL_EVERY_MS = 10 * 60_000;

export type Phase = "unavailable" | "off" | "needs-permission" | "other-tab" | "syncing" | "idle" | "held" | "error";

export interface View {
  readonly phase: Phase;
  readonly native: boolean;
  readonly label?: string;
  readonly lastSync?: number;
  readonly error?: string;
  readonly held?: number;
  readonly conflicts: readonly string[];
}

export class Controller {
  #view: View;
  readonly #listeners = new Set<(view: View) => void>();
  #sync: FolderSync | undefined;
  #stop: (() => void) | undefined;
  #running: Promise<void> | undefined;
  #again: "no" | "quick" | "full" = "no";
  #lastFull = 0;

  constructor(private readonly kernel: Kernel) {
    const folder = kernel.capabilities.folder;
    this.#view = {
      phase: folder.support === "unavailable" ? "unavailable" : "off",
      native: folder.support === "native",
      conflicts: [],
    };
  }

  get view(): View {
    return this.#view;
  }

  subscribe(listener: (view: View) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<View>): void {
    this.#view = { ...this.#view, ...patch };
    for (const listener of this.#listeners) listener(this.#view);
  }

  get #folder() {
    return this.kernel.capabilities.folder;
  }

  async boot(): Promise<void> {
    if (this.#view.phase === "unavailable") return;
    const status = await this.#folder.status().catch((): FolderStatus => ({ state: "none" }));
    this.#apply(status);
    if (status.state === "ready") this.#start();
    else if (status.state === "needs-permission") this.#askReconnect();
    else if (this.#view.native && !dismissed()) this.#askToChoose();
  }

  #apply(status: FolderStatus): void {
    this.#set({
      phase: status.state === "ready" ? "idle" : status.state === "needs-permission" ? "needs-permission" : "off",
      ...(status.label !== undefined ? { label: status.label } : {}),
    });
  }

  async choose(): Promise<void> {
    try {
      const status = await this.#folder.choose();
      this.#dismissNotice(PROMPT_NOTICE);
      this.stop();
      this.#sync = undefined;
      this.#apply(status);
      this.#start();
    } catch (error) {
      if ((error as { code?: string }).code === "cancelled") return;
      this.#set({ phase: "error", error: message(error) });
    }
  }

  async reconnect(): Promise<void> {
    const status = await this.#folder.reconnect();
    this.#apply(status);
    if (status.state === "ready") {
      this.#dismissNotice(RECONNECT_NOTICE);
      this.#start();
    }
  }

  async disconnect(): Promise<void> {
    this.stop();
    this.#sync = undefined;
    await this.#folder.forget();
    rememberDismissed();
    this.#set({ phase: "off", conflicts: [], held: 0 });
    delete (this.#view as { label?: string }).label;
  }

  syncNow(): void {
    this.#schedule("full");
  }

  #notices = new Map<string, () => void>();

  #notice(notice: Parameters<Kernel["ui"]["notify"]>[0]): void {
    this.#notices.get(notice.id)?.();
    this.#notices.set(notice.id, this.kernel.ui.notify(notice));
  }

  #dismissNotice(id: string): void {
    this.#notices.get(id)?.();
    this.#notices.delete(id);
  }

  #askToChoose(): void {
    this.#notice({
      id: PROMPT_NOTICE,
      level: "info",
      message: "Keep your notes as files in a folder on this device?",
      detail: "They stay in step with the app while it runs. You can change this in Settings → Local folder.",
      actions: [
        { label: "Choose folder", run: () => void this.choose() },
        {
          label: "Not now",
          run: () => {
            rememberDismissed();
            this.#dismissNotice(PROMPT_NOTICE);
          },
        },
      ],
    });
  }

  #askReconnect(): void {
    this.#notice({
      id: RECONNECT_NOTICE,
      level: "info",
      message: "The browser needs your permission to keep using the notes folder.",
      actions: [{ label: "Allow", run: () => void this.reconnect() }],
    });
  }

  #start(): void {
    if (this.#stop) return;
    let stopped = false;
    const cleanups: (() => void)[] = [];
    this.#stop = () => {
      stopped = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    };

    const begin = async (): Promise<void> => {
      if (stopped) return;
      this.#sync ??= new FolderSync(deps(this.kernel));
      const onChange = (): void => this.#schedule("quick");
      cleanups.push(this.#folder.onChange(onChange));
      const subscription = await this.kernel.documents.subscribe({
        filter: EXCLUDE_MACHINE_DOCUMENTS,
        sort: [{ field: "updated_at", direction: "desc" }],
        limit: 50,
      });
      cleanups.push(subscription.onChange(debounce(onChange, 500, cleanups)), () => subscription.close());
      let status = this.kernel.sync.state.status;
      cleanups.push(
        this.kernel.sync.subscribe((state) => {
          if (state.status === "synced" && status !== "synced") onChange();
          status = state.status;
        }),
      );
      const rescan = setInterval(onChange, this.#folder.watches ? RESCAN_MS.watched : RESCAN_MS.polled);
      cleanups.push(() => clearInterval(rescan));
      const visible = (): void => {
        if (document.visibilityState === "visible") this.#schedule("full");
      };
      document.addEventListener("visibilitychange", visible);
      cleanups.push(() => document.removeEventListener("visibilitychange", visible));
      this.#schedule("full");
    };

    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks) {
      void begin();
      return;
    }
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    cleanups.push(() => release());
    void locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        this.#set({ phase: "other-tab" });
        void locks.request(LOCK_NAME, async () => {
          if (stopped) return;
          await begin();
          await held;
        });
        return;
      }
      await begin();
      await held;
    });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  #schedule(kind: "quick" | "full"): void {
    if (!this.#stop || !this.#sync) return;
    if (replicaLoading(this.kernel.sync.state)) return;
    if (this.#running) {
      if (this.#again !== "full") this.#again = kind;
      return;
    }
    this.#running = this.#pass(kind === "full" || Date.now() - this.#lastFull > FULL_EVERY_MS).finally(() => {
      this.#running = undefined;
      const again = this.#again;
      this.#again = "no";
      if (again !== "no") this.#schedule(again);
    });
  }

  async #pass(full: boolean): Promise<void> {
    const sync = this.#sync;
    if (!sync) return;
    if (this.#view.phase !== "held") this.#set({ phase: "syncing" });
    try {
      const report = await sync.run(full);
      if (full) this.#lastFull = Date.now();
      if (report.conflicts.length > 0) {
        const conflicts = [...this.#view.conflicts, ...report.conflicts];
        this.#set({ conflicts });
        this.#notice({
          id: CONFLICT_NOTICE,
          level: "warning",
          message: `${conflicts.length === 1 ? "A note was" : `${conflicts.length} notes were`} changed in the app and on disk at once.`,
          detail: `The app's version was kept. The disk's version was saved as: ${conflicts.join(", ")}`,
        });
      }
      if (report.heldDeletes > 0) {
        this.#set({ phase: "held", held: report.heldDeletes, lastSync: Date.now() });
        this.#notice({
          id: HELD_NOTICE,
          level: "warning",
          message: `${report.heldDeletes} files are missing from the notes folder.`,
          detail: "Nothing was deleted yet. If you removed them on purpose, send their notes to Trash; otherwise put them back.",
          actions: [
            { label: "Put them back", run: () => void this.#resolveHeld(false) },
            { label: "Move notes to Trash", run: () => void this.#resolveHeld(true) },
          ],
        });
        return;
      }
      this.#set({ phase: "idle", held: 0, lastSync: Date.now() });
      delete (this.#view as { error?: string }).error;
    } catch (error) {
      this.kernel.log.warn("local folder pass failed", { error: message(error) });
      this.#set({ phase: "error", error: message(error) });
      if (error instanceof ForeignFolderError) this.stop();
    }
  }

  async #resolveHeld(trash: boolean): Promise<void> {
    this.#dismissNotice(HELD_NOTICE);
    if (!this.#sync) return;
    if (trash) this.#sync.allowMassDelete();
    else await this.#sync.restoreMissing();
    this.#set({ phase: "syncing", held: 0 });
    this.#schedule("full");
  }

  clearConflicts(): void {
    this.#dismissNotice(CONFLICT_NOTICE);
    this.#set({ conflicts: [] });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
  }
}

function debounce(run: () => void, ms: number, cleanups: (() => void)[]): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  cleanups.push(() => clearTimeout(timer));
  return () => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deps(kernel: Kernel): SyncDeps {
  const documents = kernel.documents;
  const folders = (): FoldersModule | undefined => foldersModule;
  const attachments = (): AttachmentsModule | undefined => attachmentsModule;

  const revisionOf = async (attachment: string): Promise<number | undefined> => {
    try {
      const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(attachment)}/meta`);
      const meta = (await response.json()) as { revision?: unknown };
      return typeof meta.revision === "number" ? meta.revision : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    folder: kernel.capabilities.folder,
    owner: kernel.session.user.id,
    async notes(): Promise<readonly SyncNote[]> {
      const tree = folders();
      const out: SyncNote[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await documents.query({ filter: EXCLUDE_MACHINE_DOCUMENTS, limit: PAGE, offset });
        for (const row of page.rows) {
          if (row.deleted || row.purged) continue;
          const content = row.content ?? (await documents.text(row.id)) ?? "";
          const attachment = row.fm["attachment"];
          out.push({
            id: row.id,
            title: row.title,
            content,
            parent: tree?.parentOf(row.id) ?? "",
            ...(typeof attachment === "string" && attachment.length > 0 ? { attachment } : {}),
          });
        }
        if (page.rows.length < PAGE) break;
      }
      return out;
    },
    async known(id: string): Promise<"gone" | "unknown"> {
      return (await documents.get(id)) ? "gone" : "unknown";
    },
    async updateNote(id, from, to) {
      const open = await documents.open(id);
      try {
        const current = open.text.toString();
        let target = to;
        if (current !== from) {
          const merged = merge3(from, current, to);
          if (merged.clean) target = merged.text;
        }
        documents.splice.apply(open, textEdits(current, target), "local-folder");
        return open.text.toString();
      } finally {
        open.release();
      }
    },
    titleEdits: (text, title) => documents.splice.planFrontmatterValue(text, "title", title),
    resolveTitle: (text) => kernel.core.resolveTitle(text),
    createNote: (text) => documents.create({ text }),
    trashNote: (id) => documents.delete(id),
    async fileNote(id, parent) {
      await folders()?.file(id, parent);
    },
    async upload(bytes, name) {
      const service = attachments();
      if (!service) return undefined;
      try {
        const response = await service.upload(new Blob([bytes.slice().buffer as ArrayBuffer]), name, { wrapper: true });
        if (response.document_id === undefined) return undefined;
        return { id: response.document_id, attachment: response.attachment.id, revision: response.attachment.revision };
      } catch (error) {
        kernel.log.warn("local folder upload failed", { name, error: message(error) });
        return undefined;
      }
    },
    async download(attachment) {
      try {
        const revision = await revisionOf(attachment);
        if (revision === undefined) return undefined;
        const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(attachment)}`);
        return { bytes: new Uint8Array(await response.arrayBuffer()), revision };
      } catch {
        return undefined;
      }
    },
    async replace(attachment, bytes, name, revision) {
      const body = new FormData();
      body.append("file", new Blob([bytes.slice().buffer as ArrayBuffer]), name);
      try {
        const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(attachment)}`, {
          method: "PUT",
          headers: { "if-match": String(revision) },
          body,
        });
        const meta = (await response.json()) as { revision?: unknown };
        return { revision: typeof meta.revision === "number" ? meta.revision : revision + 1 };
      } catch (error) {
        if ((error as { status?: number }).status === 409) return "conflict";
        return undefined;
      }
    },
    revision: revisionOf,
    now: () => Date.now(),
    sha: sha256,
  };
}

let controller: Controller | undefined;

export default function activate(kernel: Kernel): void {
  const current = new Controller(kernel);
  controller = current;
  addSection({
    id: "local-folder",
    title: "Local folder",
    order: 40,
    description: "Your notes as Markdown files in a folder on this device.",
    component: () => <LocalFolderSettings controller={current} />,
  });
  const optional = <M,>(id: string): Promise<M | undefined> =>
    kernel.plugins.optional<M>(id).catch((error: unknown) => {
      kernel.log.warn(`${id} unavailable; the local folder works without it`, error);
      return undefined;
    });
  void Promise.all([optional<FoldersModule>("folders"), optional<AttachmentsModule>("attachments")]).then(
    ([folders, attachments]) => {
      if (controller !== current) return;
      foldersModule = folders;
      attachmentsModule = attachments;
      void current.boot();
    },
  );
}

export function deactivate(): void {
  controller?.stop();
  controller = undefined;
  foldersModule = undefined;
  attachmentsModule = undefined;
}
