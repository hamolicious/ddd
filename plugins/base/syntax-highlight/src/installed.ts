/**
 * Which languages this user installed: a per-user setting, so it syncs. Installing on the
 * phone marks it installed on the laptop too, and each device fetches the grammar the
 * first time it needs it.
 */

import type { Kernel, SettingsValue } from "@kernel";

export const INSTALLED_KEY = "languages";

export interface Installed {
  has(id: string): boolean;
  list(): readonly string[];
  add(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function idsOf(value: SettingsValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function createInstalled(kernel: Kernel): Installed {
  try {
    kernel.settings.defineSchema({
      [INSTALLED_KEY]: {
        type: "list",
        label: "Installed code languages",
        description: "Languages fenced code is highlighted in. Settings → Code languages installs and removes them.",
        default: [],
      },
    });
  } catch (error) {
    kernel.log.warn("the installed-languages setting is unavailable; nothing will highlight", error);
  }
  const list = (): readonly string[] => {
    try {
      return idsOf(kernel.settings.get(INSTALLED_KEY));
    } catch {
      return [];
    }
  };
  return {
    list,
    has: (id) => list().includes(id),
    add: async (id) => {
      const current = list();
      if (!current.includes(id)) await kernel.settings.set(INSTALLED_KEY, [...current, id].sort());
    },
    remove: async (id) => {
      await kernel.settings.set(
        INSTALLED_KEY,
        list().filter((other) => other !== id),
      );
    },
    subscribe: (listener) => {
      try {
        return kernel.settings.subscribe(() => listener());
      } catch {
        return () => {};
      }
    },
  };
}
