/**
 * The server's admin-only health endpoints (`/api/attachments/orphans`,
 * `/api/attachments/duplicates`, `/api/documents/duplicates`) and the two deletions the
 * view offers. All reads; nothing here deletes on its own.
 */

export interface AttachmentView {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A note that uses a duplicate copy. */
export interface NoteRef {
  readonly id: string;
  readonly title: string;
  readonly trashed: boolean;
}

/** A file no document references. */
export interface OrphanView {
  readonly attachment: AttachmentView;
  readonly flagged_at: string;
}

/** Files with the same name and bytes. */
export interface DuplicateFileGroup {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
  /** Oldest first. */
  readonly files: readonly {
    readonly attachment: AttachmentView;
    /** Documents (trashed ones included) that reference this copy. */
    readonly references: number;
    /** The first few of them. */
    readonly referenced_by: readonly NoteRef[];
  }[];
}

/** Live documents with the same title and text. */
export interface DuplicateDocumentGroup {
  readonly title: string;
  readonly size: number;
  /** Oldest first. */
  readonly documents: readonly {
    readonly id: string;
    readonly created_at: string;
    readonly updated_at: string;
    /** Other documents (trashed ones included) that link here with `doc://`. */
    readonly references: number;
    /** The first few of them. */
    readonly referenced_by: readonly NoteRef[];
  }[];
}

export interface HealthClient {
  orphans(): Promise<readonly OrphanView[]>;
  scanOrphans(): Promise<readonly OrphanView[]>;
  duplicateFiles(): Promise<readonly DuplicateFileGroup[]>;
  duplicateDocuments(): Promise<readonly DuplicateDocumentGroup[]>;
  /** Permanent. */
  deleteAttachment(id: string): Promise<void>;
  /** Moves the document to the Trash. */
  trashDocument(id: string): Promise<void>;
}

/** `fetch` relative to `/api`: `kernel.session.fetch`, which carries either session kind. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function createHealthClient(fetchApi: ApiFetch): HealthClient {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => (await fetchApi(path, init)).json() as Promise<T>;
  const send = async (path: string, init: RequestInit): Promise<void> => {
    await fetchApi(path, init);
  };
  const id = (value: string): string => encodeURIComponent(value);

  return {
    orphans: () => json<readonly OrphanView[]>("/attachments/orphans"),
    scanOrphans: () => json<readonly OrphanView[]>("/attachments/orphans/scan", { method: "POST" }),
    duplicateFiles: () => json<readonly DuplicateFileGroup[]>("/attachments/duplicates"),
    duplicateDocuments: () => json<readonly DuplicateDocumentGroup[]>("/documents/duplicates"),
    deleteAttachment: (attachmentId) => send(`/attachments/${id(attachmentId)}`, { method: "DELETE" }),
    trashDocument: (documentId) => send(`/documents/${id(documentId)}`, { method: "DELETE" }),
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** `0` → "Nothing", `1` → "1 note", `3` → "3 notes". */
export function usedBy(count: number): string {
  return count === 0 ? "Nothing" : `${count} note${count === 1 ? "" : "s"}`;
}
