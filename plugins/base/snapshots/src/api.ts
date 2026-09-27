/**
 * The snapshot routes (`backend/crates/server/src/routes/documents.rs`), and how a
 * snapshot's `reason` reads to a person.
 */

export interface SnapshotView {
  readonly id: string;
  readonly document_id: string;
  /** The document's title when the snapshot was taken. */
  readonly title: string;
  readonly reason: string;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly size: number;
}

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface SnapshotsClient {
  /** Newest first. */
  list(documentId: string): Promise<readonly SnapshotView[]>;
  take(documentId: string): Promise<void>;
  restore(documentId: string, snapshotId: string): Promise<void>;
}

export function createSnapshotsClient(fetchApi: ApiFetch): SnapshotsClient {
  const id = (value: string): string => encodeURIComponent(value);
  return {
    list: async (documentId) =>
      (await (await fetchApi(`/documents/${id(documentId)}/snapshots`)).json()) as readonly SnapshotView[],
    take: async (documentId) => {
      await fetchApi(`/documents/${id(documentId)}/snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "manual" }),
      });
    },
    restore: async (documentId, snapshotId) => {
      await fetchApi(`/documents/${id(documentId)}/snapshots/${id(snapshotId)}/restore`, { method: "POST" });
    },
  };
}

const REASONS: Readonly<Record<string, string>> = {
  manual: "Taken by hand",
  quiescence: "After a pause in editing",
  daily: "Daily",
  pre_restore: "Before a restore",
};

/** A known reason in words; an unknown one as its own name, spaced. */
export function describeReason(reason: string): string {
  return REASONS[reason] ?? reason.replace(/_/g, " ");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
