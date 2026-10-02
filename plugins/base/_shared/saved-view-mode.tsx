import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { DocumentId, DocumentRow, Kernel } from "@kernel";
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

export interface ViewOptionsProps {
  readonly options: ViewOptions;
  readonly onOptionsChange: (options: ViewOptions) => void;
}

export type SavedViewProps = SearchViewProps & ViewOptionsProps;

export interface ViewSettingsProps extends ViewOptionsProps {
  readonly fields: readonly SearchField[];
}

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
  readonly search: () => Pick<Search, "SavedSearch"> | undefined;
  readonly type: string;
  readonly id?: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly order?: number;
  readonly render: (props: SavedViewProps) => ReactNode;
  readonly settings?: (props: ViewSettingsProps) => ReactNode;
  readonly pageSize?: (options: ViewOptions) => number;
  readonly showsEmpty?: boolean;
}

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
  readonly id?: DocumentId;
  readonly type: string;
  readonly title: string;
  readonly spec: SearchSpec;
  readonly options?: ViewOptions;
  readonly parent?: string;
}

export interface CreatedDocument {
  readonly id: DocumentId;
  readonly parent?: string;
}

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
  readonly noun: string;
  readonly commandId?: string;
  readonly commandIcon?: string;
  readonly starter?: ViewOptions;
  readonly starterSpec?: (id: DocumentId) => SearchSpec;
}

export interface SavedViewCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly icon?: string;
  readonly when: () => boolean;
  readonly run: () => void | Promise<void>;
}

export interface SavedViewAction {
  readonly id: string;
  readonly target: string;
  readonly order: number;
  readonly items: (target: { readonly id: string }) => readonly { readonly id: string; readonly label: string; run(): void }[];
}

export interface SavedViewHosts {
  addMode(mode: DocumentMode): unknown;
  addCommand(command: SavedViewCommand): unknown;
  addAction(action: SavedViewAction): unknown;
  notifyCreated(created: CreatedDocument): void;
  search(): Pick<Search, "SavedSearch" | "encode"> | undefined;
  navigate?(path: string): void;
}

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
