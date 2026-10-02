import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, SyntheticEvent } from "react";
import { createPortal } from "react-dom";

import type { DocumentRow, Kernel } from "@kernel";
import type { ContextMenu } from "plugin:context-menu";
import type { NoteLook } from "plugin:folders";
import { onChange as onMarkdownChange, render as renderMarkdown, renderDocLink } from "plugin:markdown";
import type { FmValueSelectProps, SearchSpec } from "plugin:search";
import type { SavedViewProps } from "../../_shared/saved-view-mode.js";

import { NoteLabel, lookOf, lookStyle, useLookChanges, type Looks } from "../../_shared/note-look.js";
import { bodyOf } from "../../_shared/regions.js";
import { LONG_PRESS_MS, target as mark } from "../../_shared/target.js";
import { useFitToScreen, useVirtualList } from "../../_shared/virtual-list.js";

import { boards, selectionItems, type BoardHandle, type DocumentAction } from "./actions.js";
import { fieldParts, type CardItem } from "./card.js";
import { ColumnEditor } from "./ColumnEditor.js";
import { FilterBar } from "./FilterBar.js";
import { useFlip } from "./flip.js";
import { holds, keepLanes, laneChange, laneCount, laneScope, laneTitle, lanesFor, type Lane } from "./lanes.js";
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

const DRAG_THRESHOLD = 5;
const LONG_PRESS_SLOP = 10;
const CARD_ESTIMATE = 42;
const CARD_GAP = 6;
const COLUMN_MIN = 320;
const LANE_CHROME = 56;
const EDGE = 48;
const SPEED = 14;

const SORT_NAME =
  "kanban:max-w-0 kanban:overflow-hidden kanban:text-ellipsis kanban:whitespace-nowrap kanban:opacity-0 kanban:transition-[max-width,opacity,margin] kanban:duration-150 kanban:group-hover:ml-0.5 kanban:group-hover:max-w-[7rem] kanban:group-hover:opacity-100 kanban:group-focus-visible:ml-0.5 kanban:group-focus-visible:max-w-[7rem] kanban:group-focus-visible:opacity-100 kanban:motion-reduce:transition-none";

