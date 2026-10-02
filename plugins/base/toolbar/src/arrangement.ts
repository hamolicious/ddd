import type { Kernel, SettingsSchema, Unsubscribe } from "@kernel";

import {
  EMPTY_ARRANGEMENT,
  PROFILES,
  SEATS,
  readArrangement,
  settingsKey,
  type Arrangement,
  type Profile,
} from "./layout.js";

export interface ArrangementStore {
  get(profile: Profile): Arrangement;
  subscribe(listener: () => void): Unsubscribe;
  save(profile: Profile, next: Arrangement): Promise<void>;
  reset(profile: Profile): Promise<void>;
}

const PROFILE_NAMES: Record<Profile, string> = { desktop: "Desktop", mobile: "Phone" };

function keysOf(profile: Profile): string[] {
  return [...SEATS[profile].map((seat) => settingsKey(profile, seat.id)), settingsKey(profile, "hidden")];
}

function schema(): SettingsSchema {
  const fields: Record<string, SettingsSchema[string]> = {};
  for (const profile of PROFILES) {
    for (const seat of SEATS[profile]) {
      fields[settingsKey(profile, seat.id)] = {
        type: "list",
        label: `${PROFILE_NAMES[profile]}: ${seat.title}`,
        description: "Item ids in this seat, in order.",
      };
    }
    fields[settingsKey(profile, "hidden")] = {
      type: "list",
      label: `${PROFILE_NAMES[profile]}: hidden items`,
      description: "Item ids left out of the bars.",
    };
  }
  return fields;
}

const PENDING_MS = 5_000;

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((id, index) => id === b[index]);
}

export function createArrangementStore(kernel: Kernel): ArrangementStore {
  const pending = new Map<string, { readonly ids: readonly string[]; readonly until: number }>();
  const wrote = (key: string, ids: readonly string[]): void => {
    pending.set(key, { ids: [...ids], until: Date.now() + PENDING_MS });
    setTimeout(() => {
      if (saving === 0) reread();
    }, PENDING_MS + 50);
  };
  const setting = (key: string): unknown => {
    const mine = pending.get(key);
    if (mine && Date.now() <= mine.until) return mine.ids;
    pending.delete(key);
    return kernel.settings.get(key);
  };
  const read = (profile: Profile): Arrangement => {
    try {
      return readArrangement(profile, setting);
    } catch {
      return EMPTY_ARRANGEMENT;
    }
  };

  try {
    kernel.settings.defineSchema(schema());
  } catch {
  }

  let saving = 0;
  let current: Record<Profile, Arrangement> = { desktop: read("desktop"), mobile: read("mobile") };
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const reread = (): void => {
    current = { desktop: read("desktop"), mobile: read("mobile") };
    notify();
  };
  let queue: Promise<void> = Promise.resolve();
  const write = (
    profile: Profile,
    shown: Arrangement,
    keys: (before: Arrangement) => Promise<void>,
  ): Promise<void> => {
    saving += 1;
    const before = current[profile];
    current = { ...current, [profile]: shown };
    notify();
    const run = queue.then(() => keys(before)).finally(() => {
      saving -= 1;
      if (saving === 0) reread();
    });
    queue = run.catch(() => undefined);
    return run;
  };
  try {
    kernel.settings.subscribe(() => {
      if (saving === 0) reread();
    });
  } catch {
  }

  return {
    get: (profile) => current[profile],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    save: (profile, next) =>
      write(profile, next, async (before) => {
        const lists: [string, readonly string[] | undefined, readonly string[]][] = [
          ...SEATS[profile].map((seat): [string, readonly string[] | undefined, readonly string[]] => [
            settingsKey(profile, seat.id),
            before.seats[seat.id],
            next.seats[seat.id] ?? [],
          ]),
          [settingsKey(profile, "hidden"), before.hidden, next.hidden],
        ];
        for (const [key, was, ids] of lists) {
          if (sameIds(was, ids)) continue;
          await kernel.settings.set(key, [...ids]);
          wrote(key, ids);
        }
      }),
    reset: (profile) =>
      write(profile, EMPTY_ARRANGEMENT, async () => {
        for (const key of keysOf(profile)) {
          await kernel.settings.remove(key);
          wrote(key, []);
        }
      }),
  };
}
