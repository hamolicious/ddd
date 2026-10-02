import type { CoreValue, DocumentRow } from "@kernel";

import { fieldValue, parseDate } from "../../_shared/dates.js";
import { bodyOf } from "../../_shared/regions.js";

import { DEFAULT_CARD, parseCard, serializeCard, type CardItem } from "./card.js";

export const DEFAULT_GROUP = "fm.status";
export const RANK_KEY = "rank";
const NO_ORDER = "none";
export const RANK_STEP = 1024;

export interface ColumnDef {
  readonly value: string;
  readonly label?: string;
  readonly color?: string;
  readonly collapsed?: boolean;
  readonly sort?: ColumnSort;
}

export interface ColumnSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

const SORT_FIELD = /^(?:title|content|created_at|updated_at|fm\.[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})*)$/;

function parseSort(raw: unknown): ColumnSort | undefined {
  if (typeof raw !== "string") return undefined;
  const at = raw.lastIndexOf(":");
  const field = raw.slice(0, at);
  const direction = raw.slice(at + 1);
  if (at <= 0 || !SORT_FIELD.test(field) || (direction !== "asc" && direction !== "desc")) return undefined;
  return { field, direction };
}

export interface KanbanOptions {
  readonly group: string;
  readonly columns: readonly ColumnDef[];
  readonly order: boolean;
  readonly card: readonly CardItem[];
  readonly lanes: string;
}

export function kanbanOptions(options: Readonly<Record<string, string>>): KanbanOptions {
  return {
    group: options["group"] || DEFAULT_GROUP,
    columns: parseColumns(options["columns"] ?? ""),
    order: options["order"] !== NO_ORDER,
    card: parseCard(options["card"] ?? ""),
    lanes: options["lanes"] ?? "",
  };
}

