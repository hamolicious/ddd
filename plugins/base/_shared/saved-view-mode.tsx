/**
 * A view plugin's side of a saved search: its `document.mode`, its settings, and making a
 * new one. See `saved-view.ts` for how a note says which views show it.
 *
 * - **`savedViewMode`** is the mode: shown on saved searches whose `type` names the view,
 *   and the one they open in when it is the first. It draws `search`'s `SavedSearch` —
 *   the search's controls and "Update saved search" — around the plugin's own view.
 * - **`useSectionOptions`** is the view's settings, from the plugin's own `%%%` section.
 *   A change is written at once, one line per key; embedded, it stays on screen (the
 *   reader is reading another note, not editing this one).
 * - **`createSavedView`** makes a new saved search of this type: the note, its settings
 *   section, filed where it was asked for, then opened.
 */

import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { DocumentId, DocumentRow, Kernel } from "@kernel";
// Type-only: erased from the bundle, so these add no runtime dependency to the plugin that
// uses this helper. The functions that do run come in through `SavedViewHosts`.
import type { DocumentMode, DocumentModeProps } from "plugin:document-surface";
import type { Search, SearchField, SearchSpec, SearchViewProps } from "plugin:search";

import {
  applyEdits,
  childrenSpec,
  newUlid,
  opensAs,
  optionEdits,
  sameOptions,
  savedSearchNoteText,
  sectionOptions,
  showsAs,
  type ViewOptions,
} from "./saved-view.js";

/** What a view plugin's view is handed: the search's, and its own settings. */
export interface ViewOptionsProps {
  readonly options: ViewOptions;
  readonly onOptionsChange: (options: ViewOptions) => void;
}

export type SavedViewProps = SearchViewProps & ViewOptionsProps;

/** What a view's settings panel is handed. */
export interface ViewSettingsProps extends ViewOptionsProps {
  /** The workspace's fields, fixed ones first, then every property in use. */
  readonly fields: readonly SearchField[];
}

/**
 * The view's settings on `row`, and a setter. What was set shows at once and stays until
 * the note catches up, so nothing flickers back while the write lands.
 */
