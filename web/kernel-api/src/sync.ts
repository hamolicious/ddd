import type { Unsubscribe } from "./types.js";

export type SyncStatus =
  | "offline"
  | "connecting"
  | "syncing"
  | "synced"
  | "auth-required"
  | "error";

export interface BootstrapProgress {
  readonly rows: number;
  readonly total?: number;
  readonly complete: boolean;
}

export interface SyncState {
  readonly status: SyncStatus;
  readonly safeSeq: number;
  readonly headSeq: number;
  readonly pending: number;
  readonly bootstrap?: BootstrapProgress;
  readonly lastError?: string;
}

export interface SyncApi {
  readonly state: SyncState;
  subscribe(listener: (state: SyncState) => void): Unsubscribe;
  reconnectNow(): void;
}
