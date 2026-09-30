/**
 * The board's entries in the menus of what is on it (`context-menu`'s `addAction`).
 *
 * A board marks itself `kanban/board`, each column `kanban/column` (its id is its index)
 * and each card `lm/document` + `kanban/card`. The actions are offered once, in `activate`,
 * but act on a board on screen: each board registers what it can do under its element, and
 * an action finds the board around what was right-clicked.
 */

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
  readonly move: (row: DocumentRow, column: Column, slot: number) => void;
  readonly fold: (column: Column, collapsed: boolean) => void;
  readonly add: (column: Column) => void;
  /** Present while the board's search is open for editing. */
  readonly sort?: (column: Column, anchor: HTMLElement) => void;
  readonly edit?: (column: Column, anchor: HTMLElement) => void;
}

/** Boards on screen, by their element; each keeps its latest handle in the ref. */
export const boards = new WeakMap<HTMLElement, { readonly current: BoardHandle }>();

const boardOf = (chain: readonly Target[]): BoardHandle | undefined => {
  const element = chain.find((each) => each.type === "kanban/board")?.element;
  return element ? boards.get(element)?.current : undefined;
};

export const BOARD_ACTIONS: readonly ContextAction[] = [
  {
    id: "kanban.card",
    target: "kanban/card",
    // After a note's own entries, before Delete.
    order: 60,
    items: (target, chain): MenuItem[] => {
      const board = boardOf(chain);
      const row = board?.rowOf(target.id);
      if (!board || !row || !board.movable(row)) return [];
      return board.columns
        .filter((column) => !column.cards.some((card) => card.id === row.id))
        .map((column, index) => ({
          id: `move-${index}`,
          label: `Move to ${board.titleOf(column)}`,
          run: () => board.move(row, column, column.cards.length),
        }));
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
