/**
 * Files on their way to the server, and the placeholder that holds each one's place.
 *
 * **The placeholder** is an embed of `attachment://waiting-<token>`, written once when the
 * file is pasted and unique by its token. Read mode shows the file from this device while
 * it waits (`view.tsx`) instead of a line of text. The id is not a ULID, so the server
 * never takes it for a reference (`attachment_references`), and a device without the file
 * shows a chip saying it has not been uploaded yet. Its alt text says what is happening,
 * for the editor, which shows the source.
 *
 * Unique text is also what finds it again. The editor's insertion handle follows the
 * characters it inserted, and Android's keyboard rewrites a line with the *same* text
 * often enough (Chrome reconciling the IME's DOM changes) that the handle loses them; a
 * search for the exact placeholder does not care whose characters they are.
 *
 * **Every file is kept on this device** until the server has all of it, in this plugin's
 * own IndexedDB database, with the id of its upload on the server once it has one
 * (`uploader.ts`). That is what lets an upload carry on where it stopped — after a dropped
 * connection (`dev-docs/resolved/SYNC-DECISIONS.md` §8), a reload, or a pause — rather
 * than start again. Only when the files kept would pass {@link QUEUE_LIMIT_BYTES} does a
 * file go up from memory alone, and then a reload loses it.
 *
 * **What each file is doing** (`transfers`): in memory, per tab.
 *
 * Named `ddd:…` so signing out deletes it with the rest of this device's copy.
 */

export const QUEUE_DB = "ddd:attachments";
const STORE = "waiting";

/** What may be kept on a device, in total. Beyond it a file uploads from memory only. */
export const QUEUE_LIMIT_BYTES = 100 * 1024 * 1024;

export interface WaitingUpload {
  readonly token: string;
  readonly documentId: string;
  /** The placeholder in the text, exactly. */
  readonly placeholder: string;
  readonly name: string;
  readonly type: string;
  readonly as: "preview" | "link";
  readonly blob: Blob;
  readonly at: number;
  /** The server's upload session, once one is open: where a resumed upload carries on. */
  readonly uploadId?: string;
  /** Paused by the person: stays paused, even across a reload, until they resume it. */
  readonly paused?: boolean;
}

/** What a file on its way is doing in this tab. */
export type TransferState = "queued" | "uploading" | "paused" | "offline";

export interface Transfer {
  readonly entry: WaitingUpload;
  readonly state: TransferState;
  /** Bytes the server has. */
  readonly sent: number;
}

/** What comes before the token in a waiting file's `attachment://` id. */
const WAITING_PREFIX = "waiting-";

/** The placeholder for a file on its way to the server. */
export function waitingPlaceholder(name: string, token: string): string {
  return `![Uploading ${name.replace(/[[\]\r\n]/g, "")}…](attachment://${WAITING_PREFIX}${token})`;
}

/** The token of a waiting file's `attachment://` id, or `undefined` for an uploaded file's. */
export function waitingToken(id: string): string | undefined {
  return id.startsWith(WAITING_PREFIX) && id.length > WAITING_PREFIX.length ? id.slice(WAITING_PREFIX.length) : undefined;
}

export function newToken(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "token" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the upload queue could not be opened"));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? new Error("the upload queue could not be written"));
    });
  } finally {
    db.close();
  }
}

/** Fires whenever a file starts or stops uploading, or starts or stops waiting. */
const listeners = new Set<() => void>();
const changed = <T,>(result: T): T => {
  for (const listener of [...listeners]) listener();
  return result;
};

export function onQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const live = new Map<string, Transfer>();

export const transfers = {
  get: (token: string): Transfer | undefined => live.get(token),
  set: (transfer: Transfer): void => changed(void live.set(transfer.entry.token, transfer)),
  end: (token: string): void => changed(void live.delete(token)),
};

export const waiting = {
  all: (): Promise<WaitingUpload[]> => run("readonly", (store) => store.getAll() as IDBRequest<WaitingUpload[]>),
  get: (token: string): Promise<WaitingUpload | undefined> =>
    run("readonly", (store) => store.get(token) as IDBRequest<WaitingUpload | undefined>),
  add: (upload: WaitingUpload): Promise<IDBValidKey> => run("readwrite", (store) => store.put(upload)).then(changed),
  remove: (token: string): Promise<undefined> => run("readwrite", (store) => store.delete(token)).then(changed),
  async bytes(): Promise<number> {
    return (await waiting.all()).reduce((total, upload) => total + upload.blob.size, 0);
  },
};
