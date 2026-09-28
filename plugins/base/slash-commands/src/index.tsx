/**
 * `slash-commands` — type `/` in any editor for a menu of actions.
 *
 * Two protocols, both owned here (`protocols/`), each hosted on a port of this plugin:
 *
 * - **`lm/text.surface`** on `surfaces`: an editor, editor-neutral. `editor` (CodeMirror)
 *   and `alt-editor` (a textarea) each offer one while mounted. That is the whole
 *   coupling: this plugin never imports an editor, and an editor without a surface simply
 *   has no menu.
 * - **`lm/slash.command`** on `commands`: an entry in the menu. `attachments` offers `/attach`.
 *
 * The menu is drawn from `shell-ui`'s overlay spot (`Menu.tsx`) and driven by
 * `controller.ts`. It consumes no service: what reaches each host is what the wiring
 * seats there.
 */

import type { Kernel } from "@kernel";

import type { ShellOverlay } from "@protocols/lm/shell.overlay";
import type { SlashCommand } from "@protocols/lm/slash.command";
import type { TextSurface } from "@protocols/lm/text.surface";

import { createController, type SlashController } from "./controller.js";
import { SlashMenu } from "./Menu.js";

/** The controller of the running activation, for `deactivate` to detach. */
let liveController: SlashController | undefined;

export default function activate(kernel: Kernel): void {
  // Both hosts: what is wired to `surfaces` and `commands`, in seat order. The shapes and
  // the duplicate-`id` rule come from the protocol packages this plugin owns.
  const surfaces = kernel.ports.collect<TextSurface>("surfaces");
  const commands = kernel.ports.collect<SlashCommand>("commands");

  const controller = createController(kernel, surfaces, commands);
  liveController = controller;

  kernel.ports.offer<ShellOverlay>("menu", {
    id: "slash-commands.menu",
    component: () => <SlashMenu controller={controller} />,
  });
}

/** What the kernel does not withdraw: the key listeners on each surface's element. */
export function deactivate(): void {
  liveController?.dispose();
  liveController = undefined;
}