export function withKanban(settings: KanbanOptions, options: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const { group: _group, columns: _columns, order: _order, card: _card, lanes: _lanes, ...rest } = options;
  const card = serializeCard(settings.card);
  return {
    ...rest,
    ...(settings.group === DEFAULT_GROUP ? {} : { group: settings.group }),
    ...(settings.columns.length === 0 ? {} : { columns: serializeColumns(settings.columns) }),
    ...(settings.order ? {} : { order: NO_ORDER }),
    ...(card === serializeCard(DEFAULT_CARD) ? {} : { card }),
    ...(settings.lanes === "" ? {} : { lanes: settings.lanes }),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

export function parseColumns(raw: string): readonly ColumnDef[] {
  const text = raw.trim();
  if (!text.startsWith("[")) return splitColumns(text).map((value) => ({ value }));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const defs: ColumnDef[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { v, l, c, x, s: sortBy } = item as { v?: unknown; l?: unknown; c?: unknown; x?: unknown; s?: unknown };
    const sort = parseSort(sortBy);
    if (typeof v !== "string" || v.trim() === "" || seen.has(v.trim())) continue;
    seen.add(v.trim());
    defs.push({
      value: v.trim(),
      ...(typeof l === "string" && l.trim() !== "" ? { label: l.trim() } : {}),
      ...(typeof c === "string" && HEX.test(c) ? { color: c.toLowerCase() } : {}),
      ...(x === true || x === 1 ? { collapsed: true } : {}),
      ...(sort ? { sort } : {}),
    });
  }
  return defs;
}

export function serializeColumns(defs: readonly ColumnDef[]): string {
  const clean = defs.filter((def) => def.value.trim() !== "");
  const plain = clean.every(
    (def) =>
      (def.label === undefined || def.label.trim() === "") &&
      def.color === undefined &&
      def.collapsed !== true &&
      def.sort === undefined &&
      !def.value.includes(","),
  );
  if (plain) return clean.map((def) => def.value.trim()).join(",");
  return JSON.stringify(
    clean.map((def) => ({
      v: def.value.trim(),
      ...(def.label !== undefined && def.label.trim() !== "" ? { l: def.label.trim() } : {}),
      ...(def.color !== undefined ? { c: def.color } : {}),
      ...(def.collapsed === true ? { x: 1 } : {}),
      ...(def.sort ? { s: `${def.sort.field}:${def.sort.direction}` } : {}),
    })),
  );
}

export function splitColumns(raw: string): readonly string[] {
  return [...new Set(raw.split(",").map((part) => part.trim()).filter((part) => part !== ""))];
}

export interface Column {
  readonly key: string | undefined;
  readonly value: CoreValue | undefined;
  readonly cards: readonly DocumentRow[];
  readonly def?: ColumnDef;
  readonly lane?: LaneRef;
}

export interface LaneRef {
  readonly key: string | undefined;
  readonly value: Scalar | undefined;
}

function sortValue(row: DocumentRow, field: string): unknown {
  if (field === "title") return row.title;
  if (field === "content") return row.content === undefined ? undefined : bodyOf(row.content).trim();
  return fieldValue(row, field);
}

function comparable(value: unknown): { readonly rank: 0 | 1 | 2; readonly key: number | string } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return { rank: 0, key: value };
  if (typeof value === "boolean") return { rank: 0, key: value ? 1 : 0 };
  const date = parseDate(value);
  if (date) return { rank: 1, key: date.getTime() };
  if (typeof value === "string") {
    const number = Number(value);
    if (value.trim() !== "" && Number.isFinite(number)) return { rank: 0, key: number };
    return { rank: 2, key: value };
  }
  if (Array.isArray(value)) return comparable(value[0]);
  return { rank: 2, key: JSON.stringify(value) };
}

export function sortCards(cards: readonly DocumentRow[], sort: ColumnSort): readonly DocumentRow[] {
  const keyed = cards.map((card, index) => ({ card, index, value: comparable(sortValue(card, sort.field)) }));
  const flip = sort.direction === "desc" ? -1 : 1;
  keyed.sort((a, b) => {
    if (a.value === undefined || b.value === undefined) {
      return a.value === b.value ? a.index - b.index : a.value === undefined ? 1 : -1;
    }
    if (a.value.rank !== b.value.rank) return (a.value.rank - b.value.rank) * flip;
    const order =
      typeof a.value.key === "number" && typeof b.value.key === "number"
        ? a.value.key - b.value.key
        : String(a.value.key).localeCompare(String(b.value.key), undefined, { sensitivity: "base", numeric: true });
    return order === 0 ? a.index - b.index : order * flip;
  });
  return keyed.map((entry) => entry.card);
}

export function sortedSlot(others: readonly DocumentRow[], row: DocumentRow, sort: ColumnSort): number {
  return sortCards([...others, row], sort).indexOf(row);
}

export interface KeptColumns {
  readonly keys: readonly string[];
  readonly loose: boolean;
}

export const NO_KEPT: KeptColumns = { keys: [], loose: false };

export type Scalar = string | number | boolean;

function isScalar(value: CoreValue | undefined): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function valuesOf(row: DocumentRow, group: string): readonly (readonly [string, Scalar])[] {
  const value = fieldValue(row, group);
  const items = Array.isArray(value) ? value : [value];
  const seen = new Map<string, Scalar>();
  for (const item of items) {
    if (!isScalar(item) || item === "") continue;
    if (!seen.has(String(item))) seen.set(String(item), item);
  }
  return [...seen];
}

const numeric = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
};

export function rankOf(row: DocumentRow): number | undefined {
  const section = (row.plugins as Readonly<Record<string, unknown>> | undefined)?.["kanban"];
  if (section === null || typeof section !== "object" || Array.isArray(section)) return undefined;
  return numeric((section as Readonly<Record<string, unknown>>)[RANK_KEY]);
}

function ordered(cards: readonly DocumentRow[], order: boolean, position: ReadonlyMap<string, number>): readonly DocumentRow[] {
  if (!order) return cards;
  return [...cards].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
    if (ra !== undefined && rb === undefined) return -1;
    if (ra === undefined && rb !== undefined) return 1;
    return (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0);
  });
}

