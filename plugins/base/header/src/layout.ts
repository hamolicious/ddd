/**
 * Where each `navbar.item` goes: the user's arrangement first, the wiring's seat order
 * second.
 *
 * The arrangement is two lists of item ids, one per seat, stored in the user's settings
 * (flat lists, because settings values are YAML scalars one key per line). An id listed
 * in a seat goes there in that position, whatever `side` the item asked for. An item
 * listed nowhere — a plugin installed after the user last arranged the bar — keeps its
 * own `side`, and is placed after the arranged items of that seat in the order it
 * arrived, which is the host's seat order (PLUGIN-PROTOCOLS §6a): the personal
 * arrangement starts from the workspace default and never feeds back into it. Ids of
 * items that no longer exist are simply skipped, so uninstalling a plugin needs no
 * cleanup. A third list, `hidden`, names items the user took out of the bar; they keep
 * their place, so showing one again puts it back where it was.
 */

export type Seat = "start" | "end";

export const SEATS: readonly Seat[] = ["start", "end"];

export interface Arrangement {
  readonly start: readonly string[];
  readonly end: readonly string[];
  readonly hidden: readonly string[];
}

export const EMPTY_ARRANGEMENT: Arrangement = { start: [], end: [], hidden: [] };

export interface Placeable {
  readonly id: string;
  readonly side?: Seat;
}

export function arrange<T>(
  entries: readonly T[],
  valueOf: (entry: T) => Placeable,
  arrangement: Arrangement,
): Record<Seat, T[]> {
  const listed = new Map<string, { seat: Seat; index: number }>();
  for (const seat of SEATS) {
    arrangement[seat].forEach((id, index) => {
      if (!listed.has(id)) listed.set(id, { seat, index });
    });
  }

  const ranked: Record<Seat, { entry: T; index: number }[]> = { start: [], end: [] };
  // Unranked items keep the order they arrived in: `entries` is seat order already.
  const unranked: Record<Seat, T[]> = { start: [], end: [] };
  for (const entry of entries) {
    const value = valueOf(entry);
    const place = listed.get(value.id);
    if (place) ranked[place.seat].push({ entry, index: place.index });
    else unranked[value.side ?? "start"].push(entry);
  }

  const result: Record<Seat, T[]> = { start: [], end: [] };
  for (const seat of SEATS) {
    result[seat] = [
      ...ranked[seat].sort((a, b) => a.index - b.index).map((item) => item.entry),
      ...unranked[seat],
    ];
  }
  return result;
}

/** The arrangement read back from settings; anything malformed is ignored, not fatal. */
export function readArrangement(start: unknown, end: unknown, hidden: unknown): Arrangement {
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  return { start: ids(start), end: ids(end), hidden: ids(hidden) };
}

/** Hide `id` if it is shown, show it if it is hidden. */
export function toggleHidden(arrangement: Arrangement, id: string): Arrangement {
  const hidden = arrangement.hidden.includes(id)
    ? arrangement.hidden.filter((other) => other !== id)
    : [...arrangement.hidden, id];
  return { ...arrangement, hidden };
}

/** Move `id` one step within its seat (`delta` −1 or +1), or to the end of `to`. */
export function move(
  current: Arrangement,
  id: string,
  change: { readonly delta: -1 | 1 } | { readonly to: Seat },
): Arrangement {
  const next = { start: [...current.start], end: [...current.end], hidden: current.hidden };
  const seat = SEATS.find((candidate) => next[candidate].includes(id));
  if (!seat) return next;
  const list = next[seat];
  const index = list.indexOf(id);
  if ("delta" in change) {
    const target = index + change.delta;
    if (target < 0 || target >= list.length) return next;
    [list[index], list[target]] = [list[target] as string, list[index] as string];
    return next;
  }
  if (change.to === seat) return next;
  list.splice(index, 1);
  next[change.to].push(id);
  return next;
}
