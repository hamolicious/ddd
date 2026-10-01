/**
 * The board's arithmetic, pure: which columns it has, which cards sit in each and in what
 * order, and what a drop writes.
 *
 * - **Columns are a field's values.** The field is the view's setting (`fm.status` by
 *   default); a note sits in the column of its value, a list value in each of its values'
 *   columns, and a note without one in a "No …" column at the end.
 * - **Named columns are the user's** (`ColumnDef`): the value a card in it holds, and how
 *   the column looks — a label shown instead of the value, a colour, folded to a strip.
 *   They are stored in the `columns` option as a comma list while they are only values
 *   (what boards stored before columns had more), and as JSON once any has more.
 * - **A column may sort its own cards** (`ColumnDef.sort`): by the title, a date, the
 *   note's text or any property, either way. Values compare as what they are — numbers as
 *   numbers, dates by time, then text in natural order — and notes without one go last
 *   whichever the direction. A sorted column places a dropped card where its sort says;
 *   an unsorted one keeps the board's order below.
 * - **A card remembers when it entered its column** (`sinceField`): moving it to another
 *   column — or making it with a column's + — writes the time to a property named after
 *   the grouping one (`status-since` beside `status`), so a column can sort by how long
 *   its cards have been in it.
 * - **Columns stay put.** Named ones (the settings' order) are always there; the others,
 *   once seen, stay while the board is on screen (`keep`) even after their last card leaves
 *   — a column vanishing mid-drag would slide every column after it out from under the
 *   pointer.
 * - **Cards are in the board's own order**, a number in the card's own `%%% kanban` section
 *   (`rank: 1024`), lowest first; cards without one follow, in the search's order. The rank
 *   is the plugin's bookkeeping, not a property of the note, so it stays out of the
 *   frontmatter. Dropping a card writes it a rank between its new neighbours
 *   (`planRanks`), renumbering the column only when there is no room or a neighbour has
 *   none. With the order turned off (`order: none`), cards follow the search's order and a
 *   drop only changes the column.
 * - **Moving a card writes the field.** Only a top-level frontmatter key can be written by
 *   one splice (`setFrontmatterValue`), and only a scalar value moves cleanly, so cards of
 *   a nested key or a list value stay where they are; the board still shows them.
 * - **A filter above the board** (`filterRows`) narrows it to the cards holding one value
 *   of a field the cards show — local to the screen, never saved. A card made under a
 *   filter is born with its value (`index.tsx`).
 * - **Swimlanes** (`lanes`, off by default) split the board into rows by a second field,
 *   each row with the same columns (`lanes.ts`). A move into another lane writes that
 *   field too, by the same splice as the column's.
 */

import type { CoreValue, DocumentRow } from "@kernel";

import { fieldValue, parseDate } from "../../_shared/dates.js";
import { bodyOf } from "../../_shared/regions.js";

import { DEFAULT_CARD, parseCard, serializeCard, type CardItem } from "./card.js";

export const DEFAULT_GROUP = "fm.status";
/** The key of a card's rank in its `%%% kanban` section. */
export const RANK_KEY = "rank";
/** How `order` is stored when it is turned off: the default is on. */
const NO_ORDER = "none";
/** The step between ranks when a column is numbered afresh. */
export const RANK_STEP = 1024;

/** A column the user named: the value it stands for, and how it looks. */
export interface ColumnDef {
  /** What a card in this column holds in the group field. */
  readonly value: string;
  /** Shown instead of the value; absent: the value. */
  readonly label?: string;
  /** A CSS colour for the column's edge; absent: none. */
  readonly color?: string;
  /** Folded to a narrow strip; cards can still be dropped on it. */
  readonly collapsed?: boolean;
  /** Cards in this column sorted by this; absent: the board's order. */
  readonly sort?: ColumnSort;
}

/** A column's own sort: a field path, `title`, or `content` (the note's text), and a direction. */
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
  /** The field whose values are the columns. */
  readonly group: string;
  /** Columns in this order first, shown even when empty. */
  readonly columns: readonly ColumnDef[];
  /** The board keeps its own order, in each card's `%%% kanban` section; `false` to follow the search's. */
  readonly order: boolean;
  /** What each card shows, top to bottom (`card.ts`). */
  readonly card: readonly CardItem[];
  /** The field whose values are the swimlanes; `""`: none, one board of columns. */
  readonly lanes: string;
}

export function kanbanOptions(options: Readonly<Record<string, string>>): KanbanOptions {
  return {
    group: options["group"] || DEFAULT_GROUP,
    columns: parseColumns(options["columns"] ?? ""),
    // Older boards named the property they kept the rank in here: on, all the same.
    order: options["order"] !== NO_ORDER,
    card: parseCard(options["card"] ?? ""),
    lanes: options["lanes"] ?? "",
  };
}

/** The view options for these settings over `options`; defaults are removed, not written. */
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

/** Named columns out of the `columns` option: JSON, or a plain comma list. Junk is dropped, a repeated value kept once. */
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

/** The `columns` option for these: a comma list while they are values alone, else compact JSON. */
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

