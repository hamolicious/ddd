export const QUEUE_DB = "ddd:attachments";
const STORE = "waiting";

export const QUEUE_LIMIT_BYTES = 100 * 1024 * 1024;

export interface WaitingUpload {
  readonly token: string;
  readonly documentId: string;
  readonly placeholder: string;
  readonly name: string;
  readonly type: string;
  readonly as: "preview" | "link";
  readonly blob: Blob;
  readonly at: number;
  readonly uploadId?: string;
  readonly paused?: boolean;
}

export type TransferState = "queued" | "uploading" | "paused" | "offline";

export interface Transfer {
  readonly entry: WaitingUpload;
  readonly state: TransferState;
  readonly sent: number;
}

const WAITING_PREFIX = "waiting-";

export function waitingPlaceholder(name: string, token: string): string {
  return `![Uploading ${name.replace(/[[\]\r\n]/g, "")}…](attachment://${WAITING_PREFIX}${token})`;
}

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