export function columnsFor(rows: readonly DocumentRow[], settings: KanbanOptions, kept: KeptColumns = NO_KEPT): readonly Column[] {
  const cards = new Map<string, DocumentRow[]>();
  const values = new Map<string, CoreValue>();
  const loose: DocumentRow[] = [];
  const position = new Map(rows.map((row, index) => [row.id, index]));
  for (const row of rows) {
    const found = valuesOf(row, settings.group);
    if (found.length === 0) loose.push(row);
    for (const [key, value] of found) {
      if (!values.has(key)) values.set(key, value);
      const list = cards.get(key) ?? [];
      list.push(row);
      cards.set(key, list);
    }
  }
  const defs = new Map(settings.columns.map((def) => [def.value, def]));
  const named = settings.columns.map((def) => def.value);
  const others = [...new Set([...values.keys(), ...kept.keys])]
    .filter((key) => !defs.has(key))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const columns: Column[] = [...named, ...others].map((key) => {
    const def = defs.get(key);
    const board = ordered(cards.get(key) ?? [], settings.order, position);
    return {
      key,
      value: values.get(key) ?? key,
      cards: def?.sort ? sortCards(board, def.sort) : board,
      ...(def ? { def } : {}),
    };
  });
  if (loose.length > 0 || kept.loose) columns.push({ key: undefined, value: undefined, cards: ordered(loose, settings.order, position) });
  return columns;
}

export function keepColumns(columns: readonly Column[], previous: KeptColumns): KeptColumns {
  const keys = columns.map((column) => column.key).filter((key): key is string => key !== undefined);
  return {
    keys: [...new Set([...previous.keys, ...keys])],
    loose: previous.loose || columns.some((column) => column.key === undefined),
  };
}

export function writableField(field: string): boolean {
  return /^fm\.[A-Za-z0-9_-]{1,64}$/.test(field);
}

export function writableGroup(group: string): boolean {
  return writableField(group);
}

export function movable(row: DocumentRow, group: string): boolean {
  return writableGroup(group) && !Array.isArray(fieldValue(row, group));
}

export function planRanks(cards: readonly DocumentRow[], slot: number, ids: readonly string[]): ReadonlyMap<string, number> {
  const before = slot > 0 ? cards[slot - 1] : undefined;
  const after = slot < cards.length ? cards[slot] : undefined;
  const low = before === undefined ? undefined : rankOf(before);
  const high = after === undefined ? undefined : rankOf(after);
  const fits = (before === undefined || low !== undefined) && (after === undefined || high !== undefined);
  const n = ids.length;
  if (fits && n > 0) {
    const ranks =
      low === undefined && high === undefined
        ? ids.map((_, k) => RANK_STEP * (k + 1))
        : low === undefined
          ? ids.map((_, k) => (high as number) - RANK_STEP * (n - k))
          : high === undefined
            ? ids.map((_, k) => low + RANK_STEP * (k + 1))
            : ids.map((_, k) => low + ((high - low) / (n + 1)) * (k + 1));
    const room = ranks.every(
      (rank, k) => Number.isFinite(rank) && (k === 0 ? low === undefined || rank > low : rank > (ranks[k - 1] as number)),
    );
    if (room && (high === undefined || (ranks[n - 1] as number) < high)) return new Map(ids.map((id, k) => [id, ranks[k] as number]));
  }
  const sequence = [...cards.slice(0, slot).map((card) => card.id), ...ids, ...cards.slice(slot).map((card) => card.id)];
  return new Map(sequence.map((card, index) => [card, (index + 1) * RANK_STEP]));
}

export function appendRanks(cards: readonly DocumentRow[], queued: number, id: string): ReadonlyMap<string, number> {
  const ranks = cards.map(rankOf);
  if (ranks.every((rank) => rank !== undefined)) {
    const top = ranks.length > 0 ? Math.max(...(ranks as number[])) : 0;
    return new Map([[id, top + RANK_STEP * (1 + queued)]]);
  }
  return new Map([...cards.map((card, index): [string, number] => [card.id, (index + 1) * RANK_STEP]), [id, (cards.length + 1 + queued) * RANK_STEP]]);
}

export interface Move {
  readonly group?: { readonly value: CoreValue | undefined };
  readonly rank?: number;
  readonly since?: string;
  readonly lane?: { readonly value: CoreValue | undefined };
}

function holdsWritten(now: unknown, value: CoreValue | undefined): boolean {
  return value === undefined ? now === undefined || now === null || now === "" : now === value || String(now) === String(value);
}

export function sinceField(group: string): string | undefined {
  if (!writableGroup(group)) return undefined;
  const field = `${group}-since`;
  return writableField(field) ? field : undefined;
}

