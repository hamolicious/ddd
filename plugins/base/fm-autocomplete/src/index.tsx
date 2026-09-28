/**
 * `fm-autocomplete` — while a document's frontmatter is being typed, suggests the keys in
 * use across the workspace, and then the values the typed key already has.
 *
 * - `suggest.ts` — what to offer for the text before the caret. Pure.
 * - `controller.ts` — watches every `text.surface`, takes ↑ ↓ Enter Tab Escape while open.
 * - `Menu.tsx` — the dropdown at the caret, in `shell-ui`'s overlay spot.
 *
 * What it knows comes from the `index` port (`lm/workspace-index`, its one service). Where
 * it works comes from the `surfaces` port, a host of `lm/text.surface` like the one
 * `slash-commands` has: with no surfaces wired in there is no menu, and nothing else is
 * lost. A surface also has to offer `documentBeforeCaret` and `replaceBeforeCaret`;
 * `editor` and `alt-editor` do.
 */

import type { Kernel } from "@kernel";

import type { ShellOverlay } from "@protocols/lm/shell.overlay";
import type { WorkspaceIndex } from "@protocols/lm/workspace-index";

import { createController, type MenuController } from "./controller.js";
import { SuggestionMenu } from "./Menu.js";

/** The controller of the running activation, for `deactivate` to detach. */
let liveController: MenuController | undefined;

export default function activate(kernel: Kernel): void {
  // The `index` handle is limited to `fmFields`, `fmValues` and `subscribe`, the port's `needs`.
  const controller = createController(kernel, kernel.ports.use<WorkspaceIndex>("index"));
  liveController = controller;
  kernel.ports.offer<ShellOverlay>("popup", {
    id: "fm-autocomplete.menu",
    component: () => <SuggestionMenu controller={controller} />,
  });
}

/** What the kernel does not withdraw: the key listeners on each surface's element. */
export function deactivate(): void {
  liveController?.dispose();
  liveController = undefined;
}
