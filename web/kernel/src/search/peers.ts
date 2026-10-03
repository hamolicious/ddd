import type { SerializedSearchError } from "./errors.js";

export type PeerOp = "run" | "select" | "apply" | "status" | "wipe";

export type PeerMessage =
  | { readonly kind: "call"; readonly id: number; readonly from: string; readonly op: PeerOp; readonly payload: unknown }
  | {
      readonly kind: "reply";
      readonly id: number;
      readonly to: string;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: SerializedSearchError;
    }
  | { readonly kind: "changed"; readonly sources: readonly string[] }
  | { readonly kind: "owner"; readonly id: string };

export interface SearchPeers {
  readonly id: string;
  post(message: PeerMessage): void;
  onMessage(listener: (message: PeerMessage) => void): () => void;
  claim(): Promise<boolean>;
  whenClaimed(): Promise<void>;
  close(): void;
}

export const SEARCH_LOCK = "ddd:search-owner";
export const SEARCH_CHANNEL = "ddd:search";

function tabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function browserPeers(): SearchPeers | undefined {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (!locks || typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(SEARCH_CHANNEL);
  const listeners = new Set<(message: PeerMessage) => void>();
  channel.onmessage = (event: MessageEvent<PeerMessage>) => {
    for (const listener of [...listeners]) listener(event.data);
  };
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let claimed: Promise<void> | undefined;
  return {
    id: tabId(),
    post: (message) => channel.postMessage(message),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    claim: () =>
      new Promise<boolean>((resolve) => {
        void locks.request(SEARCH_LOCK, { ifAvailable: true }, (lock) => {
          resolve(lock !== null);
          return lock === null ? undefined : held;
        });
      }),
    whenClaimed() {
      claimed ??= new Promise<void>((resolve) => {
        void locks.request(SEARCH_LOCK, () => {
          resolve();
          return held;
        });
      });
      return claimed;
    },
    close: () => {
      release?.();
      channel.close();
      listeners.clear();
    },
  };
}
