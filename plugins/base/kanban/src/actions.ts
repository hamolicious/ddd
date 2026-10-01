/**
 * The board's entries in the menus of what is on it (`context-menu`'s `addAction`).
 *
 * A board marks itself `kanban/board`, each column `kanban/column` (its id is its index)
 * and each card `ddd/document` + `kanban/card` — and `kanban/selection` while it is one of
 * the cards selected on the board. The actions are offered once, in `activate`, but act on
 * a board on screen: each board registers what it can do under its element, and an action
 * finds the board around what was right-clicked.
 *
 * **A selection's menu fans out** (`selectionItems`): "Move to" moves every selected card
 * as a block, and every command that takes documents (`plugin:commands`, `takes:
 * "documents"` — Move to Trash, Move to folder…) runs once with all their ids. A selected
 * card's own "Move to" steps aside for the selection's.
 */

import type { ReactNode } from "react";

import type { DocumentRow } from "@kernel";
import type { ContextAction, MenuItem, Target } from "plugin:context-menu";

import type { Column } from "./layout.js";

/** What a board on screen can do, as of its last render. */
export interface BoardHandle {
  readonly columns: readonly Column[];
  readonly titleOf: (column: Column) => string;
  /** The card's row, or `undefined` when it is not on this board. */
  readonly rowOf: (id: string) => DocumentRow | undefined;
  readonly movable: (row: DocumentRow) => boolean;
  /** Whether the card can go into this column: not into another swimlane when it cannot leave its own. */
  readonly reaches: (row: DocumentRow, column: Column) => boolean;
  /** Put these cards into `column` at `slot`, as a block in this order. */
  readonly move: (rows: readonly DocumentRow[], column: Column, slot: number) => void;
  /** The cards selected on the board, in the board's order. */
  readonly selected: readonly DocumentRow[];
  /** The commands that take documents, to run on a selection. */
  readonly documentActions: readonly DocumentAction[];
  readonly fold: (column: Column, collapsed: boolean) => void;
  readonly add: (column: Column) => void;
  /** Present while the board's search is open for editing. */
  readonly sort?: (column: Column, anchor: HTMLElement) => void;
  readonly edit?: (column: Column, anchor: HTMLElement) => void;
}

/** A command that takes documents (`plugin:commands`), as the selection's menu runs it. */
export interface DocumentAction {
  readonly id: string;
  readonly title: string;
  readonly icon?: ReactNode;
  readonly run: (ids: readonly string[]) => void;
}

/** Boards on screen, by their element; each keeps its latest handle in the ref. */
export const boards = new WeakMap<HTMLElement, { readonly current: BoardHandle }>();

const boardOf = (chain: readonly Target[]): BoardHandle | undefined => {
  const element = chain.find((each) => each.type === "kanban/board")?.element;
  return element ? boards.get(element)?.current : undefined;
};

/** "Move to" for these cards: every column some of them are not in, that they all can reach. */
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

/** The menu of a board's selection: "Move to" as a block, then every command that takes documents, run with all of them. */
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
    // After a note's own entries, before Delete.
    order: 60,
    items: (target, chain): MenuItem[] => {
      const board = boardOf(chain);
      const row = board?.rowOf(target.id);
      if (!board || !row) return [];
      // One of several selected: the selection's entries speak for it.
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
