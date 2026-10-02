import type { ReactElement } from "react";

import type { Kernel } from "@kernel";
import { addCommand } from "plugin:commands";
import { addAction, openFor } from "plugin:context-menu";
import { notifyCreated } from "plugin:doc-events";
import { addMode } from "plugin:document-surface";
import { SavedSearch, SearchShell, encode } from "plugin:search";
import type { SearchSpec } from "plugin:search";

import { createSavedView, offerSavedView } from "../../_shared/saved-view-mode.js";
import { savedSearchTitle } from "../../_shared/saved-view.js";

import type { SaveTableOptions, TablePageProps } from "./api.js";
import { tableFromOptions } from "./columns.js";
import { TableSettingsPanel } from "./Settings.js";
import { TABLE_ICON, TableView } from "./TableView.js";

export type { SaveTableOptions, Table, TablePageProps } from "./api.js";

type RouterModule = typeof import("plugin:router");

let kernelRef: Kernel | undefined;
let router: RouterModule | undefined;

const openMenu = (element: HTMLElement): void => {
  openFor(element);
};

export function TablePage({ options, onOptionsChange, ...shell }: TablePageProps): ReactElement {
  return (
    <SearchShell
      {...shell}
      renderView={(props) => <TableView {...props} options={options} onOptionsChange={onOptionsChange} openMenu={openMenu} />}
      renderSettings={(fields) => <TableSettingsPanel options={options} onOptionsChange={onOptionsChange} fields={fields} />}
      pageSize={tableFromOptions(options).rows}
    />
  );
}

export async function save(
  spec: SearchSpec,
  options: Readonly<Record<string, string>>,
  saveOptions?: SaveTableOptions,
): Promise<string> {
  const kernel = kernelRef;
  if (!kernel) throw new Error("table is not active yet: call save from your plugin's activate() or later");
  const id = await createSavedView(
    kernel,
    { encode },
    {
      type: "table",
      title: saveOptions?.title ?? savedSearchTitle(spec.query),
      spec,
      options,
      ...(saveOptions?.parent !== undefined ? { parent: saveOptions.parent } : {}),
    },
    notifyCreated,
  );
  router?.navigate(`/doc/${encodeURIComponent(id)}`);
  return id;
}

export default function activate(kernel: Kernel): void {
  kernelRef = kernel;
  void kernel.plugins
    .optional<RouterModule>("router")
    .then((module) => {
      router = module;
    })
    .catch((cause: unknown) => kernel.log.warn("router unavailable; a new table is not opened", cause));

  offerSavedView(
    kernel,
    {
      type: "table",
      label: "Table",
      noun: "table",
      commandIcon: "table",
      icon: TABLE_ICON,
      order: 20,
      render: (props) => <TableView {...props} openMenu={openMenu} />,
      settings: (props) => <TableSettingsPanel {...props} />,
      pageSize: (options) => tableFromOptions(options).rows,
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
      addAction,
      notifyCreated,
      search: () => ({ SavedSearch, encode }),
      navigate: (path) => router?.navigate(path),
    },
  );
}

export function deactivate(): void {
  kernelRef = undefined;
}