export function withMoves(
  rows: readonly DocumentRow[],
  settings: KanbanOptions,
  moves: ReadonlyMap<string, Move>,
): readonly DocumentRow[] {
  if (moves.size === 0) return rows;
  const groupKey = writableField(settings.group) ? settings.group.slice(3) : undefined;
  return rows.map((row) => {
    const move = moves.get(row.id);
    if (!move) return row;
    let fm: Record<string, CoreValue> = { ...row.fm };
    if (move.group && groupKey !== undefined) {
      const { [groupKey]: _old, ...rest } = fm;
      fm = move.group.value === undefined ? rest : { ...rest, [groupKey]: move.group.value };
    }
    const since = sinceField(settings.group);
    if (move.since !== undefined && since !== undefined) fm = { ...fm, [since.slice(3)]: move.since };
    if (move.lane && writableField(settings.lanes)) {
      const { [settings.lanes.slice(3)]: _old, ...rest } = fm;
      fm = move.lane.value === undefined ? rest : { ...rest, [settings.lanes.slice(3)]: move.lane.value };
    }
    if (move.rank === undefined) return { ...row, fm };
    const own = row.plugins["kanban"];
    const section = own !== null && typeof own === "object" && !Array.isArray(own) ? own : {};
    return { ...row, fm, plugins: { ...row.plugins, kanban: { ...section, [RANK_KEY]: move.rank } } };
  });
}

export function settled(row: DocumentRow, settings: KanbanOptions, move: Move): boolean {
  if (move.group && !holdsWritten(fieldValue(row, settings.group), move.group.value)) return false;
  if (move.lane && !holdsWritten(fieldValue(row, settings.lanes), move.lane.value)) return false;
  return move.rank === undefined || rankOf(row) === move.rank;
}

export type Filters = ReadonlyMap<string, readonly Scalar[]>;

export function filterFields(settings: KanbanOptions): readonly string[] {
  const shown = settings.card.flatMap((item) => (item.kind === "field" ? [item.field] : []));
  return settings.lanes.startsWith("fm.") && !shown.includes(settings.lanes) ? [settings.lanes, ...shown] : shown;
}

export function filterChoices(rows: readonly DocumentRow[], field: string): readonly Scalar[] {
  const seen = new Map<string, Scalar>();
  for (const row of rows) for (const [key, value] of valuesOf(row, field)) if (!seen.has(key)) seen.set(key, value);
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })).map(([, value]) => value);
}

export function filterRows(rows: readonly DocumentRow[], filters: Filters): readonly DocumentRow[] {
  if (filters.size === 0) return rows;
  return rows.filter((row) =>
    [...filters].every(([field, values]) => {
      const keys = new Set(values.map(String));
      return valuesOf(row, field).some(([key]) => keys.has(key));
    }),
  );
}

export function toggleValue(values: readonly Scalar[], value: Scalar): readonly Scalar[] {
  return values.some((each) => String(each) === String(value)) ? values.filter((each) => String(each) !== String(value)) : [...values, value];
}

export function bornWith(filters: Filters): Readonly<Record<string, Scalar>> {
  return Object.fromEntries(
    [...filters].flatMap(([field, values]) => (writableField(field) && values.length === 1 && values[0] !== undefined ? [[field.slice(3), values[0]] as const] : [])),
  );
}

export function columnTitle(column: Column, group: string): string {
  return column.def?.label ?? column.key ?? `No ${group.replace(/^fm\./, "")}`;
}

export function withColumn(settings: KanbanOptions, value: string, patch: Partial<Omit<ColumnDef, "value">>): KanbanOptions {
  const found = settings.columns.some((def) => def.value === value);
  const columns = found
    ? settings.columns.map((def) => (def.value === value ? { ...def, ...patch } : def))
    : [...settings.columns, { value, ...patch }];
  return { ...settings, columns };
}

export function placeColumn(
  defs: readonly ColumnDef[],
  was: string | undefined,
  def: ColumnDef,
  position: number,
): readonly ColumnDef[] {
  const rest = defs.filter((candidate) => candidate.value !== was && candidate.value !== def.value);
  const at = Math.max(0, Math.min(rest.length, position));
  return [...rest.slice(0, at), def, ...rest.slice(at)];
}

export function removeColumn(defs: readonly ColumnDef[], value: string): readonly ColumnDef[] {
  return defs.filter((def) => def.value !== value);
}

export function forgetColumn(kept: KeptColumns, value: string): KeptColumns {
  return { ...kept, keys: kept.keys.filter((key) => key !== value) };
}
