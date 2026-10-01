/**
 * Server-only screens offline (`dev-docs/resolved/SYNC-DECISIONS.md` §9): the last-loaded answer,
 * marked as possibly out of date.
 *
 * A GET through `kernel.session.fetch` carrying {@link OFFLINE_COPY_HEADER} keeps its last
 * good response on the device; offline, that response comes back instead of the error,
 * with {@link CACHED_AT_HEADER} saying when it was loaded. The names match
 * `web/kernel/src/runtime/session.ts`.
 *
 * A screen opts in by wrapping its fetch with {@link offlineCopies}, and shows
 * {@link OfflineCopyNote} while the latest answer it got was such a copy.
 */

import { useSyncExternalStore, type ReactNode } from "react";

export const OFFLINE_COPY_HEADER = "x-ddd-offline-copy";
export const CACHED_AT_HEADER = "x-ddd-cached-at";

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Whether the screen is showing a copy, and from when. */
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

/** `fetch`, with GETs kept for offline and every answer reported to `state`. */
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

/** "Offline: showing what was loaded at …". Nothing while the answers are live. */
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
