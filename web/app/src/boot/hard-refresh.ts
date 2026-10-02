import { forgetBootCache } from "./cache.js";

export interface HardRefreshDeps {
  readonly serviceWorker?: Pick<ServiceWorkerContainer, "getRegistrations"> | undefined;
  readonly caches?: Pick<CacheStorage, "keys" | "delete"> | undefined;
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
