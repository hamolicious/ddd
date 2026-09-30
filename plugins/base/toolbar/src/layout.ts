/**
 * Where each toolbar item goes: the user's layout first, the item's own placement and
 * the registry order (`order`, then when it was added) second.
 *
 * There are two **profiles**, one per kind of device, each with its own seats:
 *
 * - **desktop** — the header (`top-start`, `top-end`) and an IDE-style status footer
 *   (`bottom-start`, `bottom-end`).
 * - **mobile** — a thin top bar (`top-start`, `top-end`) and one row of big icon buttons
 *   along the bottom (`bottom`).
 *
 * A layout is one list of item ids per seat, plus `hidden`, stored in the user's settings
 * (flat lists, because settings values are YAML scalars one key per line). An id listed in
 * a seat goes there in that position, whatever the item asked for. An item listed nowhere
 * — a plugin installed after the user last arranged the bars — goes to its default seat
 * ({@link defaultSeat}), after the arranged items there, in the order it arrived, which is
 * the registry's order. Ids of items that no longer exist are skipped, so uninstalling a
 * plugin needs no cleanup. `hidden` names items the user took out; they keep their place,
 * so showing one again puts it back where it was.
 */

import type { Placement } from "./api.js";

export type Profile = "desktop" | "mobile";

export const PROFILES: readonly Profile[] = ["desktop", "mobile"];

export type SeatId = "top-start" | "top-end" | "bottom-start" | "bottom-end" | "bottom";

export interface SeatInfo {
  readonly id: SeatId;
  readonly title: string;
}

/** Each profile's seats, in the order Settings lists them. */
export const SEATS: Readonly<Record<Profile, readonly SeatInfo[]>> = {
  desktop: [
    { id: "top-start", title: "Header — left" },
    { id: "top-end", title: "Header — right" },
    { id: "bottom-start", title: "Footer — left" },
    { id: "bottom-end", title: "Footer — right" },
  ],
  mobile: [
    { id: "top-start", title: "Top bar — left" },
    { id: "top-end", title: "Top bar — right" },
    { id: "bottom", title: "Bottom toolbar" },
  ],
};

export interface Arrangement {
  readonly seats: Readonly<Partial<Record<SeatId, readonly string[]>>>;
  readonly hidden: readonly string[];
}

export const EMPTY_ARRANGEMENT: Arrangement = { seats: {}, hidden: [] };

export interface Placeable extends Placement {
  readonly id: string;
  readonly mobile?: Placement;
}

/** The seat an item goes to in `profile` until the user moves it. */
export function defaultSeat(profile: Profile, item: Placeable): SeatId {
  if (profile === "desktop") return `${item.bar ?? "top"}-${item.side ?? "start"}` as const;
  if ((item.mobile?.bar ?? "bottom") === "bottom") return "bottom";
  return `top-${item.mobile?.side ?? item.side ?? "start"}` as const;
}

export type Seated<T> = Partial<Record<SeatId, T[]>>;

export function arrange<T>(
  entries: readonly T[],
  valueOf: (entry: T) => Placeable,
  profile: Profile,
  arrangement: Arrangement,
): Seated<T> {
  const seats = SEATS[profile].map((seat) => seat.id);
  const listed = new Map<string, { seat: SeatId; index: number }>();
  for (const seat of seats) {
    (arrangement.seats[seat] ?? []).forEach((id, index) => {
      if (!listed.has(id)) listed.set(id, { seat, index });
    });
  }

  const ranked = new Map<SeatId, { entry: T; index: number }[]>(seats.map((seat) => [seat, []]));
  // Unranked items keep the order they arrived in: `entries` is registry order already.
  const unranked = new Map<SeatId, T[]>(seats.map((seat) => [seat, []]));
  for (const entry of entries) {
    const value = valueOf(entry);
    const place = listed.get(value.id);
    if (place) ranked.get(place.seat)?.push({ entry, index: place.index });
    else unranked.get(defaultSeat(profile, value))?.push(entry);
  }

  const result: Seated<T> = {};
  for (const seat of seats) {
    result[seat] = [
      ...(ranked.get(seat) ?? []).sort((a, b) => a.index - b.index).map((item) => item.entry),
      ...(unranked.get(seat) ?? []),
    ];
  }
  return result;
}

/** The settings key a profile's seat (or its `hidden` list) is stored under. */
export const settingsKey = (profile: Profile, seat: SeatId | "hidden"): string => `${profile}-${seat}`;

/** A layout read back from settings; anything malformed is ignored, not fatal. */
export function readArrangement(profile: Profile, read: (key: string) => unknown): Arrangement {
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  const seats: Partial<Record<SeatId, string[]>> = {};
  for (const seat of SEATS[profile]) seats[seat.id] = ids(read(settingsKey(profile, seat.id)));
  return { seats, hidden: ids(read(settingsKey(profile, "hidden"))) };
}

/** Hide `id` if it is shown, show it if it is hidden. */
export function toggleHidden(arrangement: Arrangement, id: string): Arrangement {
  const hidden = arrangement.hidden.includes(id)
    ? arrangement.hidden.filter((other) => other !== id)
    : [...arrangement.hidden, id];
  return { ...arrangement, hidden };
}

/** Move `id` one step within its seat (`delta` −1 or +1), or to the end of seat `to`. */
export function move(
  current: Arrangement,
  id: string,
  change: { readonly delta: -1 | 1 } | { readonly to: SeatId },
): Arrangement {
  const seats: Partial<Record<SeatId, string[]>> = {};
  for (const [seat, list] of Object.entries(current.seats) as [SeatId, readonly string[]][]) {
    seats[seat] = [...list];
  }
  const next: Arrangement = { seats, hidden: current.hidden };
  const seat = (Object.keys(seats) as SeatId[]).find((candidate) => seats[candidate]?.includes(id));
  if (!seat) return next;
  const list = seats[seat] as string[];
  const index = list.indexOf(id);
  if ("delta" in change) {
    const target = index + change.delta;
    if (target < 0 || target >= list.length) return next;
    [list[index], list[target]] = [list[target] as string, list[index] as string];
    return next;
  }
  if (change.to === seat) return next;
  list.splice(index, 1);
  (seats[change.to] ??= []).push(id);
  return next;
}
