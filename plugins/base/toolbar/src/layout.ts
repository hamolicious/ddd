import type { Placement } from "./api.js";

export type Profile = "desktop" | "mobile";

export const PROFILES: readonly Profile[] = ["desktop", "mobile"];

export type SeatId = "top-start" | "top-end" | "bottom-start" | "bottom-end" | "bottom";

export interface SeatInfo {
  readonly id: SeatId;
  readonly title: string;
}

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

export const settingsKey = (profile: Profile, seat: SeatId | "hidden"): string => `${profile}-${seat}`;

export function readArrangement(profile: Profile, read: (key: string) => unknown): Arrangement {
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  const seats: Partial<Record<SeatId, string[]>> = {};
  for (const seat of SEATS[profile]) seats[seat.id] = ids(read(settingsKey(profile, seat.id)));
  return { seats, hidden: ids(read(settingsKey(profile, "hidden"))) };
}

export function toggleHidden(arrangement: Arrangement, id: string): Arrangement {
  const hidden = arrangement.hidden.includes(id)
    ? arrangement.hidden.filter((other) => other !== id)
    : [...arrangement.hidden, id];
  return { ...arrangement, hidden };
}

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
