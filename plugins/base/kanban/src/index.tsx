/**
 * `kanban` — a saved search as a board, for the saved searches whose `type` is `kanban`.
 *
 * The columns are the values of a field (`fm.status` by default), in the order the
 * settings name and then the rest (`layout.ts`); the settings live in the note's own
 * `%%% kanban` section. Moving a card between columns sets that field on the note
 * (`Board.tsx`). Cards wear their `folders` colour and icon, and their menu comes from
 * `context-menu` — both optional dependencies; without `context-menu` the board has no
 * menus and "New board inside" is only a command.
 *
 * **"New board"** (a command, and "New board inside" in the folder tree) makes a board to
 * fill: one note, a saved search for the notes inside itself — the board is the note, its
 * tickets its children. Each column's **+** asks for a title and makes a ticket with it,
 * already in that column, filed where the board looks, at the bottom — without leaving
 * the board.
 *
 * No exports: it only contributes a document mode, a command and menu actions.
 */

import type { Kernel } from "@kernel";
import { addCommand } from "plugin:commands";
import { notifyCreated } from "plugin:doc-events";
import { addMode } from "plugin:document-surface";
import { SavedSearch, encode } from "plugin:search";
import type { SearchSpec } from "plugin:search";

import type { Looks } from "../../_shared/note-look.js";
import { offerSavedView, type SavedViewAction } from "../../_shared/saved-view-mode.js";

import { BOARD_ACTIONS } from "./actions.js";
import { createBoard } from "./Board.js";
import { BOARD_OPTIONS, CARD_TITLE, cardFields, noteText } from "./create.js";
import { RANK_KEY, RANK_STEP, bornWith, rankOf, sinceField, type Column, type Filters, type KanbanOptions } from "./layout.js";
import { KanbanSettings } from "./Settings.js";

/** Cards loaded at a time: a board shows every column at once, so a large page. */
const PAGE = 200;

type RouterModule = typeof import("plugin:router");
type FoldersModule = typeof import("plugin:folders");
type MenuModule = typeof import("plugin:context-menu");

let router: RouterModule | undefined;
let folders: FoldersModule | undefined;
let menus: MenuModule | undefined;

export default function activate(kernel: Kernel): void {
  const optional = <M,>(id: string, then: (module: M | undefined) => void, without: string): Promise<void> =>
    kernel.plugins
      .optional<M>(id)
      .then(then)
      .catch((cause: unknown) => kernel.log.warn(`${id} unavailable; ${without}`, cause));
  void optional<RouterModule>("router", (module) => (router = module), "a new board is not opened");
  // Colours and icons, as the folder tree dresses each note; plain cards without `folders`.
  void optional<FoldersModule>("folders", (module) => (folders = module), "cards show without their look");
  // The menu actions wait for `context-menu`; without it the board has no menus.
  const actions: SavedViewAction[] = [];
  void optional<MenuModule>(
    "context-menu",
    (module) => {
      menus = module;
      // "Move to" on a card, a column's settings and sort on the column (`actions.ts`).
      module?.addAction([...actions, ...BOARD_ACTIONS]);
    },
    "the board has no menus",
  );
  const looks = (): Looks | undefined => folders;
  const menu = (): MenuModule | undefined => menus;

  /**
   * A card titled `title` in `column` (and its swimlane), at its bottom, with what the
   * board's search asks of every card and what the board is filtered to. Resolves to its id; the board stays on
   * screen.
   */
  const addCard = async (
    spec: SearchSpec,
    settings: KanbanOptions,
    column: Column,
    title: string,
    queued: number,
    filters: Filters,
  ): Promise<string> => {
    const ranks = column.cards.map(rankOf).filter((rank): rank is number => rank !== undefined);
    // Below the column's last card, and below any added just before this one.
    const rank = settings.order ? (ranks.length > 0 ? Math.max(...ranks) : 0) + RANK_STEP * (1 + queued) : undefined;
    // In a swimlane, the lane's value too.
    const fields = cardFields(spec, { field: settings.group, value: column.value }, column.lane && { field: settings.lanes, value: column.lane.value });
    // Born in the column: it entered it now. The filter's values first: what the search
    // asks of every card, and the column, win over them.
    const since = sinceField(settings.group);
    const fm = { ...bornWith(filters), ...fields.fm, ...(since ? { [since.slice(3)]: new Date().toISOString() } : {}) };
    const id = await kernel.documents.create({ text: noteText(title.trim() || CARD_TITLE, fm) });
    // Its place in the column is this plugin's bookkeeping: in its `%%% kanban` section.
    if (rank !== undefined) await kernel.documents.splice.spliceSection(id, [{ key: RANK_KEY, value: rank }]);
    if (fields.parent !== undefined && folders) await folders.file(id, fields.parent);
    else notifyCreated({ id });
    return id;
  };

  const Board = createBoard({ kernel, looks, menu, addCard });
  offerSavedView(
    kernel,
    {
      type: "kanban",
      label: "Board",
      noun: "board",
      commandId: "kanban.newBoard",
      commandIcon: "layout-kanban",
      icon: (
        <svg aria-hidden="true" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="5" height="14" rx="1" />
          <rect x="10" y="4" width="5" height="9" rx="1" />
          <rect x="17" y="4" width="4" height="11" rx="1" />
        </svg>
      ),
      order: 15,
      render: (props) => <Board {...props} />,
      settings: (props) => <KanbanSettings {...props} />,
      pageSize: () => PAGE,
      // The columns are the board: shown with no cards in them.
      showsEmpty: true,
      starter: BOARD_OPTIONS,
    },
    {
      addMode,
      // `SavedViewCommand.run` returns `unknown`; a command's returns `void | Promise<void>`.
      addCommand: (command) =>
        addCommand({
          ...command,
          run: async () => {
            await command.run();
          },
        }),
      // Held until `context-menu` is known (above).
      addAction: (action) => {
        if (menus) menus.addAction(action);
        else actions.push(action);
      },
      notifyCreated,
      search: () => ({ SavedSearch, encode }),
      navigate: (path) => router?.navigate(path),
    },
  );
}

export function deactivate(): void {
  router = undefined;
  folders = undefined;
  menus = undefined;
}
