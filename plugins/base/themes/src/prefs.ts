/**
 * Reading and writing this plugin's own settings **without betting the plugin on
 * them**, and without losing a choice made while the network was down.
 *
 * `kernel.settings` is per-user documents (SPEC §6.4), which is the right home for a
 * theme choice — it syncs, and a new device arrives already themed. Two things can still
 * go wrong, and they need opposite treatments:
 *
 * 1. **The call throws.** `kernel.settings.get` is a cache read and does not, but a
 *    replaced kernel or a future contract could; letting it escape `activate()` would
 *    mark this plugin failed and take its dependents with it (SPEC §6.4) over a theme
 *    picker. So every call is guarded and there is a `localStorage` fallback underneath.
 * 2. **The write cannot reach a document.** Offline, `settings.set` legitimately rejects:
 *    with no settings document yet it goes through `documents.create`, which is REST, and
 *    with one it has to hydrate a document this client may never have opened. This is
 *    *transient* — it is exactly the case where the user picked a theme on a train.
 *
 * ## What this store does about (2), and what it used to do
 *
 * It keeps the value on the device **and remembers that the value never arrived**. A key
 * in that state is "pending": `get` answers from the device for it (so the choice sticks
 * across a reload rather than being overwritten by the stale synced value), and the next
 * successful write — or the flush that runs when sync comes back — moves it into the
 * settings document and drops the local copy.
 *
 * What it must not do, and did: latch a single failure into a session-long demotion.
 * `durable = false` on any error meant one offline moment sent *every* later choice to
 * `localStorage`, stopped `get` from reading synced settings at all, and made
 * `subscribe` a no-op — so a theme chosen offline never synced, and on the next reload
 * the old synced value won silently. The failure is per write; the store's mode is not.
 *
 * `durable` is therefore a *status*, not a switch: `true` when nothing is waiting to be
 * written. The picker shows it, and that is all it is for.
 */

import type { Kernel, Unsubscribe } from "@kernel";

export interface PreferenceStore {
  /** `undefined` when unset. Values are strings; that is all this plugin stores. */
  get(key: string): string | undefined;
  set(key: string, value: string): Promise<void>;
  /** Fires when a value changes — including changes that arrive through sync. */
  subscribe(listener: () => void): Unsubscribe;
  /** `true` when every value has reached the kernel's per-user settings. */
  readonly durable: boolean;
  /** Retry the writes that never landed. Called when sync reports it is back. */
  flush(): Promise<void>;
}

export function preferenceStore(kernel: Kernel, prefix: string): PreferenceStore {
  const localKey = (key: string): string => `ddd.${prefix}.${key}`;
  /** Keys whose value is on this device only, because the write did not land. */
  const pendingKey = `ddd.${prefix}.__pending`;
  let warned = false;

  const readLocal = (key: string): string | undefined => {
    try {
      return localStorage.getItem(localKey(key)) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const writeLocal = (key: string, value: string): void => {
    try {
      localStorage.setItem(localKey(key), value);
    } catch {
      // Private mode: the choice lasts as long as the page does.
    }
  };

  const clearLocal = (key: string): void => {
    try {
      localStorage.removeItem(localKey(key));
    } catch {
      /* nothing to clean up */
    }
  };

  const pending = (): Set<string> => {
    try {
      const raw = localStorage.getItem(pendingKey);
      const parsed = raw === null ? [] : (JSON.parse(raw) as unknown);
      return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
    } catch {
      return new Set();
    }
  };

  const setPending = (keys: Set<string>): void => {
    try {
      if (keys.size === 0) localStorage.removeItem(pendingKey);
      else localStorage.setItem(pendingKey, JSON.stringify([...keys]));
    } catch {
      /* the values themselves are still stored; only the retry list is lost */
    }
  };

  /** Report a transient failure once per session, without changing behaviour. */
  const note = (operation: string, error: unknown): void => {
    if (warned) return;
    warned = true;
    kernel.log.warn(
      `kernel.settings.${operation} did not land; keeping the value on this device and retrying when sync returns`,
      error,
    );
  };

  const store: PreferenceStore = {
    get: (key) => {
      // A key waiting to be written is the newer value by definition: the synced
      // document still holds what it held before the user changed it.
      if (pending().has(key)) {
        const local = readLocal(key);
        if (local !== undefined) return local;
      }
      try {
        const value = kernel.settings.get<string>(key);
        if (value !== undefined) return String(value);
      } catch (error) {
        note("get", error);
      }
      return readLocal(key);
    },

    set: async (key, value) => {
      try {
        await kernel.settings.set(key, value);
        // It landed: the device copy is now a stale duplicate.
        const waiting = pending();
        if (waiting.delete(key)) setPending(waiting);
        clearLocal(key);
        return;
      } catch (error) {
        note("set", error);
      }
      writeLocal(key, value);
      const waiting = pending();
      waiting.add(key);
      setPending(waiting);
    },

    subscribe: (listener) => {
      try {
        return kernel.settings.subscribe(() => listener());
      } catch (error) {
        note("subscribe", error);
        return () => undefined;
      }
    },

    get durable(): boolean {
      return pending().size === 0;
    },

    flush: async () => {
      const waiting = pending();
      if (waiting.size === 0) return;
      for (const key of [...waiting]) {
        const value = readLocal(key);
        if (value === undefined) {
          waiting.delete(key);
          continue;
        }
        try {
          await kernel.settings.set(key, value);
          waiting.delete(key);
          clearLocal(key);
        } catch {
          // Still unreachable. Keep it pending; the next flush tries again.
        }
      }
      setPending(waiting);
    },
  };

  return store;
}
