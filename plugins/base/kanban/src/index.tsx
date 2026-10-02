import type { Kernel } from "@kernel";
import { addCommand, list as listCommands, run as runCommand } from "plugin:commands";
import { notifyCreated } from "plugin:doc-events";
import { addMode } from "plugin:document-surface";
import { FmValueSelect, SavedSearch, encode } from "plugin:search";
import type { SearchSpec } from "plugin:search";

import type { Looks } from "../../_shared/note-look.js";
import { offerSavedView, type SavedViewAction } from "../../_shared/saved-view-mode.js";

import { BOARD_ACTIONS, type DocumentAction } from "./actions.js";
import { createBoard } from "./Board.js";
import { BOARD_OPTIONS, CARD_TITLE, cardFields, noteText } from "./create.js";
import { RANK_KEY, appendRanks, bornWith, sinceField, type Column, type Filters, type KanbanOptions } from "./layout.js";
import { KanbanSettings } from "./Settings.js";

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
  void optional<FoldersModule>("folders", (module) => (folders = module), "cards show without their look");
  const actions: SavedViewAction[] = [];
  void optional<MenuModule>(
    "context-menu",
    (module) => {
      menus = module;
      module?.addAction([...actions, ...BOARD_ACTIONS]);
    },
    "the board has no menus",
  );
  const looks = (): Looks | undefined => folders;
  const menu = (): MenuModule | undefined => menus;

  const addCard = async (
    spec: SearchSpec,
    settings: KanbanOptions,
    column: Column,
    title: string,
    queued: number,
    filters: Filters,
  ): Promise<string> => {
    const NEW = "\u0000new";
    const ranks = settings.order ? appendRanks(column.cards, queued, NEW) : new Map<string, number>();
    const fields = cardFields(spec, { field: settings.group, value: column.value }, column.lane && { field: settings.lanes, value: column.lane.value });
    const since = sinceField(settings.group);
    const fm = { ...bornWith(filters), ...fields.fm, ...(since ? { [since.slice(3)]: new Date().toISOString() } : {}) };
    const id = await kernel.documents.create({ text: noteText(title.trim() || CARD_TITLE, fm) });
    const rank = ranks.get(NEW);
    if (rank !== undefined) await kernel.documents.splice.spliceSection(id, [{ key: RANK_KEY, value: rank }]);
    await Promise.all(
      [...ranks].filter(([card]) => card !== NEW).map(([card, value]) => kernel.documents.splice.spliceSection(card, [{ key: RANK_KEY, value }])),
    );
    if (fields.parent !== undefined && folders) await folders.file(id, fields.parent);
    else notifyCreated({ id });
    return id;
  };

  const documentActions = (): readonly DocumentAction[] =>
    listCommands()
      .filter((command) => command.takes === "documents" && (command.when?.() ?? true))
      .map((command) => ({
        id: command.id,
        title: command.title,
        run: (ids) => {
          runCommand(command.id, ids).catch((cause: unknown) => {
            kernel.log.error(`command "${command.id}" failed`, cause);
            kernel.ui.notify({
              id: "kanban.action-failed",
              level: "error",
              message: `${command.title} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            });
          });
        },
      }));

  const Board = createBoard({ kernel, looks, menu, addCard, fmValueSelect: FmValueSelect, documentActions });
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
      showsEmpty: true,
      starter: BOARD_OPTIONS,
    },
    {
      addMode,
      addCommand: (command) =>
        addCommand({
          ...command,
          run: async () => {
            await command.run();
          },
        }),
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