/** A typed column list: comma-separated, trimmed, empties and repeats dropped. */
export function splitColumns(raw: string): readonly string[] {
  return [...new Set(raw.split(",").map((part) => part.trim()).filter((part) => part !== ""))];
}

export interface Column {
  /** The value as text; `undefined` for the column of notes without one. */
  readonly key: string | undefined;
  /** What to write when a card moves here; `undefined` removes the key. */
  readonly value: CoreValue | undefined;
  readonly cards: readonly DocumentRow[];
  /** The user's definition, for a named column. */
  readonly def?: ColumnDef;
  /** The swimlane this column stands in, when the board has them (`lanes.ts`). */
  readonly lane?: LaneRef;
}

/** A swimlane, as a column in it knows it: its value as text, and what a move into it writes. */
export interface LaneRef {
  /** `undefined` for the lane of notes without a value. */
  readonly key: string | undefined;
  /** `undefined` removes the key. */
  readonly value: Scalar | undefined;
}

/** What a card sorts by in a column sorted by `field`. */
function sortValue(row: DocumentRow, field: string): unknown {
  if (field === "title") return row.title;
  if (field === "content") return row.content === undefined ? undefined : bodyOf(row.content).trim();
  return fieldValue(row, field);
}

/** A value as something to compare: a number, a time, or text; `undefined` for nothing. */
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

/**
 * Cards in a column's own order: by `sort`, missing values last either way, ties in the
 * order they came. Numbers before dates before text when a field holds a mixture.
 */
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

/** Where `row` lands among a sorted column's `others`: where the sort puts it. */
export function sortedSlot(others: readonly DocumentRow[], row: DocumentRow, sort: ColumnSort): number {
  return sortCards([...others, row], sort).indexOf(row);
}

/** Columns seen before, kept while their cards come and go. */
export interface KeptColumns {
  readonly keys: readonly string[];
  /** The "No …" column was shown. */
  readonly loose: boolean;
}

export const NO_KEPT: KeptColumns = { keys: [], loose: false };

/** A value a card can be filed under: one that is its own column key. */
export type Scalar = string | number | boolean;

function isScalar(value: CoreValue | undefined): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** The group field's values on a note, as column keys, with the values they came from. */
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

/** A card's rank, in its own `%%% kanban` section, if it has one. */
export function rankOf(row: DocumentRow): number | undefined {
  const section = (row.plugins as Readonly<Record<string, unknown>> | undefined)?.["kanban"];
  if (section === null || typeof section !== "object" || Array.isArray(section)) return undefined;
  return numeric((section as Readonly<Record<string, unknown>>)[RANK_KEY]);
}

/** Cards by rank, the unranked after, each group in the search's order. */
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

/** What to keep from these columns for next time: every one shown so far. */
export function keepColumns(columns: readonly Column[], previous: KeptColumns): KeptColumns {
  const keys = columns.map((column) => column.key).filter((key): key is string => key !== undefined);
  return {
    keys: [...new Set([...previous.keys, ...keys])],
    loose: previous.loose || columns.some((column) => column.key === undefined),
  };
}

/** Whether a field can be written by one splice: a top-level frontmatter key. */
export function writableField(field: string): boolean {
  return /^fm\.[A-Za-z0-9_-]{1,64}$/.test(field);
}

/** Whether moving a card can write the group field. */
export function writableGroup(group: string): boolean {
  return writableField(group);
}

/** Whether this card can move: the field is writable, and its value is not a list. */
export function movable(row: DocumentRow, group: string): boolean {
  return writableGroup(group) && !Array.isArray(fieldValue(row, group));
}

/**
 * The ranks a drop writes: the moved card's, between its new neighbours in `cards` (the
 * column as shown, without the moved card) at `slot`; or, when a neighbour has no rank or
 * there is no room left between them, the whole column afresh, `RANK_STEP` apart.
 */
export function planRanks(cards: readonly DocumentRow[], slot: number, id: string): ReadonlyMap<string, number> {
  const before = slot > 0 ? cards[slot - 1] : undefined;
  const after = slot < cards.length ? cards[slot] : undefined;
  const low = before === undefined ? undefined : rankOf(before);
  const high = after === undefined ? undefined : rankOf(after);
  const fits = (before === undefined || low !== undefined) && (after === undefined || high !== undefined);
  if (fits) {
    const rank =
      low === undefined && high === undefined
        ? RANK_STEP
        : low === undefined
          ? (high as number) - RANK_STEP
          : high === undefined
            ? low + RANK_STEP
            : (low + high) / 2;
    // Room between them, and a number that writes back exactly.
    if ((low === undefined || rank > low) && (high === undefined || rank < high) && Number.isFinite(rank)) {
      return new Map([[id, rank]]);
    }
  }
  const sequence = [...cards.slice(0, slot).map((card) => card.id), id, ...cards.slice(slot).map((card) => card.id)];
  return new Map(sequence.map((card, index) => [card, (index + 1) * RANK_STEP]));
}

