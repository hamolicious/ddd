const DATABASE = "ddd:obsidian-importer";
const STORE = "attachment-uploads";

export interface UploadedAttachment {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
}

export interface AttachmentCheckpoint {
  readonly key: string;
  readonly archive: string;
  readonly path: string;
  readonly uploadId?: string;
  readonly attachment?: UploadedAttachment;
}

export function checkpointKey(archive: string, path: string): string {
  return JSON.stringify([archive, path]);
}

export async function readCheckpoint(
  archive: string,
  path: string,
): Promise<AttachmentCheckpoint | undefined> {
  return run("readonly", (store) => store.get(checkpointKey(archive, path)));
}

export async function writeCheckpoint(checkpoint: AttachmentCheckpoint): Promise<void> {
  await run("readwrite", (store) => store.put(checkpoint));
}

export async function removeCheckpoint(archive: string, path: string): Promise<void> {
  await run("readwrite", (store) => store.delete(checkpointKey(archive, path)));
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the Obsidian import checkpoint could not be opened"));
  });
}

function run<T>(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const pending = request(transaction.objectStore(STORE));
        transaction.oncomplete = () => {
          db.close();
          resolve(pending.result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? new Error("the Obsidian import checkpoint could not be written"));
        };
        transaction.onabort = transaction.onerror;
      }),
  );
}
