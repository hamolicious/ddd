/**
 * Files pasted while offline (`dev-docs/resolved/SYNC-DECISIONS.md` §8): kept on this device, in this
 * plugin's own IndexedDB database, and uploaded on reconnect. The placeholder stays in
 * the text meanwhile, made unique with a short token so it can be found again after a
 * reload, when the editor's insertion handle is long gone.
 *
 * Named `life-manager:…` so signing out deletes it with the rest of this device's copy.
 */

export const QUEUE_DB = "life-manager:attachments";
const STORE = "waiting";

/** What may wait on a device, in total. Beyond it a paste offline is refused as before. */
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
}

/** The placeholder for a file waiting for a connection. */
export function waitingPlaceholder(name: string, token: string): string {
  return `[Uploading ${name.replace(/[[\]\r\n]/g, "")} when back online… #${token}]`;
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

export const waiting = {
  all: (): Promise<WaitingUpload[]> => run("readonly", (store) => store.getAll() as IDBRequest<WaitingUpload[]>),
  add: (upload: WaitingUpload): Promise<IDBValidKey> => run("readwrite", (store) => store.put(upload)),
  remove: (token: string): Promise<undefined> => run("readwrite", (store) => store.delete(token)),
  async bytes(): Promise<number> {
    return (await waiting.all()).reduce((total, upload) => total + upload.blob.size, 0);
  },
};