/**
 * The ranks that put a new card at the bottom of a column: `cards` as shown (in one lane,
 * on a board with swimlanes), with `queued` new cards on their way below them. When every
 * card has a rank, the new one's alone, a step below the highest; when some have none —
 * they sort after every ranked card, so no rank could put it below them — the column is
 * numbered afresh as shown, `RANK_STEP` apart, and the new card after it. `id` is the
 * key the new card's rank is returned under.
 */
export function appendRanks(cards: readonly DocumentRow[], queued: number, id: string): ReadonlyMap<string, number> {
  const ranks = cards.map(rankOf);
  if (ranks.every((rank) => rank !== undefined)) {
    const top = ranks.length > 0 ? Math.max(...(ranks as number[])) : 0;
    return new Map([[id, top + RANK_STEP * (1 + queued)]]);
  }
  return new Map([...cards.map((card, index): [string, number] => [card.id, (index + 1) * RANK_STEP]), [id, (cards.length + 1 + queued) * RANK_STEP]]);
}

/** A card's move not yet saved: its new column's value, its new rank, or both. */
export interface Move {
  /** Present when the column changes: the value to write, `undefined` to remove it. */
  readonly group?: { readonly value: CoreValue | undefined };
  readonly rank?: number;
  /** When it entered its new column, as an ISO time; with `group`. */
  readonly since?: string;
  /** Present when the swimlane changes: the value to write, `undefined` to remove it. */
  readonly lane?: { readonly value: CoreValue | undefined };
}

/** Whether `now` (a field's live value) is what writing `value` left there. */
function holdsWritten(now: unknown, value: CoreValue | undefined): boolean {
  return value === undefined ? now === undefined || now === null || now === "" : now === value || String(now) === String(value);
}

/**
 * The property recording when a card entered its column: the grouping key with `-since`
 * (`fm.status` → `fm.status-since`). `undefined` when the group cannot be written, or the
 * name would be too long to be a key.
 */
export function sinceField(group: string): string | undefined {
  if (!writableGroup(group)) return undefined;
  const field = `${group}-since`;
  return writableField(field) ? field : undefined;
}

/** Pending moves shown on copies of the rows, so the board is right before the writes land. */
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

/** Whether the live row already says what a move wrote. */
export function settled(row: DocumentRow, settings: KanbanOptions, move: Move): boolean {
  if (move.group && !holdsWritten(fieldValue(row, settings.group), move.group.value)) return false;
  if (move.lane && !holdsWritten(fieldValue(row, settings.lanes), move.lane.value)) return false;
  return move.rank === undefined || rankOf(row) === move.rank;
}

/** A filter above the board: for each field, the one value a shown card must hold. */
export type Filters = ReadonlyMap<string, Scalar>;

/** The fields the board can filter by: every property the cards show. */
export function filterFields(settings: KanbanOptions): readonly string[] {
  return settings.card.flatMap((item) => (item.kind === "field" ? [item.field] : []));
}

/** The values `field` takes across `rows`, each once, in natural order: what a filter offers. */
export function filterChoices(rows: readonly DocumentRow[], field: string): readonly Scalar[] {
  const seen = new Map<string, Scalar>();
  for (const row of rows) for (const [key, value] of valuesOf(row, field)) if (!seen.has(key)) seen.set(key, value);
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })).map(([, value]) => value);
}

/** The rows holding every filter's value (a list value counts when any of its items does). */
export function filterRows(rows: readonly DocumentRow[], filters: Filters): readonly DocumentRow[] {
  if (filters.size === 0) return rows;
  return rows.filter((row) => [...filters].every(([field, value]) => valuesOf(row, field).some(([key]) => key === String(value))));
}

/** What a card made under `filters` is born with: each filter's value, where a note can be given it. */
export function bornWith(filters: Filters): Readonly<Record<string, Scalar>> {
  return Object.fromEntries([...filters].filter(([field]) => writableField(field)).map(([field, value]) => [field.slice(3), value]));
}

/** A column's name on the board: its label, its value, or "No …" for the notes without one. */
export function columnTitle(column: Column, group: string): string {
  return column.def?.label ?? column.key ?? `No ${group.replace(/^fm\./, "")}`;
}

/** The settings with the named column `value` changed by `patch`, or added (folded, say) when it was not named. */
export function withColumn(settings: KanbanOptions, value: string, patch: Partial<Omit<ColumnDef, "value">>): KanbanOptions {
  const found = settings.columns.some((def) => def.value === value);
  const columns = found
    ? settings.columns.map((def) => (def.value === value ? { ...def, ...patch } : def))
    : [...settings.columns, { value, ...patch }];
  return { ...settings, columns };
}

/**
 * The named columns with `def` in place of the one named `was` (`undefined`: a column not
 * named until now), standing at `position` among them.
 */
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

/** The named columns without `value`. */
export function removeColumn(defs: readonly ColumnDef[], value: string): readonly ColumnDef[] {
  return defs.filter((def) => def.value !== value);
}

/** Kept columns without `value`: a column removed or renamed from the board goes at once. */
export function forgetColumn(kept: KeptColumns, value: string): KeptColumns {
  return { ...kept, keys: kept.keys.filter((key) => key !== value) };
}