export function useSectionOptions(
  kernel: Kernel,
  row: DocumentRow,
  embedded: boolean,
): readonly [ViewOptions, (next: ViewOptions) => void] {
  const stored = sectionOptions(row, kernel.pluginId);
  const [pending, setPending] = useState<ViewOptions | undefined>(undefined);
  useEffect(() => {
    if (pending !== undefined && !embedded && sameOptions(pending, stored)) setPending(undefined);
  }, [pending, stored, embedded]);
  const options = pending ?? stored;
  const set = (next: ViewOptions): void => {
    setPending(next);
    if (embedded) return;
    const edits = optionEdits(stored, next);
    if (edits.length === 0) return;
    void kernel.documents.splice.spliceSection(row.id, edits).catch((cause: unknown) => {
      setPending(undefined);
      kernel.log.error("could not save the view's settings", cause);
      kernel.ui.notify({
        id: `${kernel.pluginId}.options-failed`,
        level: "error",
        message: `Could not save the view's settings: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    });
  };
  return [options, set];
}

export interface SavedViewModeOptions {
  readonly kernel: Kernel;
  /** The `search` plugin's exports, when it is active (an optional dependency). */
  readonly search: () => Pick<Search, "SavedSearch"> | undefined;
  /** The `type` value this view answers to. */
  readonly type: string;
  /** The mode's id; the type by default. */
  readonly id?: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly order?: number;
  readonly render: (props: SavedViewProps) => ReactNode;
  readonly settings?: (props: ViewSettingsProps) => ReactNode;
  readonly pageSize?: (options: ViewOptions) => number;
  readonly showsEmpty?: boolean;
}

/** The `document.mode` for saved searches of one type. */
export function savedViewMode(mode: SavedViewModeOptions): DocumentMode {
  const { kernel, search, type, render, settings } = mode;

  function SavedView({ row, embedded }: DocumentModeProps): ReactElement {
    const [options, setOptions] = useSectionOptions(kernel, row, embedded === true);
    const SavedSearch = search()?.SavedSearch;
    if (!SavedSearch) return <p>Showing this needs the Search plugin.</p>;
    const pageSize = mode.pageSize?.(options);
    return (
      <SavedSearch
        row={row}
        embedded={embedded === true}
        renderView={(props) => render({ ...props, options, onOptionsChange: setOptions })}
        {...(settings ? { renderSettings: (fields: readonly SearchField[]) => settings({ options, onOptionsChange: setOptions, fields }) } : {})}
        {...(pageSize !== undefined ? { pageSize } : {})}
        {...(mode.showsEmpty !== undefined ? { showsEmpty: mode.showsEmpty } : {})}
      />
    );
  }

  return {
    id: mode.id ?? type,
    label: mode.label,
    ...(mode.icon !== undefined ? { icon: mode.icon } : {}),
    ...(mode.order !== undefined ? { order: mode.order } : {}),
    component: SavedView,
    when: (row) => showsAs(row, type),
    prefer: (row) => opensAs(row, type),
  };
}

export interface NewSavedView {
  /** The note's id, when its search must name it (a search for its own children). */
  readonly id?: DocumentId;
  readonly type: string;
  readonly title: string;
  readonly spec: SearchSpec;
  readonly options?: ViewOptions;
  /** Where to file it: a note's id, `""` for the root; where new notes go when absent. */
  readonly parent?: string;
}

/** A new document, announced so the folder tree files it (`doc-events.notifyCreated`). */
export interface CreatedDocument {
  readonly id: DocumentId;
  readonly parent?: string;
}

/**
 * Make a saved search of the calling plugin's type, with its settings in the plugin's own
 * section, and announce it with `notifyCreated` (`doc-events`). Resolves to its id.
 */
export async function createSavedView(
  kernel: Kernel,
  search: Pick<Search, "encode">,
  view: NewSavedView,
  notifyCreated?: (created: CreatedDocument) => void,
): Promise<DocumentId> {
  const id = view.id ?? newUlid();
  let text = savedSearchNoteText(view.title, search.encode(view.spec), [view.type]);
  const edits = optionEdits({}, view.options ?? {});
  if (edits.length > 0) text = applyEdits(text, kernel.documents.splice.planSection(text, edits));
  await kernel.documents.create({ id, text });
  notifyCreated?.(view.parent !== undefined ? { id, parent: view.parent } : { id });
  return id;
}

export interface SavedViewPlugin extends Omit<SavedViewModeOptions, "kernel" | "search"> {
  /** What "New …" makes: "board" → "New board", "New board inside". */
  readonly noun: string;
  /** The command's id; `<plugin>.new` by default. */
  readonly commandId?: string;
  /** The command's icon, an `ddd/icons` name. */
  readonly commandIcon?: string;
  /** A new one's settings. */
  readonly starter?: ViewOptions;
  /** A new one's search, given its own id; the notes inside it by default. */
  readonly starterSpec?: (id: DocumentId) => SearchSpec;
}

/** A "New …" command, as `commands.addCommand` takes it. */
export interface SavedViewCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly icon?: string;
  readonly when: () => boolean;
  readonly run: () => void | Promise<void>;
}

/** A context-menu action, as `context-menu.addAction` takes it. */
export interface SavedViewAction {
  readonly id: string;
  readonly target: string;
  readonly order: number;
  readonly items: (target: { readonly id: string }) => readonly { readonly id: string; readonly label: string; run(): void }[];
}

/**
 * The host functions `offerSavedView` registers through, passed in by the plugin from its
 * own imports (`import { addMode } from "plugin:document-surface"`, …), so the plugin's
 * manifest — not this helper — says what it depends on. Method syntax on purpose: a host's
 * `add*` takes its own item type, of which these are the fields this helper fills in.
 */
export interface SavedViewHosts {
  /** `document-surface.addMode`. */
  addMode(mode: DocumentMode): unknown;
  /** `commands.addCommand`. */
  addCommand(command: SavedViewCommand): unknown;
  /** `context-menu.addAction`, called once per action. */
  addAction(action: SavedViewAction): unknown;
  /** `doc-events.notifyCreated`. */
  notifyCreated(created: CreatedDocument): void;
  /** The `search` plugin's exports when it is active (usually an optional dependency). */
  search(): Pick<Search, "SavedSearch" | "encode"> | undefined;
  /** `router.navigate`, when there is a router. */
  navigate?(path: string): void;
}

/**
 * Everything a view plugin adds for its type: the mode, a "New …" command, and "New …
 * inside" in a note's menu and "New … at the root" in the folder tree's.
 * A new one is a saved search for the notes inside itself, filed where it was asked for
 * (announced with `notifyCreated`) and opened.
 */
export function offerSavedView(kernel: Kernel, plugin: SavedViewPlugin, hosts: SavedViewHosts): void {
  const search = (): Pick<Search, "SavedSearch" | "encode"> | undefined => hosts.search();

  hosts.addMode(savedViewMode({ ...plugin, kernel, search }));

  const title = `New ${plugin.noun}`;
  const make = async (parent?: string): Promise<void> => {
    const searches = search();
    if (!searches) throw new Error(`a ${plugin.noun} needs the Search plugin`);
    const id = newUlid();
    await createSavedView(
      kernel,
      searches,
      {
        id,
        type: plugin.type,
        title,
        spec: (plugin.starterSpec ?? childrenSpec)(id),
        ...(plugin.starter !== undefined ? { options: plugin.starter } : {}),
        ...(parent !== undefined ? { parent } : {}),
      },
      (created) => hosts.notifyCreated(created),
    );
    hosts.navigate?.(`/doc/${encodeURIComponent(id)}`);
  };
  const failed = (cause: unknown): void => {
    kernel.log.error(`could not make the ${plugin.noun}`, cause);
    kernel.ui.notify({
      id: `${kernel.pluginId}.new-failed`,
      level: "error",
      message: `Could not make the ${plugin.noun}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  };

  hosts.addCommand({
    id: plugin.commandId ?? `${kernel.pluginId}.new`,
    title,
    category: "Documents",
    ...(plugin.commandIcon !== undefined ? { icon: plugin.commandIcon } : {}),
    when: () => hosts.search() !== undefined,
    run: () => make().catch(failed),
  });
  // Actions for a note, and for the folder tree's root.
  const actions: readonly SavedViewAction[] = [
    {
      id: `${kernel.pluginId}.new-inside`,
      target: "ddd/document",
      order: 20,
      items: (target: { readonly id: string }) => [
        { id: "new", label: `${title} inside`, run: () => void make(target.id).catch(failed) },
      ],
    },
    {
      id: `${kernel.pluginId}.new-at-root`,
      target: "folders/root",
      order: 20,
      items: () => [{ id: "new", label: `${title} at the root`, run: () => void make("").catch(failed) }],
    },
  ];
  for (const action of actions) hosts.addAction(action);
}
