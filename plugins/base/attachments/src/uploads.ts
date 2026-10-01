/**
 * Every file on its way to the server from this tab: sending them (`uploader.ts`), a
 * notice for each with a progress bar, and Pause, Resume and Cancel.
 *
 * A file is **queued** until one of {@link AT_ONCE} upload slots is free, then
 * **uploading**. Paused, it stops after nothing more than the chunk in flight and stays
 * paused, reload included, until resumed. Offline (the server did not answer), it waits
 * and is tried again when sync reconnects, or after a backoff when the server comes back
 * without the socket noticing. Any other failure takes the placeholder out and says why.
 *
 * Done, the placeholder becomes the file (`kinds.ts`'s `reference`); the editor's handle
 * on it first, then a search for its exact text in whichever document holds it
 * (`queue.ts` says why). If it was edited meanwhile, a notice says the file was uploaded
 * but not put in.
 *
 * Two tabs of the same device see the same kept files; a Web Lock per file keeps them
 * from sending the same one twice. The tab without the lock leaves it alone.
 *
 * Each notice says what the file is and where it goes (the document's title and folder),
 * and carries the bytes sent and the time left under its bar.
 */

import type { Kernel, NoticeAction } from "@kernel";

import type { EditorInsertion } from "plugin:editor";

import { reference } from "./kinds.js";
import { QUEUE_LIMIT_BYTES, transfers, waiting, type TransferState, type WaitingUpload } from "./queue.js";
import { Throughput, discardUpload, formatBytes, formatTimeLeft, sendInChunks, statusOf } from "./uploader.js";

/** Files uploading at the same time. */
const AT_ONCE = 2;

/** Notices are redrawn at most this often per file while bytes are moving. */
const REDRAW_MS = 250;

/** Waits before trying an offline file again, when nothing else says to. */
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];

/** How long the finished notice (a full bar) stays up. */
const DONE_MS = 3_000;

interface Item {
  entry: WaitingUpload;
  state: TransferState;
  sent: number;
  /** Kept in IndexedDB, so it survives a reload. */
  kept: boolean;
  slot?: EditorInsertion;
  controller?: AbortController;
  readonly speed: Throughput;
  /** Where the file goes, for its notice: `“Trip notes” in travel/2026`. */
  location?: string;
  failures: number;
  retry?: ReturnType<typeof setTimeout>;
  drawnAt: number;
  redraw?: ReturnType<typeof setTimeout>;
  /** Takes its notice down. */
  dismiss?: () => void;
}

export interface Uploads {
  /** Upload a file whose placeholder is already in the text. */
  add(entry: WaitingUpload, slot?: EditorInsertion): Promise<void>;
  /** Pick up what was kept on this device (after a reload). */
  restore(): Promise<void>;
  /** A connection is back: try every offline file now. */
  reconnected(): void;
  /**
   * The plugin is stopping: every timer cleared, every transfer aborted and let go of.
   * What was kept on this device stays kept, and `restore` picks it up next time.
   */
  dispose(): void;
}

