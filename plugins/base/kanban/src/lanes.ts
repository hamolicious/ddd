/**
 * Swimlanes, pure: the board split into rows by a second field (`KanbanOptions.lanes`),
 * each row with the same columns.
 *
 * - **Lanes are the field's values**, as the timeline's are: named ones in natural order,
 *   then a "No …" lane for the notes without one. A list value puts the note in each of its
 *   values' lanes.
 * - **Every lane has every column.** The columns are worked out over the whole board
 *   first, then each lane is laid out against them, so a column empty in one lane is still
 *   there to drop into — and the columns line up from lane to lane.
 * - **Lanes stay put** while the board is on screen (`keepLanes`), as columns do: a lane
 *   vanishing mid-drag would pull every lane below it out from under the pointer.
 * - **A filter on the lane field shows exactly its lanes** (`lanesFor`'s `only`): one per
 *   chosen value, in natural order, even one no card holds now, and no "No …" lane. Lanes
 *   are kept for a drag, not across a change of filter (`laneScope`): a lane the filter
 *   empties goes.
 * - **A move into another lane writes the lane's field**, as a move into another column
 *   writes the column's. Only a top-level key holding one value can be written, so a card
 *   whose lane value is a list stays in its lanes (`laneMovable`).
 */

import type { DocumentRow } from "@kernel";

import { fieldValue } from "../../_shared/dates.js";

import {
  NO_KEPT,
  columnsFor,
  keepColumns,
  valuesOf,
  writableField,
  type Column,
  type Filters,
  type KanbanOptions,
  type KeptColumns,
  type Scalar,
} from "./layout.js";

export interface Lane {
  /** The value as text; `undefined` for the lane of notes without one (and the only lane of a board without lanes). */
  readonly key: string | undefined;
  /** What a move into this lane writes; `undefined` removes the key. */
  readonly value: Scalar | undefined;
  /** The board's columns, holding this lane's cards; each knows its lane (`Column.lane`) when the board has lanes. */
  readonly columns: readonly Column[];
}

const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * The board as lanes. Without a lane field, one lane holding the board's columns as
 * `columnsFor` lays them out, untouched. `keptColumns` and `keptLanes` are what was shown
 * before (`keepColumns`, `keepLanes`); `only`, the lane field's filter values: just those
 * lanes.
 */
export function lanesFor(
  rows: readonly DocumentRow[],
  settings: KanbanOptions,
  keptColumns: KeptColumns = NO_KEPT,
  keptLanes: KeptColumns = NO_KEPT,
  only?: readonly Scalar[],
): readonly Lane[] {
  const all = columnsFor(rows, settings, keptColumns);
  if (settings.lanes === "") return [{ key: undefined, value: undefined, columns: all }];
  // Every column of the whole board, in every lane.
  const columns = keepColumns(all, keptColumns);
  const byLane = new Map<string, DocumentRow[]>();
  const values = new Map<string, Scalar>();
  const loose: DocumentRow[] = [];
  for (const row of rows) {
    const found = valuesOf(row, settings.lanes);
    if (found.length === 0) loose.push(row);
    for (const [key, value] of found) {
      if (!values.has(key)) values.set(key, value);
      const list = byLane.get(key) ?? [];
      list.push(row);
      byLane.set(key, list);
    }
  }
  const lane = (key: string | undefined, value: Scalar | undefined, cards: readonly DocumentRow[]): Lane => ({
    key,
    value,
    columns: columnsFor(cards, settings, columns).map((column) => ({ ...column, lane: { key, value } })),
  });
  if (only !== undefined && only.length > 0) {
    // The filter's lanes, and only those: its values as the cards hold them, where they do.
    const chosen = new Map(only.map((value) => [String(value), values.get(String(value)) ?? value]));
    return [...chosen.keys()].sort(natural).map((key) => lane(key, chosen.get(key), byLane.get(key) ?? []));
  }
  const keys = [...new Set([...values.keys(), ...keptLanes.keys])].sort(natural);
  const lanes = keys.map((key) => lane(key, values.get(key) ?? key, byLane.get(key) ?? []));
  // With no lane at all, the "No …" lane still shows the columns, to add cards to.
  if (loose.length > 0 || keptLanes.loose || lanes.length === 0) lanes.push(lane(undefined, undefined, loose));
  return lanes;
}

/**
 * What the lanes kept on screen belong to: the lane field and the filters. Kept lanes are
 * forgotten when it changes, so a lane a new filter empties goes, while one emptied by a
 * drag stays.
 */
export function laneScope(field: string, filters: Filters): string {
  return JSON.stringify([field, [...filters].map(([key, values]) => [key, values.map(String)]).sort(([a], [b]) => String(a).localeCompare(String(b)))]);
}

/** What to keep from these lanes for next time: every one that has shown a card so far. */
export function keepLanes(lanes: readonly Lane[], previous: KeptColumns): KeptColumns {
  const keys = lanes.map((lane) => lane.key).filter((key): key is string => key !== undefined);
  return {
    keys: [...new Set([...previous.keys, ...keys])],
    loose: previous.loose || lanes.some((lane) => lane.key === undefined && lane.columns.some((column) => column.cards.length > 0)),
  };
}

/** A lane's name on the board: its value, or "No …" for the notes without one. */
export function laneTitle(lane: Pick<Lane, "key">, field: string): string {
  return lane.key ?? `No ${field.replace(/^fm\./, "")}`;
}

/** The cards in a lane, each once (a card with a list column value sits in several columns). */
export function laneCount(lane: Lane): number {
  return new Set(lane.columns.flatMap((column) => column.cards.map((card) => card.id))).size;
}

/** Whether `row` holds `key` in `field` (`undefined`: holds no value there). */
export function holds(row: DocumentRow, field: string, key: string | undefined): boolean {
  const found = valuesOf(row, field);
  return key === undefined ? found.length === 0 : found.some(([candidate]) => candidate === key);
}

/** Whether a move can change this card's lane: the field is writable, and its value is not a list. */
export function laneMovable(row: DocumentRow, field: string): boolean {
  return writableField(field) && !Array.isArray(fieldValue(row, field));
}

/**
 * What dropping `row` into `column` writes to its lane: `undefined` when the lane stays the
 * same (or the board has none), `null` when the card cannot leave its lane, else the value.
 */
export function laneChange(row: DocumentRow, column: Column, field: string): { readonly value: Scalar | undefined } | null | undefined {
  const lane = column.lane;
  if (lane === undefined || field === "" || holds(row, field, lane.key)) return undefined;
  return laneMovable(row, field) ? { value: lane.value } : null;
}
