/**
 * Hard refresh: drop every cached copy of the app and its plugins, then reload.
 *
 * The way out when a device is stuck on an old bundle or an old plugin version and the
 * one update flow (`update.ts`) cannot get it unstuck — a worker that never activates, a
 * precache that kept a bad entry. It is not sign-out (`main.tsx`): nothing about the
 * session or the workspace goes.
 *
 * Cleared:
 * - every service worker registration for this origin;
 * - every Cache Storage cache — the Workbox precache, `lm-plugins`, `lm-runtime`,
 *   `lm-meta`, `lm-shell` (`sw.ts`) and anything else there;
 * - the two boot cache entries, the session user and the installed plugin list
 *   (`cache.ts`), so the reload asks the server for both.
 *
 * Kept: cookies (the session), IndexedDB (the replica, the search index and the outbox of
 * unsent edits), the shell's bearer token and every other `localStorage` key.
 *
 * Each step is attempted whatever the one before it did — `caches` is undefined outside
 * a secure context, a registration can refuse to go — and the reload always happens.
 */

import { forgetBootCache } from "./cache.js";

export interface HardRefreshDeps {
  /** `navigator.serviceWorker`, absent where workers are unavailable. */
  readonly serviceWorker?: Pick<ServiceWorkerContainer, "getRegistrations"> | undefined;
  /** `caches`, absent outside a secure context. */
  readonly caches?: Pick<CacheStorage, "keys" | "delete"> | undefined;
  /** Removes the boot cache entries. */
  readonly forgetBootCache?: () => void;
  readonly reload?: () => void;
  readonly warn?: (message: string, cause: unknown) => void;
}

export async function hardRefresh(deps: HardRefreshDeps = defaultDeps()): Promise<void> {
  const warn = deps.warn ?? ((message, cause) => console.warn(`[app] hard refresh: ${message}`, cause));
  try {
    const registrations = (await deps.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(
      registrations.map((registration) =>
        registration.unregister().catch((cause: unknown) => warn("a service worker would not unregister", cause)),
      ),
    );
  } catch (cause) {
    warn("service workers could not be listed", cause);
  }
  try {
    const keys = (await deps.caches?.keys()) ?? [];
    await Promise.all(
      keys.map((key) => deps.caches!.delete(key).catch((cause: unknown) => warn(`cache "${key}" could not be deleted`, cause))),
    );
  } catch (cause) {
    warn("caches could not be listed", cause);
  }
  try {
    (deps.forgetBootCache ?? forgetBootCache)();
  } catch (cause) {
    warn("the boot cache could not be cleared", cause);
  }
  (deps.reload ?? (() => location.reload()))();
}

function defaultDeps(): HardRefreshDeps {
  return {
    serviceWorker: typeof navigator !== "undefined" ? navigator.serviceWorker : undefined,
    caches: globalThis.caches,
    forgetBootCache,
    reload: () => location.reload(),
  };
}