export interface BoardDeps {
  readonly kernel: Kernel;
  readonly looks: () => Looks | undefined;
  readonly menu: () => Pick<ContextMenu, "open" | "openSheet"> | undefined;
  readonly addCard: (spec: SearchSpec, settings: KanbanOptions, column: Column, title: string, queued: number, filters: Filters) => Promise<string>;
  readonly fmValueSelect: ComponentType<FmValueSelectProps>;
  readonly documentActions: () => readonly DocumentAction[];
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const modified = (event: { readonly shiftKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean }): boolean =>
  event.shiftKey || event.ctrlKey || event.metaKey;

interface Lift {
  readonly row: DocumentRow;
  readonly ids: readonly string[];
  readonly block: number;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
  readonly from: number;
  readonly origin: number;
  readonly over: number | undefined;
  readonly slot: number;
}

export function createBoard({ kernel, looks, menu, addCard, fmValueSelect, documentActions }: BoardDeps) {
  return function BoardView({ spec, results, options, onOptionsChange, onOpen, editing }: SavedViewProps): ReactElement {
    const settings = kanbanOptions(options);
    const dress = looks();
    useLookChanges(dress);
    const [moves, setMoves] = useState<ReadonlyMap<string, Move>>(() => new Map());
    const [lift, setLift] = useState<Lift | undefined>(undefined);
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const [marquee, setMarquee] = useState<Box | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [board, setBoard] = useState<HTMLDivElement | null>(null);
    const fit = useFitToScreen(board, COLUMN_MIN);
    const [adding, setAdding] = useState<string | undefined>(undefined);
    const [pending, setPending] = useState<readonly { readonly key: string; readonly title: string; readonly id?: string; readonly token: number }[]>([]);
    const nextToken = useRef(0);
    const titleOf = (column: Column): string => columnTitle(column, settings.group);
    const fold = (column: Column, collapsed: boolean): void => {
      if (column.key === undefined) return;
      onOptionsChange(withKanban(withColumn(settings, column.key, { collapsed }), options));
    };

    const order = settings.order;
    const [chosen, setChosen] = useState<Filters>(() => new Map());
    const fields = filterFields(settings);
    const filters: Filters = new Map([...chosen].filter(([field]) => fields.includes(field)));
    const filter = (field: string, values: readonly Scalar[]): void =>
      setChosen((current) => {
        const next = new Map(current);
        if (values.length === 0) next.delete(field);
        else next.set(field, values);
        return next;
      });
    const rows = filterRows(withMoves(results.rows, settings, moves), filters);
    const kept = useRef<{ group: string; lanesBy: string; columns: KeptColumns; lanes: KeptColumns }>({
      group: settings.group,
      lanesBy: laneScope(settings.lanes, new Map()),
      columns: NO_KEPT,
      lanes: NO_KEPT,
    });
    if (kept.current.group !== settings.group) kept.current = { ...kept.current, group: settings.group, columns: NO_KEPT };
    const scope = laneScope(settings.lanes, filters);
    if (kept.current.lanesBy !== scope) kept.current = { ...kept.current, lanesBy: scope, lanes: NO_KEPT };
    const lanes = lanesFor(rows, settings, kept.current.columns, kept.current.lanes, filters.get(settings.lanes));
    const columns = lanes.flatMap((lane) => lane.columns);
    kept.current.columns = keepColumns(columns, kept.current.columns);
    kept.current.lanes = keepLanes(lanes, kept.current.lanes);
    const laned = settings.lanes !== "" && columns.length > 0;
    const placeOf = (column: Column): string =>
      laned && column.lane ? `${titleOf(column)} · ${laneTitle(column.lane, settings.lanes)}` : titleOf(column);
    const cellOf = (column: Column): string => JSON.stringify([column.lane?.key ?? null, column.key ?? null]);
    const selectedRows = ((): readonly DocumentRow[] => {
      const seen = new Set<string>();
      const out: DocumentRow[] = [];
      for (const column of columns) {
        for (const card of column.cards) {
          if (!selected.has(card.id) || seen.has(card.id)) continue;
          seen.add(card.id);
          out.push(card);
        }
      }
      return out;
    })();
    const liftIds = lift ? new Set(lift.ids) : undefined;
    const clearSelection = (): void => {
      selectedRef.current = new Set();
      setSelected(new Set());
    };
    const toggleSelected = (id: string): void =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        selectedRef.current = next;
        return next;
      });
    useEffect(() => {
      if (selected.size === 0 || lift !== undefined || marquee !== undefined) return undefined;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        clearSelection();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [selected.size, lift, marquee]);

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

    const sortFields = (): readonly { readonly field: string; readonly label: string }[] => {
      const keys = new Set<string>();
      for (const row of results.rows) for (const key of Object.keys(row.fm)) keys.add(key);
      for (const column of columns) if (column.def?.sort?.field.startsWith("fm.")) keys.add(column.def.sort.field.slice(3));
      const since = sinceField(settings.group);
      if (since) keys.delete(since.slice(3));
      return [
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

    useEffect(() => {
      if (!pending.some((card) => card.id !== undefined && results.rows.some((row) => row.id === card.id))) return;
      setPending((current) => current.filter((card) => card.id === undefined || !results.rows.some((row) => row.id === card.id)));
    }, [results.rows, pending]);

    const submit = (column: Column, title: string): void => {
      const token = nextToken.current++;
      const key = cellOf(column);
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

    const gapColumn = lift === undefined ? undefined : lift.over ?? lift.from;
    const gapSlot = lift === undefined ? undefined : lift.over === undefined ? lift.origin : lift.slot;
    const signature = `${columns.map((column) => `${column.lane?.key ?? ""}/${column.key ?? ""}:${column.cards.map((card) => card.id).join(",")}`).join("|")}#${lift?.ids.join(",") ?? ""}@${gapColumn ?? ""}:${gapSlot ?? ""}`;
    const flip = useFlip(board, signature);

    const moveAll = (rows: readonly DocumentRow[], column: Column, slot: number): void => {
      const moving = rows.filter((row) => movable(row, settings.group) && laneChange(row, column, settings.lanes) !== null);
      if (moving.length === 0) return;
      const ids = new Set(moving.map((row) => row.id));
      const here = (row: DocumentRow): boolean => column.cards.some((card) => card.id === row.id);
      const others = column.cards.filter((card) => !ids.has(card.id));
      const sorted = column.def?.sort !== undefined;
      const landing = [...others.slice(0, slot), ...moving, ...others.slice(slot)];
      const unchanged = landing.length === column.cards.length && landing.every((card, at) => card.id === column.cards[at]?.id);
      if (moving.every(here) && (!order || sorted || unchanged)) return;
      const ranks = !order || sorted ? new Map<string, number>() : planRanks(others, slot, moving.map((row) => row.id));
      const planned = new Map<string, Move>();
      for (const [id, rank] of ranks) planned.set(id, { rank });
      const now = new Date().toISOString();
      for (const row of moving) {
        if (here(row)) continue;
        const lane = laneChange(row, column, settings.lanes);
        const entering = !holds(row, settings.group, column.key);
        planned.set(row.id, {
          ...planned.get(row.id),
          ...(entering ? { group: { value: column.value }, since: now } : {}),
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
        kernel.log.error("could not move the cards", cause);
        setMoves((current) => {
          const next = new Map(current);
          for (const id of planned.keys()) next.delete(id);
          return next;
        });
        const what = moving.length === 1 ? `“${moving[0]?.title ?? ""}”` : `${moving.length} cards`;
        setError(`Could not move ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    };

    const handle = useRef<BoardHandle | undefined>(undefined);
    handle.current = {
      columns,
      titleOf: placeOf,
      rowOf: (id) => rows.find((row) => row.id === id),
      movable: (row) => movable(row, settings.group),
      reaches: (row, column) => laneChange(row, column, settings.lanes) !== null,
      move: moveAll,
      selected: selectedRows,
      documentActions: documentActions(),
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

    const latest = useRef({ columns, rows, order, moveAll, flip, lanesBy: settings.lanes });
    latest.current = { columns, rows, order, moveAll, flip, lanesBy: settings.lanes };
    const press = useRef<{ timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

    const hitAt = (x: number, y: number, id: string, ids: readonly string[]): { over: number | undefined; slot: number } => {
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-kanban-column]");
      const index = element?.dataset["kanbanColumn"];
      if (!element || index === undefined) return { over: undefined, slot: 0 };
      const column = latest.current.columns[Number(index)];
      const list = element.querySelector<HTMLElement>("[data-kanban-list]");
      if (!column) return { over: undefined, slot: 0 };
      const carrying = new Set(ids);
      const others = column.cards.filter((card) => !carrying.has(card.id));
      const carried = latest.current.rows.find((row) => row.id === id);
      if (carried && laneChange(carried, column, latest.current.lanesBy) === null) return { over: undefined, slot: 0 };
      if (column.def?.sort && carried) return { over: Number(index), slot: sortedSlot(others, carried, column.def.sort) };
      if (!list) return { over: Number(index), slot: others.length };
      if (!latest.current.order) {
        const rank = new Map(latest.current.rows.map((row, at) => [row.id, at]));
        const mine = rank.get(id) ?? Number.MAX_SAFE_INTEGER;
        const at = others.findIndex((card) => (rank.get(card.id) ?? 0) > mine);
        return { over: Number(index), slot: at === -1 ? others.length : at };
      }
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
      const group = selectedRef.current.has(row.id) && selectedRows.length > 1 ? selectedRows : [row];
      const ids = group.map((each) => each.id);
      if (group.length === 1 && selectedRef.current.size > 0) clearSelection();
      const carrying = new Set(ids);
      const block = (): number => {
        let total = 0;
        for (const id of ids) {
          const drawn = board?.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(id)}"]`);
          total += drawn ? drawn.getBoundingClientRect().height : box.height + CARD_GAP;
        }
        return total - CARD_GAP;
      };
      const origin = from.cards.slice(0, from.cards.indexOf(row)).filter((each) => !carrying.has(each.id)).length;
      let lifted = false;
      let point = start;
      let frame = 0;
      let tall = box.height;

      const place = (x: number, y: number): void => {
        point = { x, y };
        setLift({
          row,
          ids,
          block: tall,
          x,
          y,
          dx: start.x - box.left,
          dy: start.y - box.top,
          width: box.width,
          height: box.height,
          from: fromIndex,
          origin,
          ...hitAt(x, y, row.id, ids),
        });
      };
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
        tall = block();
        document.body.style.setProperty("user-select", "none");
        document.body.style.setProperty("cursor", "grabbing");
        window.getSelection()?.removeAllRanges();
        place(point.x, point.y);
        frame = requestAnimationFrame(scroll);
      };
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
        const swallow = (click: MouseEvent): void => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        const hit = landed ? hitAt(point.x, point.y, row.id, ids) : { over: undefined, slot: 0 };
        const into = hit.over === undefined ? undefined : latest.current.columns[hit.over];
        latest.current.flip.remember(
          row.id,
          new DOMRect(point.x - (start.x - box.left), point.y - (start.y - box.top), box.width, box.height),
        );
        setLift(undefined);
        if (into && Math.hypot(point.x - start.x, point.y - start.y) >= LONG_PRESS_SLOP) {
          const carried = ids.map((id) => latest.current.rows.find((each) => each.id === id)).filter((each): each is DocumentRow => each !== undefined);
          latest.current.moveAll(carried, into, hit.slot);
        }
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

    const clickCard = (row: DocumentRow, event: ReactMouseEvent<HTMLElement>): void => {
      if (modified(event)) toggleSelected(row.id);
      else onOpen(row.id);
    };

    const startMarquee = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || event.pointerType === "touch" || !board) return;
      const from = event.target as HTMLElement;
      if (from.closest("[data-card], button, input, select, textarea, a, label, [role='listbox']")) return;
      const container = from.closest<HTMLElement>("[data-kanban-list]") ?? board;
      const at = container.getBoundingClientRect();
      const anchor = { x: event.clientX - at.left + container.scrollLeft, y: event.clientY - at.top + container.scrollTop };
      const additive = modified(event);
      const base: ReadonlySet<string> = additive ? new Set(selectedRef.current) : new Set();
      const start = { x: event.clientX, y: event.clientY };
      let point = start;
      let drawing = false;
      let frame = 0;
      const area = board;

      const anchorNow = (): { x: number; y: number } => {
        const now = container.getBoundingClientRect();
        return { x: now.left - container.scrollLeft + anchor.x, y: now.top - container.scrollTop + anchor.y };
      };
      const sweep = (): void => {
        const a = anchorNow();
        const left = Math.min(a.x, point.x);
        const top = Math.min(a.y, point.y);
        const right = Math.max(a.x, point.x);
        const bottom = Math.max(a.y, point.y);
        setMarquee({ left, top, width: right - left, height: bottom - top });
        const next = new Set(selectedRef.current);
        for (const drawn of area.querySelectorAll<HTMLElement>("[data-card]")) {
          const id = drawn.dataset["flipId"];
          if (id === undefined) continue;
          const card = drawn.getBoundingClientRect();
          const list = drawn.closest("[data-kanban-list]")?.getBoundingClientRect();
          if (list && (card.bottom <= list.top || card.top >= list.bottom)) continue;
          const inside = card.left < right && card.right > left && card.top < bottom && card.bottom > top;
          if (inside) next.add(id);
          else if (!base.has(id)) next.delete(id);
        }
        const current = selectedRef.current;
        if (next.size !== current.size || [...next].some((id) => !current.has(id))) {
          selectedRef.current = next;
          setSelected(next);
        }
      };
      const scroll = (): void => {
        const bounds = area.getBoundingClientRect();
        if (point.x < bounds.left + EDGE) area.scrollLeft -= SPEED;
        else if (point.x > bounds.right - EDGE) area.scrollLeft += SPEED;
        if (laned) {
          if (point.y < bounds.top + EDGE) area.scrollTop -= SPEED;
          else if (point.y > bounds.bottom - EDGE) area.scrollTop += SPEED;
        }
        const y = Math.min(Math.max(point.y, bounds.top + 1), bounds.bottom - 1);
        const column = document.elementFromPoint(point.x, y)?.closest<HTMLElement>("[data-kanban-column]");
        const list = column?.querySelector<HTMLElement>("[data-kanban-list]") ?? (container === area ? undefined : container);
        const edge = list?.getBoundingClientRect();
        if (list && edge) {
          if (point.y < edge.top + EDGE) list.scrollTop -= SPEED;
          else if (point.y > edge.bottom - EDGE) list.scrollTop += SPEED;
        }
        sweep();
        frame = requestAnimationFrame(scroll);
      };
      const begin = (): void => {
        drawing = true;
        document.body.style.setProperty("user-select", "none");
        document.body.style.setProperty("cursor", "crosshair");
        window.getSelection()?.removeAllRanges();
        frame = requestAnimationFrame(scroll);
      };
      const onMove = (moveEvent: PointerEvent): void => {
        point = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!drawing && Math.hypot(point.x - start.x, point.y - start.y) >= DRAG_THRESHOLD) begin();
      };
      const finish = (): void => {
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("keydown", onKey, true);
        if (!drawing) {
          if (!additive) clearSelection();
          return;
        }
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        setMarquee(undefined);
        const swallow = (click: MouseEvent): void => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      };
      const onKey = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== "Escape" || !drawing) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        selectedRef.current = new Set(base);
        setSelected(new Set(base));
        finish();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("keydown", onKey, true);
    };

    const openSelection = (anchor: HTMLElement): void => {
      const menus = menu();
      const current = handle.current;
      if (!menus || !current) return;
      const items = selectionItems(current);
      menus.open({
        title: `${selectedRows.length} card${selectedRows.length === 1 ? "" : "s"}`,
        anchor,
        sections: [{ items: items.length > 0 ? items : [{ id: "none", label: "No actions available", disabled: true, run: () => undefined }] }],
      });
    };

    const renderColumn = (column: Column, index: number): ReactElement => {
      const hot = lift !== undefined && lift.over === index;
      const cards = liftIds ? column.cards.filter((card) => !liftIds.has(card.id)) : column.cards;
      const gapAt = gapColumn === index ? gapSlot : undefined;
      const color = column.def?.color;
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
          {adding === cellOf(column) && (
            <div className="kanban:shrink-0">
              <CardInput
                label={`New card in ${placeOf(column)}`}
                onSubmit={(title) => submit(column, title)}
                onClose={() => setAdding(undefined)}
              />
            </div>
          )}
          <ColumnList
            column={column}
            lift={lift}
            gapAt={gapAt}
            dress={dress}
            items={settings.card}
            group={settings.group}
            selected={selected}
            onPointerDown={(event, row) => startDrag(event, row, column, index)}
            onClick={clickCard}
          >
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
    const starts = lanes.map((_, at) => lanes.slice(0, at).reduce((sum, lane) => sum + lane.columns.length, 0));

    return (
      <div className="kanban-view kanban:flex kanban:min-w-0 kanban:flex-col kanban:gap-2 kanban:font-sans kanban:text-text">
        {error && (
          <p className="kanban:m-0 kanban:rounded kanban:border kanban:border-danger kanban:p-2 kanban:text-sm" role="alert">
            {error}
          </p>
        )}
        {(fields.length > 0 || selectedRows.length > 0) && (
          <div className="kanban:flex kanban:flex-wrap kanban:items-center kanban:gap-x-4 kanban:gap-y-1.5">
            {fields.length > 0 && (
              <FilterBar fields={fields} rows={results.rows} filters={filters} onFilter={filter} onClear={() => setChosen(new Map())} FmValueSelect={fmValueSelect} />
            )}
            {selectedRows.length > 0 && (
              <div className="kanban-selection kanban:flex kanban:items-center kanban:gap-1.5 kanban:text-xs" role="group" aria-label="Selected cards">
                <span className="kanban:inline-flex kanban:h-7 kanban:items-center kanban:rounded-full kanban:border kanban:border-accent kanban:bg-accent-subtle kanban:px-2.5 kanban:font-medium kanban:tabular-nums kanban:compact:h-9">
                  {selectedRows.length} selected
                </span>
                <button
                  type="button"
                  className="kanban:inline-flex kanban:h-7 kanban:min-h-0! kanban:items-center kanban:gap-1 kanban:rounded-full! kanban:border! kanban:border-border! kanban:bg-bg-raised! kanban:px-2.5! kanban:py-0! kanban:text-xs kanban:text-text kanban:shadow-1 kanban:transition-colors kanban:duration-150 kanban:hover:border-border-strong! kanban:compact:h-9"
                  aria-haspopup="menu"
                  onClick={(event) => openSelection(event.currentTarget)}
                >
                  Actions <span aria-hidden="true" className="kanban:text-[0.6rem] kanban:opacity-60">▾</span>
                </button>
                <button
                  type="button"
                  className="kanban:inline-flex kanban:h-7 kanban:min-h-0! kanban:items-center kanban:gap-1 kanban:rounded-full! kanban:border! kanban:border-transparent! kanban:bg-transparent! kanban:px-2! kanban:py-0! kanban:text-xs kanban:text-text-muted kanban:transition-colors kanban:duration-150 kanban:hover:border-border! kanban:hover:bg-bg-raised! kanban:hover:text-text kanban:compact:h-9"
                  onClick={clearSelection}
                >
                  <span aria-hidden="true">×</span> Clear
                </button>
              </div>
            )}
          </div>
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
          onPointerDown={startMarquee}
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
        {marquee && <Marquee box={marquee} />}
      </div>
    );
  };
}

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

function Gap({ height }: { readonly height: number }): ReactElement {
  return (
    <li
      aria-hidden="true"
      className="kanban:mb-1.5 kanban:shrink-0 kanban:rounded kanban:border kanban:border-dashed kanban:border-accent kanban:bg-bg/40"
      style={{ height }}
    />
  );
}

function CardBody({ row, items, look }: { readonly row: DocumentRow; readonly items: readonly CardItem[]; readonly look: NoteLook | undefined }): ReactElement {
  const lines = items
    .filter((item) => item.hidden !== true)
    .map((item) => {
      if (item.kind === "title") return <NoteLabel key="title" title={row.title} look={look} wrap />;
      if (item.kind === "content") {
        const body = row.content === undefined ? "" : bodyOf(row.content).trim();
        return body === "" ? null : <CardText key="content" id={row.id} body={body} />;
      }
      const parts = fieldParts(row, item.field);
      return parts.length === 0 ? null : (
        <span key={item.field} className="kanban:flex kanban:min-w-0 kanban:gap-1 kanban:text-xs">
          <span className="kanban:shrink-0 kanban:opacity-70">{item.field.slice("fm.".length)}</span>
          <span className="kanban:min-w-0 kanban:[overflow-wrap:anywhere]">
            {parts.map((part, index) => (
              <Fragment key={index}>
                {index > 0 ? ", " : null}
                {part.kind === "doc" ? (
                  <span className={CARD_LINK_CLASSES} onClick={keepControl} onPointerDown={keepControl}>
                    {renderDocLink(part.id)}
                  </span>
                ) : (
                  part.text
                )}
              </Fragment>
            ))}
          </span>
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

const CARD_TEXT_CLASSES =
  "kanban:min-w-0 kanban:w-full kanban:text-xs kanban:leading-snug kanban:opacity-90 kanban:[&_.md-root]:text-inherit kanban:[&_.md-root_blockquote]:text-inherit kanban:[&_.md-root_blockquote]:opacity-75 kanban:[&_.md-root_li.md-task-done]:text-inherit kanban:[&_.md-root_li.md-task-done]:opacity-60 kanban:[&_.md-root]:text-xs kanban:[&_.md-root]:leading-snug kanban:[&_.md-root>*+*]:mt-1 kanban:[&_.md-root_h1]:my-1 kanban:[&_.md-root_h1]:text-sm kanban:[&_.md-root_h1]:font-semibold kanban:[&_.md-root_h2]:my-1 kanban:[&_.md-root_h2]:text-sm kanban:[&_.md-root_h2]:font-semibold kanban:[&_.md-root_h3]:my-1 kanban:[&_.md-root_h3]:text-xs kanban:[&_.md-root_h3]:font-semibold kanban:[&_.md-root_h4]:my-1 kanban:[&_.md-root_h4]:text-xs kanban:[&_.md-root_h4]:font-semibold kanban:[&_.md-root_h5]:my-1 kanban:[&_.md-root_h5]:text-xs kanban:[&_.md-root_h5]:font-semibold kanban:[&_.md-root_h6]:my-1 kanban:[&_.md-root_h6]:text-xs kanban:[&_.md-root_h6]:font-semibold kanban:[&_.md-root_p]:my-0 kanban:[&_.md-root_ul]:my-0 kanban:[&_.md-root_ol]:my-0 kanban:[&_.md-root_blockquote]:my-0 kanban:[&_.md-root_blockquote]:border-l-2 kanban:[&_.md-root_blockquote]:pl-2 kanban:[&_.md-root_pre]:my-0 kanban:[&_.md-root_pre]:max-w-full kanban:[&_.md-root_pre]:overflow-x-auto kanban:[&_.md-root_pre]:rounded kanban:[&_.md-root_pre]:border kanban:[&_.md-root_pre]:border-border kanban:[&_.md-root_pre]:bg-bg-subtle kanban:[&_.md-root_pre]:p-1.5 kanban:[&_.md-root_code]:break-words kanban:[&_.md-root_code]:rounded-[3px] kanban:[&_.md-root_code]:bg-bg-subtle kanban:[&_.md-root_code]:px-[0.3em] kanban:[&_.md-root_code]:font-mono kanban:[&_.md-root_code]:text-[0.9em] kanban:[&_.md-root_pre_code]:bg-transparent kanban:[&_.md-root_pre_code]:p-0 kanban:[&_.md-root_img]:h-auto kanban:[&_.md-root_img]:max-w-full kanban:[&_.md-root_img]:rounded kanban:[&_.md-root_table]:my-0 kanban:[&_.md-root_table]:block kanban:[&_.md-root_table]:max-w-full kanban:[&_.md-root_table]:overflow-x-auto kanban:[&_.md-root_table]:border-collapse kanban:[&_.md-root_th]:border kanban:[&_.md-root_th]:border-border kanban:[&_.md-root_th]:px-1 kanban:[&_.md-root_th]:text-left kanban:[&_.md-root_td]:border kanban:[&_.md-root_td]:border-border kanban:[&_.md-root_td]:px-1 kanban:[&_.md-root_td]:text-left kanban:[&_.md-root_hr]:my-1";

const CARD_LINK_CLASSES =
  "kanban:inline-flex kanban:max-w-full kanban:align-baseline kanban:[&>a]:max-w-full kanban:[&>a[style*=background]]:shadow-[0_1px_2px_rgba(0,0,0,0.35)]";

const CONTROL = "a, button, input, select, textarea, label, [role='button'], [role='checkbox']";

function keepControl(event: SyntheticEvent<HTMLElement>): void {
  if ((event.target as Element).closest(CONTROL)) event.stopPropagation();
}

function CardText({ id, body }: { readonly id: string; readonly body: string }): ReactElement {
  const [revision, setRevision] = useState(0);
  useEffect(() => onMarkdownChange(() => setRevision((at) => at + 1)), []);
  const rendered = useMemo(() => renderMarkdown(body, { documentId: id }), [body, id, revision]);
  return (
    <span className={CARD_TEXT_CLASSES} onClick={keepControl} onPointerDown={keepControl}>
      {rendered}
    </span>
  );
}

function ColumnList({
  column,
  lift,
  gapAt,
  dress,
  items,
  group,
  selected,
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
  readonly selected: ReadonlySet<string>;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>, row: DocumentRow) => void;
  readonly onClick: (row: DocumentRow, event: ReactMouseEvent<HTMLElement>) => void;
  readonly children?: ReactNode;
}): ReactElement {
  const cards = column.cards;
  const virtual = useVirtualList({
    count: cards.length,
    keyOf: (at) => cards[at]?.id ?? String(at),
    estimate: CARD_ESTIMATE,
    clipToWindow: false,
  });
  const carrying = lift ? new Set(lift.ids) : undefined;
  const before: number[] = [];
  let seen = 0;
  for (const card of cards) {
    before.push(seen);
    if (carrying?.has(card.id)) seen += 1;
  }
  const others = cards.length - seen;
  return (
    <div data-kanban-list className="kanban:relative kanban:min-h-10 kanban:min-w-0 kanban:overflow-y-auto kanban:overscroll-y-contain">
      <ul ref={virtual.listRef} className="kanban:m-0 kanban:flex kanban:list-none kanban:flex-col kanban:p-0" style={{ paddingTop: virtual.before, paddingBottom: virtual.after }}>
        {cards.slice(virtual.first, virtual.end).map((row, offset) => {
          const at = virtual.first + offset;
          const carried = carrying?.has(row.id) === true;
          const slot = at - (before[at] ?? 0);
          return (
            <CardSlot
              key={row.id}
              index={at}
              slot={slot}
              row={row}
              look={lookOf(dress, row.id)}
              items={items}
              carried={carried}
              selected={selected.has(row.id)}
              gapBefore={!carried && gapAt === slot ? lift?.block : undefined}
              draggable={movable(row, group)}
              onPointerDown={(event) => onPointerDown(event, row)}
              onClick={(event) => onClick(row, event)}
            />
          );
        })}
        {gapAt === others && lift && virtual.end === cards.length && <Gap height={lift.block} />}
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
  selected,
  gapBefore,
  draggable,
  onPointerDown,
  onClick,
}: {
  readonly index: number;
  readonly slot: number;
  readonly row: DocumentRow;
  readonly look: NoteLook | undefined;
  readonly items: readonly CardItem[];
  readonly carried: boolean;
  readonly selected: boolean;
  readonly gapBefore: number | undefined;
  readonly draggable: boolean;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onClick: (event: ReactMouseEvent<HTMLElement>) => void;
}): ReactElement {
  return (
    <>
      {gapBefore !== undefined && <Gap height={gapBefore} />}
      <li
        data-virtual-index={index}
        {...(carried ? { hidden: true } : { "data-card": "", "data-slot": slot, "data-flip-id": row.id })}
        className="kanban:shrink-0 kanban:pb-1.5 kanban:transition-opacity kanban:duration-200 kanban:starting:opacity-0"
      >
        <div
          role="button"
          tabIndex={0}
          className={`kanban-card kanban:flex kanban:w-full kanban:min-w-0 kanban:touch-manipulation kanban:items-stretch kanban:rounded kanban:border kanban:px-2! kanban:py-1.5! kanban:text-left kanban:text-sm kanban:shadow-1 kanban:transition-[opacity,box-shadow] kanban:duration-150 kanban:focus-visible:outline-2 kanban:focus-visible:outline-focus ${look?.background ? "" : "kanban:bg-bg-raised!"} ${draggable ? "kanban:cursor-grab" : "kanban:cursor-pointer"} ${
            selected ? "kanban:border-accent kanban:ring-2 kanban:ring-accent kanban:ring-offset-1 kanban:ring-offset-bg-subtle" : "kanban:border-border"
          }`}
          style={lookStyle(look)}
          title={row.title}
          aria-label={row.title}
          data-selected={selected ? "" : undefined}
          onPointerDown={onPointerDown}
          onClick={onClick}
          onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
            if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            event.currentTarget.click();
          }}
          {...mark("ddd/document", row.id, { label: row.title, types: selected ? ["kanban/card", "kanban/selection"] : ["kanban/card"], pressOnRelease: true })}
          onDragStart={(event) => event.preventDefault()}
        >
          <CardBody row={row} items={items} look={look} />
        </div>
      </li>
    </>
  );
}

function Lifted({
  lift,
  look,
  items,
}: {
  readonly lift: Lift;
  readonly look: NoteLook | undefined;
  readonly items: readonly CardItem[];
}): ReactElement {
  const count = lift.ids.length;
  const left = lift.x - lift.dx;
  const top = lift.y - lift.dy;
  return createPortal(
    <>
      {count > 1 &&
        [2, 1].map((depth) => (
          <div
            key={depth}
            aria-hidden="true"
            className="kanban:pointer-events-none kanban:fixed kanban:z-[999] kanban:rounded kanban:border kanban:border-border kanban:bg-bg-raised kanban:shadow-1"
            style={{ left: left + depth * 4, top: top + depth * 5, width: lift.width, height: lift.height, transform: `rotate(${String(2 + depth * 2)}deg) scale(1.04)`, opacity: 1 - depth * 0.25 }}
          />
        ))}
      <div
        aria-hidden="true"
        className={`kanban-lifted kanban:pointer-events-none kanban:fixed kanban:z-[1000] kanban:flex kanban:items-stretch kanban:overflow-hidden kanban:rounded kanban:border kanban:border-border-strong kanban:px-2 kanban:py-1.5 kanban:font-sans kanban:text-sm kanban:text-text kanban:shadow-2 ${look?.background ? "" : "kanban:bg-bg-raised"}`}
        style={{
          left,
          top,
          width: lift.width,
          height: lift.height,
          transform: "rotate(2deg) scale(1.04)",
          ...lookStyle(look),
        }}
      >
        <CardBody row={lift.row} items={items} look={look} />
      </div>
      {count > 1 && (
        <span
          aria-hidden="true"
          className="kanban:pointer-events-none kanban:fixed kanban:z-[1001] kanban:flex kanban:h-6 kanban:min-w-6 kanban:items-center kanban:justify-center kanban:rounded-full kanban:bg-accent kanban:px-1.5 kanban:font-sans kanban:text-xs kanban:font-semibold kanban:text-accent-text kanban:shadow-2 kanban:tabular-nums"
          style={{ left: left + lift.width - 10, top: top - 10 }}
        >
          {count}
        </span>
      )}
    </>,
    document.body,
  );
}

function Marquee({ box }: { readonly box: Box }): ReactElement {
  return createPortal(
    <div
      aria-hidden="true"
      className="kanban-marquee kanban:pointer-events-none kanban:fixed kanban:z-[999] kanban:rounded-sm kanban:border kanban:border-accent kanban:bg-accent/15"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    />,
    document.body,
  );
}
