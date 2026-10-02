import type { Kernel } from "@kernel";
import { onSurfacesChange } from "plugin:editor";
import { addOverlay } from "plugin:shell-ui";

import { commandRegistry, type SlashCommand } from "./api.js";
import { createController, type SlashController } from "./controller.js";
import { SlashMenu } from "./Menu.js";

export type { SlashCommand, SlashCommandContext } from "./api.js";

export const addSlashCommand: (items: SlashCommand | readonly SlashCommand[]) => () => void = commandRegistry.add;

let liveController: SlashController | undefined;

export default function activate(kernel: Kernel): void {
  const controller = createController(kernel, onSurfacesChange, () => commandRegistry.get());
  liveController = controller;

  addOverlay({
    id: "slash-commands.menu",
    component: () => <SlashMenu controller={controller} />,
  });
}

export function deactivate(): void {
  liveController?.dispose();
  liveController = undefined;
}
