/**
 * The user's arrangement of the bar, kept in `kernel.settings` under this plugin's
 * namespace as three lists of item ids: `start`, `end` and `hidden`.
 *
 * Settings may be unavailable — they are document-backed and a replaced kernel can
 * throw — and the bar must still draw, so every read falls back to the empty
 * arrangement (each item's own hints). A write is allowed to reject: the settings
 * section shows why.
 */

import type { Kernel, Unsubscribe } from "@kernel";

import { EMPTY_ARRANGEMENT, readArrangement, type Arrangement } from "./layout.js";

export interface ArrangementStore {
  get(): Arrangement;
  subscribe(listener: () => void): Unsubscribe;
  save(next: Arrangement): Promise<void>;
  reset(): Promise<void>;
}

export function createArrangementStore(kernel: Kernel): ArrangementStore {
  const read = (): Arrangement => {
    try {
      return readArrangement(
        kernel.settings.get("start"),
        kernel.settings.get("end"),
        kernel.settings.get("hidden"),
      );
    } catch {
      return EMPTY_ARRANGEMENT;
    }
  };

  try {
    kernel.settings.defineSchema({
      start: {
        type: "list",
        label: "Top bar, start seat",
        description: "Item ids on the left-hand side, in order.",
      },
      end: {
        type: "list",
        label: "Top bar, end seat",
        description: "Item ids at the right-hand end, in order.",
      },
      hidden: {
        type: "list",
        label: "Top bar, hidden items",
        description: "Item ids left out of the top bar.",
      },
    });
  } catch {
    // Without a schema the keys still read and write; the settings UI is ours anyway.
  }

  // Cached so `useSyncExternalStore` sees one object until something changes.
  let current = read();
  const listeners = new Set<() => void>();
  try {
    kernel.settings.subscribe(() => {
      current = read();
      for (const listener of [...listeners]) listener();
    });
  } catch {
    // No live updates: the arrangement read at activation stands.
  }

  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    save: async (next) => {
      await kernel.settings.set("start", [...next.start]);
      await kernel.settings.set("end", [...next.end]);
      await kernel.settings.set("hidden", [...next.hidden]);
    },
    reset: async () => {
      await kernel.settings.remove("start");
      await kernel.settings.remove("end");
      await kernel.settings.remove("hidden");
    },
  };
}
