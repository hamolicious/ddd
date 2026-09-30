/**
 * `fm-autocomplete` — while a document's frontmatter is being typed, suggests the keys in
 * use across the workspace, and then the values the typed key already has.
 *
 * - `suggest.ts` — what to offer for the text before the caret. Pure.
 * - `controller.ts` — watches every text surface, takes ↑ ↓ Enter Tab Escape while open.
 * - `Menu.tsx` — the dropdown at the caret, in `shell-ui`'s overlay spot.
 *
 * What it knows comes from `plugin:indexer`. Where it works comes from `plugin:editor`'s
 * text surfaces: with none mounted there is no menu, and nothing else is lost. A surface
 * also has to offer `documentBeforeCaret` and `replaceBeforeCaret`; `editor` and
 * `alt-editor` do.
 */

import type { Kernel } from "@kernel";
import { onSurfacesChange } from "plugin:editor";
import { documents, fmFields, fmValues, subscribe } from "plugin:indexer";
import { addOverlay } from "plugin:shell-ui";

import { createController, type MenuController } from "./controller.js";
import { SuggestionMenu } from "./Menu.js";

/** The controller of the running activation, for `deactivate` to detach. */
let liveController: MenuController | undefined;

export default function activate(kernel: Kernel): void {
  const controller = createController(kernel, { fmFields, fmValues, documents, subscribe }, onSurfacesChange);
  liveController = controller;
  addOverlay({
    id: "fm-autocomplete.menu",
    component: () => <SuggestionMenu controller={controller} />,
  });
}

/** What the kernel does not withdraw: the key listeners on each surface's element. */
export function deactivate(): void {
  liveController?.dispose();
  liveController = undefined;
}
