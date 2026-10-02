import type { ReactNode } from "react";

import type { DocumentRow } from "@kernel";
import type { ContextAction, MenuItem, Target } from "plugin:context-menu";

import type { Column } from "./layout.js";

export interface BoardHandle {
  readonly columns: readonly Column[];
  readonly titleOf: (column: Column) => string;
  readonly rowOf: (id: string) => DocumentRow | undefined;
  readonly movable: (row: DocumentRow) => boolean;
  readonly reaches: (row: DocumentRow, column: Column) => boolean;
  readonly move: (rows: readonly DocumentRow[], column: Column, slot: number) => void;
  readonly selected: readonly DocumentRow[];
  readonly documentActions: readonly DocumentAction[];
  readonly fold: (column: Column, collapsed: boolean) => void;
  readonly add: (column: Column) => void;
  readonly sort?: (column: Column, anchor: HTMLElement) => void;
  readonly edit?: (column: Column, anchor: HTMLElement) => void;
}

export interface DocumentAction {
  readonly id: string;
  readonly title: string;
  readonly icon?: ReactNode;
  readonly run: (ids: readonly string[]) => void;
}

export const boards = new WeakMap<HTMLElement, { readonly current: BoardHandle }>();

const boardOf = (chain: readonly Target[]): BoardHandle | undefined => {
  const element = chain.find((each) => each.type === "kanban/board")?.element;
  return element ? boards.get(element)?.current : undefined;
};

function moveItems(board: BoardHandle, rows: readonly DocumentRow[]): MenuItem[] {
  const movable = rows.filter((row) => board.movable(row));
  if (movable.length === 0) return [];
  const count = movable.length;
  return board.columns
    .filter((column) => movable.some((row) => !column.cards.some((card) => card.id === row.id)) && movable.every((row) => board.reaches(row, column)))
    .map((column, index) => ({
      id: `move-${index}`,
      label: `Move to ${board.titleOf(column)}`,
      ...(count > 1 ? { hint: `${count} cards` } : {}),
      run: () => board.move(movable, column, column.cards.length),
    }));
}

export function selectionItems(board: BoardHandle): MenuItem[] {
  const rows = board.selected;
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const count = `${rows.length} card${rows.length === 1 ? "" : "s"}`;
  return [
    ...moveItems(board, rows),
    ...board.documentActions.map((action) => ({
      id: `command-${action.id}`,
      label: action.title,
      hint: count,
      ...(action.icon !== undefined ? { icon: action.icon } : {}),
      run: () => action.run(ids),
    })),
  ];
}

export const BOARD_ACTIONS: readonly ContextAction[] = [
  {
    id: "kanban.card",
    target: "kanban/card",
    order: 60,
    items: (target, chain): MenuItem[] => {
      const board = boardOf(chain);
      const row = board?.rowOf(target.id);
      if (!board || !row) return [];
      if (board.selected.length > 1 && board.selected.some((card) => card.id === row.id)) return [];
      return moveItems(board, [row]);
    },
  },
  {
    id: "kanban.selection",
    target: "kanban/selection",
    order: 55,
    items: (_target, chain): MenuItem[] => {
      const board = boardOf(chain);
      return board && board.selected.length > 1 ? selectionItems(board) : [];
    },
  },
  {
    id: "kanban.column",
    target: "kanban/column",
    items: (target, chain): MenuItem[] => {
      const board = boardOf(chain);
      const column = board?.columns[Number(target.id)];
      if (!board || !column) return [];
      const { sort, edit } = board;
      const named = column.key !== undefined;
      return [
        ...(column.def?.collapsed === true ? [] : [{ id: "add", label: "Add a card", run: () => board.add(column) }]),
        ...(named && sort ? [{ id: "sort", label: "Sort…", run: () => sort(column, target.element) }] : []),
        ...(named && edit ? [{ id: "edit", label: "Column settings…", run: () => edit(column, target.element) }] : []),
        ...(named
          ? [
              column.def?.collapsed === true
                ? { id: "unfold", label: "Unfold", run: () => board.fold(column, false) }
                : { id: "fold", label: "Fold", run: () => board.fold(column, true) },
            ]
          : []),
      ];
    },
  },
];
