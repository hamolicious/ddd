import type { Kernel, NoticeAction } from "@kernel";

import type { EditorInsertion } from "plugin:editor";

import { reference } from "./kinds.js";
import { QUEUE_LIMIT_BYTES, transfers, waiting, type TransferState, type WaitingUpload } from "./queue.js";
import { Throughput, discardUpload, formatBytes, formatTimeLeft, sendInChunks, statusOf } from "./uploader.js";

const AT_ONCE = 2;

const REDRAW_MS = 250;

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];

const DONE_MS = 3_000;

interface Item {
  entry: WaitingUpload;
  state: TransferState;
  sent: number;
  kept: boolean;
  slot?: EditorInsertion;
  controller?: AbortController;
  readonly speed: Throughput;
  location?: string;
  failures: number;
  retry?: ReturnType<typeof setTimeout>;
  drawnAt: number;
  redraw?: ReturnType<typeof setTimeout>;
  dismiss?: () => void;
}

export interface Uploads {
  add(entry: WaitingUpload, slot?: EditorInsertion): Promise<void>;
  restore(): Promise<void>;
  reconnected(): void;
  dispose(): void;
}

export function createUploads(kernel: Kernel): Uploads {
  const items = new Map<string, Item>();
  const fetch = kernel.session.fetch.bind(kernel.session);

  const noticeId = (token: string): string => `attachments.upload.${token}`;

  const publish = (item: Item, force = true): void => {
    if (items.get(item.entry.token) !== item) return;
    transfers.set({ entry: item.entry, state: item.state, sent: item.sent });
    clearTimeout(item.redraw);
    const wait = item.drawnAt + REDRAW_MS - performance.now();
    if (!force && wait > 0) {
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
    }
  };

  const persist = async (item: Item, change: Partial<Pick<WaitingUpload, "uploadId" | "paused">>): Promise<void> => {
    item.entry = { ...item.entry, ...change };
    if (!item.kept || items.get(item.entry.token) !== item) return;
    await waiting.add(item.entry).catch((error: unknown) => {
      kernel.log.debug("an upload's progress could not be kept on this device", error);
    });
  };

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

  const attempt = async (item: Item): Promise<void> => {
    if (items.get(item.entry.token) !== item || item.state !== "uploading") return;
    item.speed.reset();
    const controller = new AbortController();
    item.controller = controller;
    publish(item);

    const work = async (): Promise<void> => {
      if (!(await holdsPlaceholder(item.entry).catch(() => true))) {
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
        clearTimeout(item.retry);
        items.delete(item.entry.token);
        transfers.end(item.entry.token);
        item.dismiss?.();
      });
    } catch (error) {
      if (controller.signal.aborted) return;
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

  const holdsPlaceholder = async (entry: WaitingUpload): Promise<boolean> => {
    const doc = await kernel.documents.open(entry.documentId);
    try {
      return doc.text.toString().includes(entry.placeholder);
    } finally {
      doc.release();
    }
  };

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

export function unreached(error: unknown): boolean {
  const status = statusOf(error);
  return status === 0 || status === 401 || (status !== undefined && status >= 500);
}
