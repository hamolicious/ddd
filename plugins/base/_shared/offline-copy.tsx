import { useSyncExternalStore, type ReactNode } from "react";

export const OFFLINE_COPY_HEADER = "x-ddd-offline-copy";
export const CACHED_AT_HEADER = "x-ddd-cached-at";

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export class OfflineCopyState {
  #loadedAt: string | undefined;
  readonly #listeners = new Set<() => void>();

  get loadedAt(): string | undefined {
    return this.#loadedAt;
  }

  observe(response: Response): void {
    const at = response.headers.get(CACHED_AT_HEADER) ?? undefined;
    if (at === this.#loadedAt) return;
    this.#loadedAt = at;
    for (const listener of [...this.#listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

export function offlineCopies(fetch: Fetch, state: OfflineCopyState): Fetch {
  return async (path, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (method === "GET") headers.set(OFFLINE_COPY_HEADER, "1");
    const response = await fetch(path, { ...init, headers });
    if (method === "GET") state.observe(response);
    return response;
  };
}

export function useOfflineCopy(state: OfflineCopyState): string | undefined {
  return useSyncExternalStore(state.subscribe, () => state.loadedAt);
}

export function OfflineCopyNote({ state, className }: { readonly state: OfflineCopyState; readonly className?: string }): ReactNode {
  const at = useOfflineCopy(state);
  if (at === undefined) return null;
  const when = at ? new Date(at) : undefined;
  const label = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "earlier";
  return (
    <p role="status" data-offline-copy="" className={className}>
      You are offline. This is what was loaded {label}; it may be out of date.
    </p>
  );
}
