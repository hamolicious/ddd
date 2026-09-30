/**
 * `slash-commands` — type `/` in any editor for a menu of actions.
 *
 * - Commands are added with `addSlashCommand` (this plugin's registry). `attachments`
 *   adds `/attach`.
 * - Editors are found through `plugin:editor`'s text surfaces (`surfaces()` /
 *   `onSurfacesChange`): CodeMirror and a plain textarea each add one while mounted. An
 *   editor without a surface simply has no menu.
 *
 * The menu is drawn in `shell-ui`'s overlay spot (`Menu.tsx`) and driven by
 * `controller.ts`.
 */

import type { Kernel } from "@kernel";
import { onSurfacesChange } from "plugin:editor";
import { addOverlay } from "plugin:shell-ui";

import { commandRegistry, type SlashCommand } from "./api.js";
import { createController, type SlashController } from "./controller.js";
import { SlashMenu } from "./Menu.js";

export type { SlashCommand, SlashCommandContext } from "./api.js";

/** Add a `/` menu entry (or several). Returns the function that takes it out again. */
export const addSlashCommand: (items: SlashCommand | readonly SlashCommand[]) => () => void = commandRegistry.add;

/** The controller of the running activation, for `deactivate` to detach. */
let liveController: SlashController | undefined;

export default function activate(kernel: Kernel): void {
  const controller = createController(kernel, onSurfacesChange, () => commandRegistry.get());
  liveController = controller;

  addOverlay({
    id: "slash-commands.menu",
    component: () => <SlashMenu controller={controller} />,
  });
}

/** What the kernel does not withdraw: the key listeners on each surface's element. */
export function deactivate(): void {
  liveController?.dispose();
  liveController = undefined;
}
