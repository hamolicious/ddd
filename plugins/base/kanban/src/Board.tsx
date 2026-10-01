/**
 * The kanban view: the search's notes as cards in columns, one per value of the field the
 * view groups by (`layout.ts`).
 *
 * **Moving a card writes the note** — its field set to the column's value by one
 * frontmatter splice (`setFrontmatterValue`), or removed for the "No …" column — and it
 * works wherever the board is, embedded in another note included.
 *
 * **A drag lifts the card**, as the folder tree lifts a row: pointer-driven, not HTML5,
 * because the browser draws an HTML5 drag as a translucent ghost no style can make solid.
 * The card under the pointer is an opaque, shadowed, slightly tilted copy, and it leaves
 * its column: a gap opens where it will land — under the pointer, between the cards it
 * will sit between, in whichever column the pointer is over — and closes behind it. Let
 * go, and the card takes that place: its column's value and a rank between its new
 * neighbours (`planRanks`). With the board's order turned off, cards follow the search's
 * order, so the gap shows where that order puts the card, and a column cannot be
 * rearranged. Over no column, the gap waits where the card came from. Columns never
 * appear or vanish during any of it (`keepColumns`). Near an edge, the board and the
 * column scroll by themselves.
 * Escape puts it back. With a mouse the drag starts after a few pixels; with a finger,
 * after a long press — and a long press let go without moving opens the card's menu
 * (`context-menu`'s, which knows the card by its `data-lm-press="release"`).
 *
 * **Everything glides.** The move shows at once, before the write lands (`withMoves`),
 * and the dropped card travels from the pointer into its slot while the cards around it
 * make room (`flip.ts`). If the write fails, the card goes back and the board says why.
 *
 * **Without a pointer**, the card's menu (right-click, or long press) has "Move to". A
 * card is an `lm/document` and a `kanban/card`, a column a `kanban/column`, the board a
 * `kanban/board`; the menus are `context-menu`'s, and the board's own entries are
 * `actions.ts`'s, which reach this board through `boards`.
 *
 * **A column's settings are on the column.** While the search is open for editing — the
 * all-documents page, or a saved board after "Edit search"; never an embed — each column's
 * header has a ⚙ that opens its settings in a sheet (`ColumnEditor.tsx`) and a ⇅ that
 * sorts it — by a field either way, or the board's order — and an "Add column" tile ends
 * the board. A sorted column's header shows its sort as an arrow, its field on hover;
 * clicking it reverses the sort. In a sorted column the sort places cards: the gap shows
 * where, and a drop only changes the column.
 *
 * **Adding a card stays on the board.** A column's + opens a title field at its top; the
 * card goes to the column's bottom (`appendRanks`). Enter makes the card and leaves the field open for the next, Escape (or leaving it
 * empty) closes it. The new card shows at once, faded, until the note it made arrives.
 *
 * **No column is taller than the screen.** The board ends at the bottom of its scrolling
 * ancestor (`useFitToScreen`), never shorter than half a screen, and each column's cards
 * scroll in a box of their own, a virtual list (`useVirtualList`): only the cards on
 * screen are in the page, the rest is padding. A drag reads the cards drawn, each of which
 * knows its slot among the column's. With swimlanes the board itself scrolls its lanes.
 *
 * **A filter bar above the board** (`FilterBar.tsx`), one pill per property the cards
 * show (the board's settings), narrows the board to the cards holding the chosen value —
 * on this screen only, nothing is saved. A card added while a filter is on is born with its value, so it
 * stays in view.
 *
 * **Swimlanes**, when the board's settings name a field for them, stack the board in rows,
 * one per value of that field, each with the same columns (`lanes.ts`). Dropping a card
 * into another lane writes that field as well as the column's; a column's + in a lane
 * makes the card with the lane's value.
 */

