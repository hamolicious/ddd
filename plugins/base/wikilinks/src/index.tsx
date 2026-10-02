import type { Kernel } from "@kernel";
import { addExtension, onSurfacesChange } from "plugin:editor";
import { documents, subscribe } from "plugin:indexer";
import { addOverlay } from "plugin:shell-ui";

import { createController, type MenuController, type NoteIndex } from "./controller.js";
import { titleExtension } from "./decorate.js";
import { NoteMenu } from "./Menu.js";

type RouterModule = typeof import("plugin:router");

let liveController: MenuController | undefined;

export default async function activate(kernel: Kernel): Promise<void> {
  const index: NoteIndex = { documents, subscribe };
  const controller = createController(kernel, index, onSurfacesChange);
  liveController = controller;
  addOverlay({
    id: "wikilinks.menu",
    component: () => <NoteMenu controller={controller} />,
  });

  const router = await kernel.plugins.optional<RouterModule>("router").catch((cause: unknown) => {
    kernel.log.warn("router unavailable; titles do not open their note", cause);
    return undefined;
  });
  const open = router ? (id: string): void => router.navigate(router.documentPath(id)) : undefined;
  addExtension({
    id: "wikilinks.titles",
    extension: titleExtension(index, open),
  });
}

export function deactivate(): void {
  liveController?.dispose();
  liveController = undefined;
}
