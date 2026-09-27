/**
 * The snapshot and change routes (`routes/documents.rs`, `routes/changes.rs`), and how
 * their fields read to a person.
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

/** One snapshot with its full text (frontmatter and all). */
export interface SnapshotContent extends SnapshotView {
  readonly content: string;
}

/** A group of changes: one author, no long pause (`changes.rs`). Addressed by seq range. */
export interface ChangeGroup {
  readonly from_seq: number;
  readonly to_seq: number;
  readonly started_at: string;
  readonly ended_at: string;
  readonly by: string | null;
  readonly by_label: string;
  /** Writes in the group. */
  readonly changes: number;
  readonly inserted_chars: number;
  readonly removed_chars: number;
  readonly inserted_excerpt: string;
  readonly removed_excerpt: string;
  /** Set when this group is a revert: the group it undid. */
  readonly reverts?: { readonly from_seq: number; readonly to_seq: number };
  /** Older history, kept as the group's net effect rather than every write. */
  readonly squashed: boolean;
  /** Some of it was made offline and carried over on reconnect; the times are when it was made. */
  readonly offline: boolean;
}

export interface ChangesPage {
  readonly groups: readonly ChangeGroup[];
  readonly next_before?: number;
}

export interface ChangeDetail {
  readonly from_seq: number;
  readonly to_seq: number;
  readonly started_at: string;
  readonly ended_at: string;
  readonly by_label: string;
  readonly changes: number;
  /** The group's net effect, line by line, with unchanged lines around it. */
  readonly hunks: readonly {
    readonly before: string;
    readonly removed: string;
    readonly inserted: string;
    readonly after: string;
  }[];
}

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface SnapshotsClient {
  /** Newest first. */
  list(documentId: string): Promise<readonly SnapshotView[]>;
  get(documentId: string, snapshotId: string): Promise<SnapshotContent>;
  take(documentId: string): Promise<void>;
  restore(documentId: string, snapshotId: string): Promise<void>;
  /** Newest first; `before` is the previous page's `next_before`. */
  changes(documentId: string, before?: number): Promise<ChangesPage>;
  change(documentId: string, from: number, to: number): Promise<ChangeDetail>;
  /** Undo a group as a new change. Refused (with the reason) when later changes overlap. */
  revert(documentId: string, from: number, to: number): Promise<void>;
  /** The whole text as it was after update `seq`. */
  textAt(documentId: string, seq: number): Promise<string>;
  /** Admin only: wipe the history; the text stays. */
  forget(documentId: string): Promise<void>;
}

export function createSnapshotsClient(fetchApi: ApiFetch): SnapshotsClient {
  const id = (value: string): string => encodeURIComponent(value);
  return {
    list: async (documentId) =>
      (await (await fetchApi(`/documents/${id(documentId)}/snapshots`)).json()) as readonly SnapshotView[],
    get: async (documentId, snapshotId) =>
      (await (await fetchApi(`/documents/${id(documentId)}/snapshots/${id(snapshotId)}`)).json()) as SnapshotContent,
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
    changes: async (documentId, before) =>
      (await (
        await fetchApi(`/documents/${id(documentId)}/changes${before === undefined ? "" : `?before=${before}`}`)
      ).json()) as ChangesPage,
    change: async (documentId, from, to) =>
      (await (await fetchApi(`/documents/${id(documentId)}/changes/${from}/${to}`)).json()) as ChangeDetail,
    revert: async (documentId, from, to) => {
      await fetchApi(`/documents/${id(documentId)}/changes/${from}/${to}/revert`, { method: "POST" });
    },
    forget: async (documentId) => {
      await fetchApi(`/documents/${id(documentId)}/history/forget`, { method: "POST" });
    },
    textAt: async (documentId, seq) =>
      ((await (await fetchApi(`/documents/${id(documentId)}/text?at=${seq}`)).json()) as { content: string }).content,
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

/** "10:32", "10:32–10:35", "Sep 26, 10:32–10:35" or across days, both dates. */
export function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return startIso;
  const time = (date: Date): string => date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (date: Date): string => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const today = new Date().toDateString() === start.toDateString();
  const sameDay = start.toDateString() === end.toDateString();
  const prefix = today ? "" : `${day(start)}, `;
  if (!sameDay) return `${day(start)}, ${time(start)} – ${day(end)}, ${time(end)}`;
  return time(start) === time(end) ? `${prefix}${time(start)}` : `${prefix}${time(start)}–${time(end)}`;
}
