import type { FeedRow, ProjectionRow } from "../protocol.js";

export interface SyncCheckpoint {
  readonly safeSeq: number;
  readonly updatedAt: number;
  readonly coreSemanticsVersion: number | null;
  readonly bootstrapped: boolean;
}

export const EMPTY_CHECKPOINT: SyncCheckpoint = {
  safeSeq: 0,
  updatedAt: 0,
  coreSemanticsVersion: null,
  bootstrapped: false,
};

export interface AppliedRows {
  readonly applied: readonly string[];
  readonly purged: readonly string[];
  readonly ignored: readonly string[];
}

export interface StoreChange {
  readonly applied: readonly string[];
  readonly purged: readonly string[];
  readonly safeSeq: number;
}

export type StoreListener = (change: StoreChange) => void;

export interface StoredRow extends ProjectionRow {
  readonly seq: number;
  readonly local?: boolean;
}

export interface ProjectionStore {
  open(): Promise<void>;
  close(): Promise<void>;

  get(id: string): Promise<StoredRow | undefined>;
  getMany(ids: readonly string[]): Promise<StoredRow[]>;
  iterate(options?: { readonly includeDeleted?: boolean }): AsyncIterable<StoredRow>;
  count(options?: { readonly includeDeleted?: boolean }): Promise<number>;

  applyRows(rows: readonly FeedRow[], checkpoint: SyncCheckpoint): Promise<AppliedRows>;

  retainOnly(ids: ReadonlySet<string>): Promise<string[]>;

  putLocal?(rows: readonly StoredRow[]): Promise<void>;
  deleteLocal?(ids: readonly string[]): Promise<void>;
  getMeta?<T>(key: string): Promise<T | undefined>;
  setMeta?(key: string, value: unknown): Promise<void>;

  checkpoint(): Promise<SyncCheckpoint>;
  setCheckpoint(checkpoint: SyncCheckpoint): Promise<void>;

  subscribe(listener: StoreListener): () => void;

  clear(): Promise<void>;
}
