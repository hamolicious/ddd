/**
 * The user's layout of the bars, kept in `kernel.settings` under this plugin's namespace:
 * one list of item ids per seat per profile (`desktop-top-start`, `mobile-bottom`, …)
 * and one `hidden` list per profile (`desktop-hidden`, `mobile-hidden`).
 *
 * Settings may be unavailable — they are document-backed and a replaced kernel can
 * throw — and the bars must still draw, so every read falls back to the empty layout
 * (each item's own placement). A write is allowed to reject: the settings section shows
 * why.
 *
 * A save is several key writes, and settings notify after each one, so reading back
 * mid-save would show a half-written layout — an item whose old seat is written and new
 * one is not falls back to its default seat, and a second change made from that state
 * loses the first. So a save shows its layout at once, and settings are only read back
 * once no save is in flight.
 *
 * Even then settings' cache can go *backwards*: the sync feed may deliver an earlier
 * version of the document after a later write already landed locally — even after the
 * cache briefly agreed with the write. Read back then, a hidden item would reappear and
 * the next click would act on that. So each value this store wrote stands in for the
 * setting for {@link PENDING_MS}, whatever the cache says, and the store reads settings
 * again when that runs out, so another device's change is only held back that long.
 */

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

/** Every key this plugin stores, for the schema and for reset. */
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

/** How long a value this store wrote outranks settings' cache: long enough for the feed to catch up. */
const PENDING_MS = 5_000;

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((id, index) => id === b[index]);
}

export function createArrangementStore(kernel: Kernel): ArrangementStore {
  const pending = new Map<string, { readonly ids: readonly string[]; readonly until: number }>();
  const wrote = (key: string, ids: readonly string[]): void => {
    pending.set(key, { ids: [...ids], until: Date.now() + PENDING_MS });
    // Read settings again once this runs out, in case the cache holds something newer.
    setTimeout(() => {
      if (saving === 0) reread();
    }, PENDING_MS + 50);
  };
  /** A setting as this store last wrote it, for a while; after that, settings' own value. */
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
    // Without a schema the keys still read and write; the settings UI is ours anyway.
  }

  let saving = 0;
  // Cached so `useSyncExternalStore` sees one object until something changes.
  let current: Record<Profile, Arrangement> = { desktop: read("desktop"), mobile: read("mobile") };
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const reread = (): void => {
    current = { desktop: read("desktop"), mobile: read("mobile") };
    notify();
  };
  // Writes run one after another, so two quick changes land in the order they were made.
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
    // No live updates: the layout read at activation stands.
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
        // Only the lists this change touched — compared with the layout on screen before
        // it, not with settings' cache, which can lag behind a write still syncing.
        // Hiding an item is one line, a move one or two: fewer splices, and fewer for
        // another device's edit to cross.
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