export function createUploads(kernel: Kernel): Uploads {
  const items = new Map<string, Item>();
  const fetch = kernel.session.fetch.bind(kernel.session);

  const noticeId = (token: string): string => `attachments.upload.${token}`;

  /** Share an item's state with the viewer (`view.tsx`) and redraw its notice. */
  const publish = (item: Item, force = true): void => {
    if (items.get(item.entry.token) !== item) return; // Finished or let go meanwhile.
    transfers.set({ entry: item.entry, state: item.state, sent: item.sent });
    clearTimeout(item.redraw);
    const wait = item.drawnAt + REDRAW_MS - performance.now();
    if (!force && wait > 0) {
      // Too soon: drawn at the end of the interval instead, so the last change still shows.
      item.redraw = setTimeout(() => publish(item), wait);
      return;
    }
    item.drawnAt = performance.now();
    draw(item);
  };

  const draw = (item: Item): void => {
    const { entry, state, sent } = item;
    const size = entry.blob.size;
    const where = item.location ? ` to ${item.location}` : "";
    const verb = state === "paused" ? "Paused:" : state === "offline" ? "Waiting for a connection:" : "Uploading";
    const amount = `${formatBytes(sent)} of ${formatBytes(size)}`;
    const left =
      state === "paused"
        ? "paused"
        : state === "offline"
          ? "offline"
          : state === "queued"
            ? "waiting to start"
            : (() => {
                const seconds = item.speed.secondsLeft(size - sent);
                return seconds === undefined ? "working out time left…" : formatTimeLeft(seconds);
              })();

    const actions: NoticeAction[] = [];
    if (state === "paused") actions.push({ label: "Resume", run: () => resume(entry.token) });
    else if (state === "offline") actions.push({ label: "Try now", run: () => wake(item) });
    else actions.push({ label: "Pause", run: () => pause(entry.token) });
    actions.push({ label: "Cancel", run: () => void cancel(entry.token) });
    // Through the address, not `router`'s API: this plugin depends on no plugin.
    actions.push({ label: "Open", run: () => void (location.hash = `/doc/${encodeURIComponent(entry.documentId)}`) });

    item.dismiss = kernel.ui.notify({
      id: noticeId(entry.token),
      level: state === "offline" ? "warning" : "info",
      message: `${verb} ${entry.name}${where}`,
      actions,
      progress: { value: size > 0 ? sent / size : 0, label: `${amount} · ${left}` },
    });
  };

  const locate = async (item: Item): Promise<void> => {
    try {
      const row = await kernel.documents.get(item.entry.documentId);
      if (!row) return;
      item.location = `“${row.title.trim() || "Untitled"}”`;
      if (items.get(item.entry.token) === item) publish(item);
    } catch {
      // No title to show: the notice still names the file.
    }
  };

  const persist = async (item: Item, change: Partial<Pick<WaitingUpload, "uploadId" | "paused">>): Promise<void> => {
    item.entry = { ...item.entry, ...change };
    // Cancelled or finished meanwhile: writing it now would bring it back after a reload.
    if (!item.kept || items.get(item.entry.token) !== item) return;
    await waiting.add(item.entry).catch((error: unknown) => {
      kernel.log.debug("an upload's progress could not be kept on this device", error);
    });
  };

  /** Stop tracking a file: no notice, nothing kept, nothing in the viewer. */
  const forget = async (item: Item): Promise<void> => {
    clearTimeout(item.retry);
    clearTimeout(item.redraw);
    items.delete(item.entry.token);
    transfers.end(item.entry.token);
    item.dismiss?.();
    await waiting.remove(item.entry.token).catch(() => undefined);
  };

  const pump = (): void => {
    const running = [...items.values()].filter((item) => item.state === "uploading").length;
    const next = [...items.values()].filter((item) => item.state === "queued").sort((a, b) => a.entry.at - b.entry.at);
    for (const item of next.slice(0, Math.max(0, AT_ONCE - running))) run(item);
  };

  /**
   * Attempts per file, one after another: a resume straight after a pause waits for the
   * paused attempt to let go of the file's lock, or it would find the lock taken and take
   * this tab for another one.
   */
  const attempts = new Map<string, Promise<void>>();

  const run = (item: Item): void => {
    const { token } = item.entry;
    item.state = "uploading";
    const prior = attempts.get(token);
    const current = prior ? prior.then(() => attempt(item)) : attempt(item);
    attempts.set(token, current);
    void current.finally(() => {
      if (attempts.get(token) === current) attempts.delete(token);
    });
  };

  /** One go at sending a file. Never rejects: every outcome is a state or a notice. */
  const attempt = async (item: Item): Promise<void> => {
    if (items.get(item.entry.token) !== item || item.state !== "uploading") return;
    item.speed.reset();
    const controller = new AbortController();
    item.controller = controller;
    publish(item);

    const work = async (): Promise<void> => {
      if (!(await holdsPlaceholder(item.entry).catch(() => true))) {
        // The placeholder was deleted: nobody wants the file any more.
        if (item.entry.uploadId) discardUpload(fetch, item.entry.uploadId);
        await forget(item);
        return;
      }
      const response = await sendInChunks(fetch, item.entry.blob, item.entry.name, {
        uploadId: item.entry.uploadId,
        signal: controller.signal,
        onSession: (uploadId) => void persist(item, { uploadId }),
        onProgress: (sent) => {
          item.sent = sent;
          item.speed.sample(sent);
          publish(item, false);
        },
      });
      await finish(item, response.attachment);
    };

    try {
      await withLock(item.entry.token, work, () => {
        // Another tab is sending it. This one lets go and leaves the file to that tab.
        clearTimeout(item.retry);
        items.delete(item.entry.token);
        transfers.end(item.entry.token);
        item.dismiss?.();
      });
    } catch (error) {
      if (controller.signal.aborted) return; // Paused or cancelled: they said what happens next.
      if (unreached(error)) {
        item.state = "offline";
        publish(item);
        const wait = BACKOFF_MS[Math.min(item.failures, BACKOFF_MS.length - 1)] ?? 60_000;
        item.failures += 1;
        clearTimeout(item.retry);
        item.retry = setTimeout(() => wake(item), wait);
        return;
      }
      await fail(item, error);
    } finally {
      if (item.controller === controller) item.controller = undefined;
      pump();
    }
  };

  const finish = async (item: Item, attachment: { readonly id: string; readonly name: string }): Promise<void> => {
    const { entry } = item;
    const text = reference(attachment.name || entry.name, attachment.id, entry.as);
    const placed = item.slot?.replace(text) || (await replacePlaceholder(entry, text).catch(() => false));
    await forget(item);

    const id = noticeId(entry.token);
    const done = kernel.ui.notify({
      id,
      level: "info",
      message: `Uploaded ${entry.name}${item.location ? ` to ${item.location}` : ""}`,
      progress: { value: 1, label: formatBytes(entry.blob.size) },
    });
    setTimeout(done, DONE_MS);

    if (!placed) {
      kernel.ui.notify({
        id: `attachments.orphan.${attachment.id}`,
        level: "warning",
        message: `${entry.name} was uploaded, but its placeholder was changed, so it was not put in the document.`,
        detail: text,
      });
    }
  };

  const fail = async (item: Item, error: unknown): Promise<void> => {
    const { entry } = item;
    if (entry.uploadId) discardUpload(fetch, entry.uploadId);
    if (!item.slot?.remove()) await replacePlaceholder(entry, "").catch(() => false);
    await forget(item);
    kernel.ui.notify({
      id: `attachments.failed.${entry.token}`,
      level: "error",
      message: `${entry.name || "The pasted file"} could not be uploaded.`,
      detail: describe(error),
    });
  };

  const wake = (item: Item): void => {
    if (items.get(item.entry.token) !== item || item.state !== "offline") return;
    clearTimeout(item.retry);
    item.state = "queued";
    publish(item);
    pump();
  };

  const pause = (token: string): void => {
    const item = items.get(token);
    if (!item || item.state === "paused") return;
    clearTimeout(item.retry);
    item.state = "paused";
    item.controller?.abort();
    void persist(item, { paused: true });
    publish(item);
    pump();
  };

  const resume = (token: string): void => {
    const item = items.get(token);
    if (item?.state !== "paused") return;
    item.state = "queued";
    item.failures = 0;
    void persist(item, { paused: false });
    publish(item);
    pump();
  };

  const cancel = async (token: string): Promise<void> => {
    const item = items.get(token);
    if (!item) return;
    item.controller?.abort();
    if (item.entry.uploadId) discardUpload(fetch, item.entry.uploadId);
    if (!item.slot?.remove()) await replacePlaceholder(item.entry, "").catch(() => false);
    await forget(item);
    pump();
  };

  /** Is the placeholder still in its document? */
  const holdsPlaceholder = async (entry: WaitingUpload): Promise<boolean> => {
    const doc = await kernel.documents.open(entry.documentId);
    try {
      return doc.text.toString().includes(entry.placeholder);
    } finally {
      doc.release();
    }
  };

  /** Put `text` where a file's placeholder is, in whichever document holds it. */
  const replacePlaceholder = async (entry: WaitingUpload, text: string): Promise<boolean> => {
    const doc = await kernel.documents.open(entry.documentId);
    try {
      const at = doc.text.toString().indexOf(entry.placeholder);
      if (at < 0) return false;
      kernel.documents.splice.apply(doc, [{ range: { start: at, end: at + entry.placeholder.length }, text }], "attachments");
      return true;
    } finally {
      doc.release();
    }
  };

  const track = (entry: WaitingUpload, kept: boolean, slot?: EditorInsertion): Item => {
    const item: Item = {
      entry,
      state: entry.paused ? "paused" : "queued",
      sent: 0,
      kept,
      slot,
      speed: new Throughput(),
      failures: 0,
      drawnAt: 0,
    };
    items.set(entry.token, item);
    publish(item);
    void locate(item);
    return item;
  };

  return {
    async add(entry, slot) {
      let kept = false;
      try {
        if ((await waiting.bytes()) + entry.blob.size <= QUEUE_LIMIT_BYTES) {
          await waiting.add(entry);
          kept = true;
        }
      } catch (error) {
        kernel.log.debug("an upload could not be kept on this device; it goes from memory", error);
      }
      track(entry, kept, slot);
      pump();
    },

    async restore() {
      const kept = await waiting.all().catch(() => [] as WaitingUpload[]);
      for (const entry of kept.sort((a, b) => a.at - b.at)) {
        if (!items.has(entry.token)) track(entry, true);
      }
      pump();
    },

    reconnected() {
      for (const item of items.values()) wake(item);
    },

    dispose() {
      for (const item of [...items.values()]) {
        clearTimeout(item.retry);
        clearTimeout(item.redraw);
        items.delete(item.entry.token);
        item.controller?.abort();
        transfers.end(item.entry.token);
        item.dismiss?.();
      }
    },
  };
}

/**
 * Run `work` holding this file's Web Lock; `elsewhere` when another tab holds it. Without
 * the Web Locks API (an old WebView), just run it.
 */
async function withLock(token: string, work: () => Promise<void>, elsewhere: () => void): Promise<void> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return work();
  await locks.request(`ddd:attachments:upload:${token}`, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      elsewhere();
      return;
    }
    await work();
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** The server never answered: offline, or down. Worth keeping the file and trying later. */
export function unreached(error: unknown): boolean {
  const status = statusOf(error);
  return status === 0 || status === 401 || (status !== undefined && status >= 500);
}