import { useEffect, useRef, useState } from "react";
import type { ComponentType, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

import type { DocumentRow, Kernel } from "@kernel";
import type { ContextMenu } from "plugin:context-menu";
import type { NoteLook } from "plugin:folders";
import type { FmValueSelectProps, SearchSpec } from "plugin:search";
import type { SavedViewProps } from "../../_shared/saved-view-mode.js";

import { NoteLabel, lookOf, lookStyle, useLookChanges, type Looks } from "../../_shared/note-look.js";
import { LONG_PRESS_MS, target as mark } from "../../_shared/target.js";
import { useFitToScreen, useVirtualList } from "../../_shared/virtual-list.js";

import { boards, type BoardHandle } from "./actions.js";
import { excerpt, fieldText, type CardItem } from "./card.js";
import { ColumnEditor } from "./ColumnEditor.js";
import { FilterBar } from "./FilterBar.js";
import { useFlip } from "./flip.js";
import { holds, keepLanes, laneChange, laneCount, laneTitle, lanesFor, type Lane } from "./lanes.js";
import {
  NO_KEPT,
  columnTitle,
  filterFields,
  filterRows,
  forgetColumn,
  kanbanOptions,
  keepColumns,
  movable,
  placeColumn,
  planRanks,
  RANK_KEY,
  removeColumn,
  sinceField,
  sortedSlot,
  settled,
  withColumn,
  withKanban,
  withMoves,
  writableField,
  type Column,
  type ColumnDef,
  type ColumnSort,
  type Filters,
  type KanbanOptions,
  type KeptColumns,
  type Move,
  type Scalar,
} from "./layout.js";

/** A mouse press that travels this far is a drag, not a click. */
const DRAG_THRESHOLD = 5;
/** How long a finger must rest on a card before it lifts. */
/** A touch that travels this far before a long press was a scroll. */
const LONG_PRESS_SLOP = 10;
/** A card's height before any is measured: a one-line title and its spacing. */
const CARD_ESTIMATE = 42;
/** A column is never shorter than this, so a crowded page scrolls rather than squeezing it. */
const COLUMN_MIN = 320;
/** What a swimlane's header and the gap between lanes take from a column's height. */
const LANE_CHROME = 56;
/** How close to an edge, in pixels, the board starts scrolling on its own, and how fast. */
const EDGE = 48;
const SPEED = 14;

/**
 * A sorted column's sort, folded to its arrow: the column's name is what the header is
 * for. Its field slides open beside the arrow on hover or keyboard focus; the tooltip
 * and the accessible name always carry it.
 */
const SORT_NAME =
  "kanban:max-w-0 kanban:overflow-hidden kanban:text-ellipsis kanban:whitespace-nowrap kanban:opacity-0 kanban:transition-[max-width,opacity,margin] kanban:duration-150 kanban:group-hover:ml-0.5 kanban:group-hover:max-w-[7rem] kanban:group-hover:opacity-100 kanban:group-focus-visible:ml-0.5 kanban:group-focus-visible:max-w-[7rem] kanban:group-focus-visible:opacity-100 kanban:motion-reduce:transition-none";

export interface BoardDeps {
  readonly kernel: Kernel;
  readonly looks: () => Looks | undefined;
  readonly menu: () => Pick<ContextMenu, "open" | "openSheet"> | undefined;
  /** A new card titled `title` at the bottom of `column`, born in it and with the filter's values (`create.ts`). */
  readonly addCard: (spec: SearchSpec, settings: KanbanOptions, column: Column, title: string, queued: number, filters: Filters) => Promise<string>;
  /** `search`'s value picker, for the filter bar (`FilterBar.tsx`). */
  readonly fmValueSelect: ComponentType<FmValueSelectProps>;
}

/** The card being carried, and where. */
interface Lift {
  readonly row: DocumentRow;
  readonly x: number;
  readonly y: number;
  /** Where in the card it was grabbed. */
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
  /** The column it came from, and its place there. */
  readonly from: number;
  readonly origin: number;
  /** The column under the pointer, by index, and the slot among its cards; `undefined` over none. */
  readonly over: number | undefined;
  readonly slot: number;
}

export function createBoard({ kernel, looks, menu, addCard, fmValueSelect }: BoardDeps) {
  return function BoardView({ spec, results, options, onOptionsChange, onOpen, editing }: SavedViewProps): ReactElement {
    const settings = kanbanOptions(options);
    const dress = looks();
    useLookChanges(dress);
    const [moves, setMoves] = useState<ReadonlyMap<string, Move>>(() => new Map());
    const [lift, setLift] = useState<Lift | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [board, setBoard] = useState<HTMLDivElement | null>(null);
    /** The board's height that ends at the bottom of the screen. */
    const fit = useFitToScreen(board, COLUMN_MIN);
    /** The column whose title field is open, by key (`null`: the "No …" column). */
    const [adding, setAdding] = useState<string | undefined>(undefined);
    /** Cards made here and not yet in the results: shown faded where they will appear. */
    const [pending, setPending] = useState<readonly { readonly key: string; readonly title: string; readonly id?: string; readonly token: number }[]>([]);
    const nextToken = useRef(0);
    const titleOf = (column: Column): string => columnTitle(column, settings.group);
    /** Fold or unfold a column from the board: a named one's setting, naming it if it was not. */
    const fold = (column: Column, collapsed: boolean): void => {
      if (column.key === undefined) return;
      onOptionsChange(withKanban(withColumn(settings, column.key, { collapsed }), options));
    };

    // Ranks in each card's `%%% kanban` section; off, the search's order.
    const order = settings.order;
    /** The filter bar's choices, by field: only for the properties the cards show now. */
    const [chosen, setChosen] = useState<Filters>(() => new Map());
    const fields = filterFields(settings);
    const filters: Filters = new Map([...chosen].filter(([field]) => fields.includes(field)));
    const filter = (field: string, value: Scalar | undefined): void =>
      setChosen((current) => {
        const next = new Map(current);
        if (value === undefined) next.delete(field);
        else next.set(field, value);
        return next;
      });
    const rows = filterRows(withMoves(results.rows, settings, moves), filters);
    // Columns seen while this board is on screen, for this grouping, stay.
    // Lanes too, for this lane field.
    const kept = useRef<{ group: string; lanesBy: string; columns: KeptColumns; lanes: KeptColumns }>({
      group: settings.group,
      lanesBy: settings.lanes,
      columns: NO_KEPT,
      lanes: NO_KEPT,
    });
    if (kept.current.group !== settings.group) kept.current = { ...kept.current, group: settings.group, columns: NO_KEPT };
    if (kept.current.lanesBy !== settings.lanes) kept.current = { ...kept.current, lanesBy: settings.lanes, lanes: NO_KEPT };
    const lanes = lanesFor(rows, settings, kept.current.columns, kept.current.lanes);
    // Every lane's columns, one after another: a column's index is its place in this list.
    const columns = lanes.flatMap((lane) => lane.columns);
    kept.current.columns = keepColumns(columns, kept.current.columns);
    kept.current.lanes = keepLanes(lanes, kept.current.lanes);
    const laned = settings.lanes !== "" && columns.length > 0;
    /** A column in its lane, where the column's name alone could be any lane's. */
    const placeOf = (column: Column): string =>
      laned && column.lane ? `${titleOf(column)} · ${laneTitle(column.lane, settings.lanes)}` : titleOf(column);
    /** A column in its lane, as a key: what the title field and the faded new cards belong to. */
    const cellOf = (column: Column): string => JSON.stringify([column.lane?.key ?? null, column.key ?? null]);

    // A pending move is done once the live row says the same.
    useEffect(() => {
      if (moves.size === 0) return;
      const done = [...moves].filter(([id, move]) => {
        const row = results.rows.find((candidate) => candidate.id === id);
        return !row || settled(row, settings, move);
      });
      if (done.length === 0) return;
      setMoves((current) => {
        const next = new Map(current);
        for (const [id] of done) next.delete(id);
        return next;
      });
    }, [results.rows, moves, settings.group, settings.order, settings.lanes]);

    /**
     * A column's settings in a sheet: `column` to change (named or not yet), `undefined` to
     * add one. Save puts it in place among the named columns; Remove takes it out.
     */
    const editColumn = (column: Column | undefined, anchor: HTMLElement): void => {
      const sheets = menu();
      if (!sheets) return;
      const named = settings.columns;
      const was = column?.key;
      const at = was === undefined ? -1 : named.findIndex((def) => def.value === was);
      const initial: ColumnDef = column?.def ?? { value: was ?? "" };
      const apply = (columns: readonly ColumnDef[], gone?: string): void => {
        if (gone !== undefined) kept.current.columns = forgetColumn(kept.current.columns, gone);
        onOptionsChange(withKanban({ ...settings, columns }, options));
      };
      sheets.openSheet({
        title: column ? `Column: ${titleOf(column)}` : "New column",
        anchor,
        render: (close) => (
          <ColumnEditor
            initial={initial}
            position={at === -1 ? named.length : at}
            places={at === -1 ? named.length + 1 : named.length}
            taken={named.filter((def) => def.value !== was).map((def) => def.value)}
            adding={column === undefined}
            sortFields={sortFields()}
            unsorted={order ? "Board order (drag to arrange)" : "The search's order"}
            onSave={(def, position) => {
              // A renamed column's old value goes too: its cards show under their own value.
              apply(placeColumn(named, at === -1 ? undefined : was, def, position), was !== undefined && was !== def.value ? was : undefined);
              close();
            }}
            {...(at !== -1 && was !== undefined
              ? {
                  onRemove: () => {
                    apply(removeColumn(named, was), was);
                    close();
                  },
                }
              : {})}
            onCancel={close}
          />
        ),
      });
    };
    const canEdit = editing === true && menu()?.openSheet !== undefined;

    /** Fields a column can sort by: the fixed ones, then every property the cards hold. */
    const sortFields = (): readonly { readonly field: string; readonly label: string }[] => {
      const keys = new Set<string>();
      for (const row of results.rows) for (const key of Object.keys(row.fm)) keys.add(key);
      for (const column of columns) if (column.def?.sort?.field.startsWith("fm.")) keys.add(column.def.sort.field.slice(3));
      const since = sinceField(settings.group);
      if (since) keys.delete(since.slice(3));
      return [
        // Oldest first, ascending: the cards longest in the column at the top.
        ...(since ? [{ field: since, label: "Entered column" }] : []),
        { field: "title", label: "Title" },
        { field: "created_at", label: "Created" },
        { field: "updated_at", label: "Updated" },
        { field: "content", label: "Text" },
        ...[...keys].sort((a, b) => a.localeCompare(b)).map((key) => ({ field: `fm.${key}`, label: key })),
      ];
    };
    const setSort = (column: Column, sort: ColumnSort | undefined): void => {
      if (column.key === undefined) return;
      onOptionsChange(withKanban(withColumn(settings, column.key, { sort }), options));
    };
    /** The column's sort, as a menu: what to sort by (or the board's order), and which way. */
    const openSort = (column: Column, anchor: HTMLElement): void => {
      const menus = menu();
      if (!menus) return;
      const sort = column.def?.sort;
      menus.open({
        title: `Sort ${titleOf(column)}`,
        anchor,
        sections: [
          {
            title: "Sort by",
            items: [
              {
                id: "board",
                label: order ? "Board order (drag to arrange)" : "The search's order",
                checked: sort === undefined,
                run: () => setSort(column, undefined),
              },
              ...sortFields().map((choice) => ({
                id: `by-${choice.field}`,
                label: choice.label,
                checked: sort?.field === choice.field,
                run: () => setSort(column, { field: choice.field, direction: sort?.direction ?? "asc" }),
              })),
            ],
          },
          ...(sort
            ? [
                {
                  title: "Direction",
                  items: [
                    { id: "asc", label: "Ascending", checked: sort.direction === "asc", run: () => setSort(column, { ...sort, direction: "asc" as const }) },
                    { id: "desc", label: "Descending", checked: sort.direction === "desc", run: () => setSort(column, { ...sort, direction: "desc" as const }) },
                    {
                      id: "reverse",
                      label: "Reverse",
                      run: () => setSort(column, { ...sort, direction: sort.direction === "asc" ? "desc" : "asc" }),
                    },
                  ],
                },
              ]
            : []),
        ],
      });
    };
    const sortLabel = (sort: ColumnSort): string =>
      sortFields().find((choice) => choice.field === sort.field)?.label ?? sort.field.replace(/^fm\./, "");

    // A card made here is done pending once the results hold it.
    useEffect(() => {
      if (!pending.some((card) => card.id !== undefined && results.rows.some((row) => row.id === card.id))) return;
      setPending((current) => current.filter((card) => card.id === undefined || !results.rows.some((row) => row.id === card.id)));
    }, [results.rows, pending]);

    const submit = (column: Column, title: string): void => {
      const token = nextToken.current++;
      const key = cellOf(column);
      // Cards still on their way to this column: each new one ranks below them.
      const queued = pending.filter((card) => card.key === key).length;
      setError(undefined);
      setPending((current) => [...current, { key, title, token }]);
      addCard(spec, settings, column, title, queued, filters).then(
        (id) => setPending((current) => current.map((card) => (card.token === token ? { ...card, id } : card))),
        (cause: unknown) => {
          kernel.log.error("could not add the card", cause);
          setPending((current) => current.filter((card) => card.token !== token));
          setError(`Could not add “${title}”: ${cause instanceof Error ? cause.message : String(cause)}`);
        },
      );
    };

    // Where the gap is: under the pointer, or back where the card came from.
    const gapColumn = lift === undefined ? undefined : lift.over ?? lift.from;
    const gapSlot = lift === undefined ? undefined : lift.over === undefined ? lift.origin : lift.slot;
    const signature = `${columns.map((column) => `${column.lane?.key ?? ""}/${column.key ?? ""}:${column.cards.map((card) => card.id).join(",")}`).join("|")}#${lift?.row.id ?? ""}@${gapColumn ?? ""}:${gapSlot ?? ""}`;
    const flip = useFlip(board, signature);

    /**
     * Put `row` into `column` at `slot` among its other cards: the column's value if it
     * changed, its lane's if that changed, and — when the board keeps its own order — ranks
     * for the new place.
     */
    const move = (row: DocumentRow, column: Column, slot: number): void => {
      if (!movable(row, settings.group)) return;
      // Into another lane: its value too, unless the card cannot leave its own.
      const lane = laneChange(row, column, settings.lanes);
      if (lane === null) return;
      const others = column.cards.filter((card) => card.id !== row.id);
      const same = column.cards.includes(row);
      // A sorted column places cards itself: a drop there only changes the column.
      const sorted = column.def?.sort !== undefined;
      if (same && (!order || sorted || column.cards.indexOf(row) === slot)) return;
      const ranks = !order || sorted ? new Map<string, number>() : planRanks(others, slot, row.id);
      const planned = new Map<string, Move>();
      for (const [id, rank] of ranks) planned.set(id, { rank });
      // Into another column: its value, and when it got there. Into the same column of
      // another lane: only the lane's value.
      if (!same) {
        const entering = !holds(row, settings.group, column.key);
        planned.set(row.id, {
          ...planned.get(row.id),
          ...(entering ? { group: { value: column.value }, since: new Date().toISOString() } : {}),
          ...(lane ? { lane } : {}),
        });
      }
      setError(undefined);
      setMoves((current) => new Map([...current, ...planned]));

      const groupKey = settings.group.slice("fm.".length);
      const writes: Promise<void>[] = [];
      for (const [id, planned_] of planned) {
        if (planned_.group) {
          writes.push(
            planned_.group.value === undefined
              ? kernel.documents.splice.removeFrontmatterKey(id, groupKey)
              : kernel.documents.splice.setFrontmatterValue(id, groupKey, planned_.group.value),
          );
        }
        if (planned_.lane && writableField(settings.lanes)) {
          const laneKey = settings.lanes.slice("fm.".length);
          writes.push(
            planned_.lane.value === undefined
              ? kernel.documents.splice.removeFrontmatterKey(id, laneKey)
              : kernel.documents.splice.setFrontmatterValue(id, laneKey, planned_.lane.value),
          );
        }
        if (planned_.rank !== undefined) writes.push(kernel.documents.splice.spliceSection(id, [{ key: RANK_KEY, value: planned_.rank }]));
        const since = sinceField(settings.group);
        if (planned_.since !== undefined && since !== undefined) {
          writes.push(kernel.documents.splice.setFrontmatterValue(id, since.slice(3), planned_.since));
        }
      }
      void Promise.all(writes).catch((cause: unknown) => {
        kernel.log.error("could not move the card", cause);
        setMoves((current) => {
          const next = new Map(current);
          for (const id of planned.keys()) next.delete(id);
          return next;
        });
        setError(`Could not move “${row.title}”: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    };

    // What this board's entries in the menus act on (`actions.ts`), kept current.
    const handle = useRef<BoardHandle | undefined>(undefined);
    handle.current = {
      columns,
      titleOf: placeOf,
      rowOf: (id) => rows.find((row) => row.id === id),
      movable: (row) => movable(row, settings.group),
      reaches: (row, column) => laneChange(row, column, settings.lanes) !== null,
      move,
      fold,
      add: (column) => setAdding(cellOf(column)),
      ...(canEdit ? { sort: openSort, edit: editColumn } : {}),
    };
    useEffect(() => {
      if (!board) return undefined;
      boards.set(board, handle as { readonly current: BoardHandle });
      return () => {
        boards.delete(board);
      };
    }, [board]);

    // --- the drag --------------------------------------------------------------------

    /** Read by the window listeners of a drag in flight, so they never act on stale state. */
    const latest = useRef({ columns, rows, order, move, flip, lanesBy: settings.lanes });
    latest.current = { columns, rows, order, move, flip, lanesBy: settings.lanes };
    /** A finger's press, until it lifts or is abandoned. */
    const press = useRef<{ timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

    /**
     * The column under the pointer and the slot among its cards: before the first card
     * whose middle is below the pointer. Layout positions (`offsetTop`), not boxes, so a
     * card mid-glide is where it is going.
     */
    const hitAt = (x: number, y: number, id: string): { over: number | undefined; slot: number } => {
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-kanban-column]");
      const index = element?.dataset["kanbanColumn"];
      if (!element || index === undefined) return { over: undefined, slot: 0 };
      const column = latest.current.columns[Number(index)];
      const list = element.querySelector<HTMLElement>("[data-kanban-list]");
      if (!column) return { over: undefined, slot: 0 };
      const others = column.cards.filter((card) => card.id !== id);
      // A sorted column decides for itself: the gap goes where its sort puts the card.
      const carried = latest.current.rows.find((row) => row.id === id);
      // Another lane the card cannot move to is no place to drop it: the gap waits at home.
      if (carried && laneChange(carried, column, latest.current.lanesBy) === null) return { over: undefined, slot: 0 };
      if (column.def?.sort && carried) return { over: Number(index), slot: sortedSlot(others, carried, column.def.sort) };
      // A folded column has no list to aim into: a card dropped on it goes to its end.
      if (!list) return { over: Number(index), slot: others.length };
      if (!latest.current.order) {
        // The search's order decides: the gap goes where that order puts the card.
        const rank = new Map(latest.current.rows.map((row, at) => [row.id, at]));
        const mine = rank.get(id) ?? Number.MAX_SAFE_INTEGER;
        const at = others.findIndex((card) => (rank.get(card.id) ?? 0) > mine);
        return { over: Number(index), slot: at === -1 ? others.length : at };
      }
      // The cards drawn (a virtual list: those near the viewport), each knowing its slot.
      const top = list.getBoundingClientRect().top - list.scrollTop;
      const cards = [...list.querySelectorAll<HTMLElement>("[data-card]")];
      const hit = cards.find((card) => top + card.offsetTop + card.offsetHeight / 2 > y);
      const last = cards[cards.length - 1];
      const slot = hit ? Number(hit.dataset["slot"]) : last ? Number(last.dataset["slot"]) + 1 : 0;
      return { over: Number(index), slot };
    };

    const startDrag = (event: ReactPointerEvent<HTMLElement>, row: DocumentRow, from: Column, fromIndex: number): void => {
      if (event.button !== 0 || !movable(row, settings.group)) return;
      const card = event.currentTarget;
      const box = card.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      const touch = event.pointerType === "touch";
      let lifted = false;
      let point = start;
      let frame = 0;

      const place = (x: number, y: number): void => {
        point = { x, y };
        setLift({
          row,
          x,
          y,
          dx: start.x - box.left,
          dy: start.y - box.top,
          width: box.width,
          height: box.height,
          from: fromIndex,
          origin: from.cards.indexOf(row),
          ...hitAt(x, y, row.id),
        });
      };
      // Near an edge, scroll the board sideways and the column under the pointer up or down.
      const scroll = (): void => {
        const area = board?.getBoundingClientRect();
        if (board && area) {
          if (point.x < area.left + EDGE) board.scrollLeft -= SPEED;
          else if (point.x > area.right - EDGE) board.scrollLeft += SPEED;
        }
        const list = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-kanban-list]");
        const bounds = list?.getBoundingClientRect();
        if (list && bounds) {
          if (point.y < bounds.top + EDGE) list.scrollTop -= SPEED;
          else if (point.y > bounds.bottom - EDGE) list.scrollTop += SPEED;
        }
        frame = requestAnimationFrame(scroll);
      };
      const lift = (): void => {
        lifted = true;
        document.body.style.setProperty("user-select", "none");
        document.body.style.setProperty("cursor", "grabbing");
        window.getSelection()?.removeAllRanges();
        place(point.x, point.y);
        frame = requestAnimationFrame(scroll);
      };
      // Once a finger has lifted a card, the page must not scroll under it.
      const holdStill = (touchEvent: TouchEvent): void => {
        if (lifted) touchEvent.preventDefault();
      };

      const onMove = (moveEvent: PointerEvent): void => {
        if (!lifted) {
          const travelled = Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y);
          if (touch) {
            if (travelled > LONG_PRESS_SLOP) finish(false);
            return;
          }
          if (travelled < DRAG_THRESHOLD) return;
          point = { x: moveEvent.clientX, y: moveEvent.clientY };
          lift();
          return;
        }
        place(moveEvent.clientX, moveEvent.clientY);
      };
      const finish = (landed: boolean): void => {
        if (press.current) clearTimeout(press.current.timer);
        press.current = undefined;
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("touchmove", holdStill);
        if (!lifted) return;
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        // The click that ends a drag lands on whatever is under the pointer; it is not a
        // click on that thing. Only that one click: a drag that ends with none must not eat
        // the next real one.
        const swallow = (click: MouseEvent): void => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        const hit = landed ? hitAt(point.x, point.y, row.id) : { over: undefined, slot: 0 };
        const into = hit.over === undefined ? undefined : latest.current.columns[hit.over];
        // The card glides from where it was let go, into its slot or back to its own.
        latest.current.flip.remember(
          row.id,
          new DOMRect(point.x - (start.x - box.left), point.y - (start.y - box.top), box.width, box.height),
        );
        setLift(undefined);
        // A long press let go where it started is not a move: `context-menu` opens the
        // card's menu for it.
        if (into && Math.hypot(point.x - start.x, point.y - start.y) >= LONG_PRESS_SLOP) latest.current.move(row, into, hit.slot);
      };
      const onUp = (): void => finish(true);
      const onCancel = (): void => finish(false);
      const onKey = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== "Escape" || !lifted) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finish(false);
      };

      if (touch) {
        press.current = { timer: setTimeout(lift, LONG_PRESS_MS) };
        window.addEventListener("touchmove", holdStill, { passive: false });
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    };

    const onClick = (row: DocumentRow) => (): void => onOpen(row.id);

    /** One column, `index` its place among every lane's columns (`columns`). */
    const renderColumn = (column: Column, index: number): ReactElement => {
      const hot = lift !== undefined && lift.over === index;
      // The carried card is out of its column — hidden, not removed: a finger's touch
      // events keep coming from the element it started on only while that is in the
      // page — and the gap stands where it will go.
      const cards = lift ? column.cards.filter((card) => card.id !== lift.row.id) : column.cards;
      const gapAt = gapColumn === index ? gapSlot : undefined;
      const color = column.def?.color;
      // No taller than the screen: the board's fit, less a lane's header when laned.
      const capped = fit === undefined ? undefined : laned ? Math.max(COLUMN_MIN, fit - LANE_CHROME) : fit;
      if (column.def?.collapsed === true) {
        return (
          <section
            key={column.key ?? "\u0000"}
            data-kanban-column={index}
            {...mark("kanban/column", String(index), { label: placeOf(column) })}
            aria-label={`${placeOf(column)}, folded, ${cards.length} card${cards.length === 1 ? "" : "s"}`}
            className={`kanban-column kanban-folded kanban:flex kanban:w-10 kanban:shrink-0 kanban:flex-col kanban:items-center kanban:gap-2 kanban:self-stretch kanban:rounded-lg kanban:border kanban:py-2 kanban:transition-colors kanban:duration-150 ${color ? "kanban:border-t-4" : ""} ${hot ? "kanban:border-accent kanban:bg-accent-subtle" : "kanban:border-border kanban:bg-bg-subtle"}`}
            style={color ? { borderTopColor: color } : undefined}
          >
            <button
              type="button"
              className="kanban:flex kanban:min-h-0! kanban:flex-1 kanban:flex-col kanban:items-center kanban:gap-2 kanban:border-0! kanban:bg-transparent! kanban:p-0! kanban:text-sm kanban:text-text"
              aria-label={`Unfold ${titleOf(column)}`}
              title={`Unfold ${titleOf(column)}`}
              onClick={() => fold(column, false)}
            >
              <span className="kanban:text-xs kanban:text-text-muted kanban:tabular-nums">{cards.length}</span>
              <span className="kanban:font-semibold kanban:[writing-mode:vertical-rl]">{titleOf(column)}</span>
            </button>
          </section>
        );
      }
      return (
        <section
          key={column.key ?? "\u0000"}
          data-kanban-column={index}
          {...mark("kanban/column", String(index), { label: placeOf(column) })}
          aria-label={`${placeOf(column)}, ${cards.length} card${cards.length === 1 ? "" : "s"}`}
          className={`kanban-column kanban:flex kanban:w-64 kanban:shrink-0 kanban:flex-col kanban:gap-2 kanban:rounded-lg kanban:border kanban:p-2 kanban:transition-colors kanban:duration-150 kanban:compact:w-[80vw] ${color ? "kanban:border-t-4" : ""} ${hot ? "kanban:border-accent kanban:bg-accent-subtle" : "kanban:border-border kanban:bg-bg-subtle"}`}
          style={{ ...(color ? { borderTopColor: color } : {}), ...(capped === undefined ? {} : { maxHeight: capped }) }}
        >
          <h3 className="kanban:m-0 kanban:flex kanban:shrink-0 kanban:items-center kanban:gap-1.5 kanban:text-sm kanban:font-semibold">
            {column.key !== undefined && (
              <button
                type="button"
                className="kanban:inline-flex kanban:size-6 kanban:min-h-0! kanban:items-center kanban:justify-center kanban:rounded kanban:border-0! kanban:bg-transparent! kanban:p-0! kanban:text-xs kanban:text-text-muted kanban:hover:bg-bg-raised! kanban:hover:text-text"
                aria-label={`Fold ${titleOf(column)}`}
                title="Fold"
                onClick={() => fold(column, true)}
              >
                ‹
              </button>
            )}
            {color && <span aria-hidden="true" className="kanban:size-2.5 kanban:shrink-0 kanban:rounded-full" style={{ background: color }} />}
            <span
              className={`kanban:min-w-0 kanban:flex-1 kanban:truncate ${column.key === undefined ? "kanban:italic kanban:text-text-muted" : ""}`}
              title={column.def?.label !== undefined && column.key !== undefined ? `${column.def.label} (${column.key})` : undefined}
            >
              {titleOf(column)}
            </span>
            <span className="kanban:text-xs kanban:font-normal kanban:text-text-muted kanban:tabular-nums">{cards.length}</span>
            {column.def?.sort &&
              (canEdit ? (
                <button
                  type="button"
                  className="kanban:group kanban:inline-flex kanban:min-h-0! kanban:shrink-0 kanban:items-center kanban:rounded-full! kanban:border-0! kanban:bg-bg-raised! kanban:px-1.5! kanban:py-0! kanban:text-xs kanban:font-normal kanban:text-text-muted kanban:hover:text-text"
                  aria-label={`Sorted by ${sortLabel(column.def.sort)}, ${column.def.sort.direction === "asc" ? "ascending" : "descending"}. Reverse`}
                  title={`Sorted by ${sortLabel(column.def.sort)}. Click to reverse`}
                  onClick={() => column.def?.sort && setSort(column, { ...column.def.sort, direction: column.def.sort.direction === "asc" ? "desc" : "asc" })}
                >
                  <span aria-hidden="true">{column.def.sort.direction === "asc" ? "↑" : "↓"}</span>
                  <span className={SORT_NAME}>{sortLabel(column.def.sort)}</span>
                </button>
              ) : (
                <span className="kanban:group kanban:inline-flex kanban:shrink-0 kanban:items-center kanban:text-xs kanban:font-normal kanban:text-text-muted" title={`Sorted by ${sortLabel(column.def.sort)}`}>
                  <span aria-hidden="true">{column.def.sort.direction === "asc" ? "↑" : "↓"}</span>
                  <span className={SORT_NAME}>{sortLabel(column.def.sort)}</span>
                </span>
              ))}
            {canEdit && column.key !== undefined && (
              <button
                type="button"
                className="kanban:inline-flex kanban:size-7 kanban:min-h-0! kanban:items-center kanban:justify-center kanban:rounded kanban:border-0! kanban:bg-transparent! kanban:p-0! kanban:text-sm kanban:text-text-muted kanban:hover:bg-bg-raised! kanban:hover:text-text"
                aria-label={`Sort ${titleOf(column)}`}
                aria-haspopup="menu"
                title="Sort"
                onClick={(event) => openSort(column, event.currentTarget)}
              >
                ⇅
              </button>
            )}
            {canEdit && column.key !== undefined && (
              <button
                type="button"
                className="kanban:inline-flex kanban:size-7 kanban:min-h-0! kanban:items-center kanban:justify-center kanban:rounded kanban:border-0! kanban:bg-transparent! kanban:p-0! kanban:text-sm kanban:text-text-muted kanban:hover:bg-bg-raised! kanban:hover:text-text"
                aria-label={`Settings for ${titleOf(column)}`}
                aria-haspopup="dialog"
                title="Column settings"
                onClick={(event) => editColumn(column, event.currentTarget)}
              >
                ⚙
              </button>
            )}
            <button
              type="button"
              className="kanban:inline-flex kanban:size-7 kanban:min-h-0! kanban:items-center kanban:justify-center kanban:rounded kanban:border-0! kanban:bg-transparent! kanban:p-0! kanban:text-base kanban:text-text-muted kanban:hover:bg-bg-raised! kanban:hover:text-text"
              aria-label={`Add a card to ${placeOf(column)}`}
              title={`Add a card to ${placeOf(column)}`}
              aria-expanded={adding === cellOf(column)}
              onClick={() => setAdding(cellOf(column))}
            >
              +
            </button>
          </h3>
          {/* The title field at the top, in reach of the +; the card it makes goes to the bottom. */}
          {adding === cellOf(column) && (
            <div className="kanban:shrink-0">
              <CardInput
                label={`New card in ${placeOf(column)}`}
                onSubmit={(title) => submit(column, title)}
                onClose={() => setAdding(undefined)}
              />
            </div>
          )}
          <ColumnList column={column} lift={lift} gapAt={gapAt} dress={dress} items={settings.card} group={settings.group} onPointerDown={(event, row) => startDrag(event, row, column, index)} onClick={onClick}>
            {pending
              .filter((card) => card.key === cellOf(column))
              .map((card) => (
                <div key={`pending-${String(card.token)}`} aria-busy="true" className="kanban:shrink-0 kanban:pb-1.5 kanban:opacity-60 kanban:transition-opacity kanban:duration-200 kanban:starting:opacity-0">
                  <span className="kanban:flex kanban:w-full kanban:min-w-0 kanban:items-center kanban:truncate kanban:rounded kanban:border kanban:border-dashed kanban:border-border kanban:bg-bg-raised kanban:px-2 kanban:py-1.5 kanban:text-sm">
                    {card.title}
                  </span>
                </div>
              ))}
          </ColumnList>
        </section>
      );
    };

    const addColumn = canEdit ? (
      <button
        type="button"
        className="kanban-add-column kanban:flex kanban:min-h-24! kanban:w-48 kanban:shrink-0 kanban:items-center kanban:justify-center kanban:rounded-lg kanban:border-2! kanban:border-dashed! kanban:border-border! kanban:bg-transparent! kanban:text-sm kanban:text-text-muted kanban:hover:border-accent! kanban:hover:text-text"
        aria-haspopup="dialog"
        onClick={(event) => editColumn(undefined, event.currentTarget)}
      >
        + Add column
      </button>
    ) : null;

    /** A swimlane: its value as a header that stays in view while the board scrolls sideways, over its row of columns. */
    const renderLane = (lane: Lane, first: number): ReactElement => {
      const count = laneCount(lane);
      return (
        <section
          key={lane.key ?? "\u0000"}
          aria-label={`${laneTitle(lane, settings.lanes)}, ${count} card${count === 1 ? "" : "s"}`}
          className="kanban-lane kanban:flex kanban:flex-col kanban:gap-2"
        >
          <h2
            className={`kanban:sticky kanban:left-0 kanban:m-0 kanban:flex kanban:w-fit kanban:items-center kanban:gap-1.5 kanban:text-sm kanban:font-semibold ${lane.key === undefined ? "kanban:italic kanban:text-text-muted" : ""}`}
          >
            <span>{laneTitle(lane, settings.lanes)}</span>
            <span className="kanban:text-xs kanban:font-normal kanban:not-italic kanban:text-text-muted kanban:tabular-nums">{count}</span>
          </h2>
          <div className="kanban:flex kanban:items-start kanban:gap-3">
            {lane.columns.map((column, at) => renderColumn(column, first + at))}
            {first === 0 && addColumn}
          </div>
        </section>
      );
    };
    /** Where each lane's columns start in `columns`. */
    const starts = lanes.map((_, at) => lanes.slice(0, at).reduce((sum, lane) => sum + lane.columns.length, 0));

    return (
      <div className="kanban-view kanban:flex kanban:min-w-0 kanban:flex-col kanban:gap-2 kanban:font-sans kanban:text-text">
        {error && (
          <p className="kanban:m-0 kanban:rounded kanban:border kanban:border-danger kanban:p-2 kanban:text-sm" role="alert">
            {error}
          </p>
        )}
        {fields.length > 0 && (
          <FilterBar fields={fields} rows={results.rows} filters={filters} onFilter={filter} onClear={() => setChosen(new Map())} FmValueSelect={fmValueSelect} />
        )}
        {columns.length === 0 && (
          <p className="kanban:m-0 kanban:py-4 kanban:text-sm kanban:text-text-muted">
            {filters.size > 0
              ? "No cards match the filter."
              : canEdit
                ? "No cards, and no columns yet. + Add column to start; each column gets a + for its cards."
                : "No cards, and no columns yet. Edit the search to add columns."}
          </p>
        )}
        <div
          ref={setBoard}
          {...mark("kanban/board", "")}
          className={`kanban-board kanban:flex kanban:min-w-0 kanban:items-start kanban:overflow-x-auto kanban:overscroll-x-contain kanban:pb-1 ${laned ? "kanban:flex-col kanban:gap-4 kanban:overflow-y-auto kanban:overscroll-y-contain" : "kanban:gap-3"}`}
          style={laned && fit !== undefined ? { maxHeight: fit } : undefined}
        >
          {laned ? lanes.map((lane, at) => renderLane(lane, starts[at] ?? 0)) : columns.map(renderColumn)}
          {!laned && addColumn}
        </div>
        {results.hasMore && (
          <p className="kanban:m-0 kanban:text-sm kanban:text-text-muted">
            Showing the first {results.rows.length.toLocaleString()} cards.{" "}
            <button type="button" onClick={results.more}>
              Load more
            </button>
          </p>
        )}
        {lift && <Lifted lift={lift} look={lookOf(dress, lift.row.id)} items={settings.card} />}
      </div>
    );
  };
}

/**
 * A new card's title, typed where the card will appear. Enter adds it and clears the field
 * for the next one; Enter on nothing, Escape, or leaving the field empty closes it.
 */
function CardInput({
  label,
  onSubmit,
  onClose,
}: {
  readonly label: string;
  readonly onSubmit: (title: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const [title, setTitle] = useState("");
  return (
    <input
      // Opened by a click on +: the field is what that click was for.
      autoFocus
      aria-label={label}
      placeholder="Card title — Enter to add"
      value={title}
      className="kanban-new-card kanban:tap-h kanban:w-full kanban:rounded kanban:border kanban:border-accent kanban:bg-bg kanban:px-2 kanban:text-sm kanban:text-text kanban:focus-visible:outline-2 kanban:focus-visible:outline-focus"
      onChange={(event) => setTitle(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (title.trim() === "") onClose();
          else {
            onSubmit(title.trim());
            setTitle("");
          }
        }
      }}
      onBlur={() => {
        if (title.trim() === "") onClose();
      }}
    />
  );
}

/** Where a carried card will land: a dashed slot its height, spaced below like a card's row. */
function Gap({ height }: { readonly height: number }): ReactElement {
  return (
    <li
      aria-hidden="true"
      className="kanban:mb-1.5 kanban:shrink-0 kanban:rounded kanban:border kanban:border-dashed kanban:border-accent kanban:bg-bg/40"
      style={{ height }}
    />
  );
}

/**
 * What a card shows, top to bottom, as the board's settings say (`card.ts`): the title
 * with its icon and a property as "key value", both wrapped in full, and the note's words
 * clamped to a few lines. An
 * item with nothing to show is left out; a card whose items all come out empty falls back
 * to its title, faded, so no card is ever blank.
 */
function CardBody({ row, items, look }: { readonly row: DocumentRow; readonly items: readonly CardItem[]; readonly look: NoteLook | undefined }): ReactElement {
  const lines = items
    .filter((item) => item.hidden !== true)
    .map((item) => {
      if (item.kind === "title") return <NoteLabel key="title" title={row.title} look={look} wrap />;
      if (item.kind === "content") {
        const text = excerpt(row.content);
        return text === "" ? null : (
          <span key="content" className="kanban:line-clamp-3 kanban:break-words kanban:text-xs kanban:leading-snug kanban:opacity-80">
            {text}
          </span>
        );
      }
      const text = fieldText(row, item.field);
      return text === "" ? null : (
        <span key={item.field} className="kanban:flex kanban:min-w-0 kanban:gap-1 kanban:text-xs">
          <span className="kanban:shrink-0 kanban:opacity-70">{item.field.slice("fm.".length)}</span>
          <span className="kanban:min-w-0 kanban:[overflow-wrap:anywhere]">{text}</span>
        </span>
      );
    })
    .filter((line) => line !== null);
  return (
    <span className="kanban:flex kanban:w-full kanban:min-w-0 kanban:flex-col kanban:gap-0.5">
      {lines.length > 0 ? lines : <span className="kanban:opacity-60"><NoteLabel title={row.title} look={look} wrap /></span>}
    </span>
  );
}

/**
 * A column's cards in a box that scrolls, as a virtual list: only the cards near the
 * viewport are drawn, each a row knowing its index among the column's cards and its slot
 * among them without the carried one (what a drop is placed by). The gap stands before
 * the card at its slot, or after the last when the whole column is drawn; `children`
 * (cards on their way, the title field) follow the list.
 */
function ColumnList({
  column,
  lift,
  gapAt,
  dress,
  items,
  group,
  onPointerDown,
  onClick,
  children,
}: {
  readonly column: Column;
  readonly lift: Lift | undefined;
  readonly gapAt: number | undefined;
  readonly dress: Looks | undefined;
  readonly items: readonly CardItem[];
  readonly group: string;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>, row: DocumentRow) => void;
  readonly onClick: (row: DocumentRow) => () => void;
  readonly children?: ReactNode;
}): ReactElement {
  const cards = column.cards;
  const virtual = useVirtualList({
    count: cards.length,
    keyOf: (at) => cards[at]?.id ?? String(at),
    estimate: CARD_ESTIMATE,
    // The box is the viewport, wherever the page has scrolled it.
    clipToWindow: false,
  });
  const carriedAt = lift ? cards.findIndex((card) => card.id === lift.row.id) : -1;
  const others = carriedAt === -1 ? cards.length : cards.length - 1;
  return (
    <div data-kanban-list className="kanban:relative kanban:min-h-10 kanban:min-w-0 kanban:overflow-y-auto kanban:overscroll-y-contain">
      <ul ref={virtual.listRef} className="kanban:m-0 kanban:flex kanban:list-none kanban:flex-col kanban:p-0" style={{ paddingTop: virtual.before, paddingBottom: virtual.after }}>
        {cards.slice(virtual.first, virtual.end).map((row, offset) => {
          const at = virtual.first + offset;
          const carried = at === carriedAt;
          const slot = carriedAt !== -1 && carriedAt < at ? at - 1 : at;
          return (
            <CardSlot
              key={row.id}
              index={at}
              slot={slot}
              row={row}
              look={lookOf(dress, row.id)}
              items={items}
              carried={carried}
              gapBefore={!carried && gapAt === slot ? lift?.height : undefined}
              draggable={movable(row, group)}
              onPointerDown={(event) => onPointerDown(event, row)}
              onClick={onClick(row)}
            />
          );
        })}
        {gapAt === others && lift && virtual.end === cards.length && <Gap height={lift.height} />}
      </ul>
      {children}
    </div>
  );
}

function CardSlot({
  index,
  slot,
  row,
  look,
  items,
  carried,
  gapBefore,
  draggable,
  onPointerDown,
  onClick,
}: {
  /** Its place among the column's cards, and among them without the carried one. */
  readonly index: number;
  readonly slot: number;
  readonly row: DocumentRow;
  readonly look: NoteLook | undefined;
  readonly items: readonly CardItem[];
  /** Being carried: out of the layout, but still in the page. */
  readonly carried: boolean;
  readonly gapBefore: number | undefined;
  readonly draggable: boolean;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <>
      {gapBefore !== undefined && <Gap height={gapBefore} />}
      <li
        data-virtual-index={index}
        {...(carried ? { hidden: true } : { "data-card": "", "data-slot": slot, "data-flip-id": row.id })}
        className="kanban:shrink-0 kanban:pb-1.5 kanban:transition-opacity kanban:duration-200 kanban:starting:opacity-0"
      >
        <button
          type="button"
          className={`kanban-card kanban:flex kanban:w-full kanban:min-w-0 kanban:touch-manipulation kanban:items-stretch kanban:rounded kanban:border kanban:border-border kanban:px-2! kanban:py-1.5! kanban:text-left kanban:text-sm kanban:shadow-1 kanban:transition-opacity kanban:duration-150 ${look?.background ? "" : "kanban:bg-bg-raised!"} ${draggable ? "kanban:cursor-grab" : ""}`}
          style={lookStyle(look)}
          title={row.title}
          aria-label={row.title}
          onPointerDown={onPointerDown}
          onClick={onClick}
          // A long press is the drag's too: its menu opens when it is let go in place.
          {...mark("lm/document", row.id, { label: row.title, types: ["kanban/card"], pressOnRelease: true })}
          // The drag is ours; the browser's own would draw its ghost over it.
          onDragStart={(event) => event.preventDefault()}
        >
          <CardBody row={row} items={items} look={look} />
        </button>
      </li>
    </>
  );
}

/**
 * The card being carried: opaque, raised and a little tilted, under the pointer where it
 * was grabbed. A portal, so no transformed or contained ancestor (an embed, the sidebar)
 * becomes the containing block of its `position: fixed`.
 */
function Lifted({
  lift,
  look,
  items,
}: {
  readonly lift: Lift;
  readonly look: NoteLook | undefined;
  readonly items: readonly CardItem[];
}): ReactElement {
  return createPortal(
    <div
      aria-hidden="true"
      className={`kanban-lifted kanban:pointer-events-none kanban:fixed kanban:z-[1000] kanban:flex kanban:items-stretch kanban:overflow-hidden kanban:rounded kanban:border kanban:border-border-strong kanban:px-2 kanban:py-1.5 kanban:font-sans kanban:text-sm kanban:text-text kanban:shadow-2 ${look?.background ? "" : "kanban:bg-bg-raised"}`}
      style={{
        left: lift.x - lift.dx,
        top: lift.y - lift.dy,
        width: lift.width,
        height: lift.height,
        transform: "rotate(2deg) scale(1.04)",
        ...lookStyle(look),
      }}
    >
      <CardBody row={lift.row} items={items} look={look} />
    </div>,
    document.body,
  );
}
