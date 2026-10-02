import type { Kernel } from "@kernel";
import { onSurfacesChange } from "plugin:editor";
import { documents, fmFields, fmValues, subscribe } from "plugin:indexer";
import { addOverlay } from "plugin:shell-ui";

import { createController, type MenuController } from "./controller.js";
import { SuggestionMenu } from "./Menu.js";

let liveController: MenuController | undefined;

export default function activate(kernel: Kernel): void {
  const controller = createController(kernel, { fmFields, fmValues, documents, subscribe }, onSurfacesChange);
  liveController = controller;
  addOverlay({
    id: "fm-autocomplete.menu",
    component: () => <SuggestionMenu controller={controller} />,
  });
}

export function deactivate(): void {
  liveController?.dispose();
  liveController = undefined;
}
