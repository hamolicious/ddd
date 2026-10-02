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
  readonly key: string | undefined;
  readonly value: Scalar | undefined;
  readonly columns: readonly Column[];
}

const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export function lanesFor(
  rows: readonly DocumentRow[],
  settings: KanbanOptions,
  keptColumns: KeptColumns = NO_KEPT,
  keptLanes: KeptColumns = NO_KEPT,
  only?: readonly Scalar[],
): readonly Lane[] {
  const all = columnsFor(rows, settings, keptColumns);
  if (settings.lanes === "") return [{ key: undefined, value: undefined, columns: all }];
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
    const chosen = new Map(only.map((value) => [String(value), values.get(String(value)) ?? value]));
    return [...chosen.keys()].sort(natural).map((key) => lane(key, chosen.get(key), byLane.get(key) ?? []));
  }
  const keys = [...new Set([...values.keys(), ...keptLanes.keys])].sort(natural);
  const lanes = keys.map((key) => lane(key, values.get(key) ?? key, byLane.get(key) ?? []));
  if (loose.length > 0 || keptLanes.loose || lanes.length === 0) lanes.push(lane(undefined, undefined, loose));
  return lanes;
}

export function laneScope(field: string, filters: Filters): string {
  return JSON.stringify([field, [...filters].map(([key, values]) => [key, values.map(String)]).sort(([a], [b]) => String(a).localeCompare(String(b)))]);
}

export function keepLanes(lanes: readonly Lane[], previous: KeptColumns): KeptColumns {
  const keys = lanes.map((lane) => lane.key).filter((key): key is string => key !== undefined);
  return {
    keys: [...new Set([...previous.keys, ...keys])],
    loose: previous.loose || lanes.some((lane) => lane.key === undefined && lane.columns.some((column) => column.cards.length > 0)),
  };
}

export function laneTitle(lane: Pick<Lane, "key">, field: string): string {
  return lane.key ?? `No ${field.replace(/^fm\./, "")}`;
}

export function laneCount(lane: Lane): number {
  return new Set(lane.columns.flatMap((column) => column.cards.map((card) => card.id))).size;
}

export function holds(row: DocumentRow, field: string, key: string | undefined): boolean {
  const found = valuesOf(row, field);
  return key === undefined ? found.length === 0 : found.some(([candidate]) => candidate === key);
}

export function laneMovable(row: DocumentRow, field: string): boolean {
  return writableField(field) && !Array.isArray(fieldValue(row, field));
}

export function laneChange(row: DocumentRow, column: Column, field: string): { readonly value: Scalar | undefined } | null | undefined {
  const lane = column.lane;
  if (lane === undefined || field === "" || holds(row, field, lane.key)) return undefined;
  return laneMovable(row, field) ? { value: lane.value } : null;
}
