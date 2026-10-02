import type { Kernel, Unsubscribe } from "@kernel";

export interface PreferenceStore {
  get(key: string): string | undefined;
  set(key: string, value: string): Promise<void>;
  subscribe(listener: () => void): Unsubscribe;
  readonly durable: boolean;
  flush(): Promise<void>;
}

export function preferenceStore(kernel: Kernel, prefix: string): PreferenceStore {
  const localKey = (key: string): string => `ddd.${prefix}.${key}`;
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
    }
  };

  const clearLocal = (key: string): void => {
    try {
      localStorage.removeItem(localKey(key));
    } catch {
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
    }
  };

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
        }
      }
      setPending(waiting);
    },
  };

  return store;
}
