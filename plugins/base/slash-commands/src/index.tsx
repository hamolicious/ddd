/**
 * `slash-commands` — type `/` in any editor for a menu of actions.
 *
 * Two points, both defined here:
 *
 * - **`text.surface`**: an editor, editor-neutral. `editor` (CodeMirror) and `alt-editor`
 *   (a textarea) each contribute one while mounted. That is the whole coupling: this
 *   plugin never imports an editor, and an editor without a surface simply has no menu.
 * - **`slash.command`**: an entry in the menu. `attachments` contributes `/attach`.
 *
 * The menu is drawn from `shell-ui`'s overlay spot (`Menu.tsx`) and driven by
 * `controller.ts`. No dependencies: every point it uses buffers contributions until it
 * exists.
 */

import type { Kernel } from "@kernel";

import {
  POINTS,
  slashCommandShape,
  textSurfaceShape,
  type ShellOverlay,
  type SlashCommand,
  type TextSurface,
} from "../../_shared/points.js";
import { createController } from "./controller.js";
import { SlashMenu } from "./Menu.js";

export default function activate(kernel: Kernel): void {
  const surfaces = kernel.extensions.definePoint<TextSurface>({
    name: POINTS.textSurface,
    shape: textSurfaceShape,
    key: (surface) => surface.id,
    description: "A mounted editor, editor-neutral: caret, text before it, and a way to insert there.",
  });
  const commands = kernel.extensions.definePoint<SlashCommand>({
    name: POINTS.slashCommand,
    shape: slashCommandShape,
    key: (command) => command.id,
    description: "An entry in the / menu.",
  });

  const controller = createController(kernel, surfaces, commands);

  kernel.extensions.contribute<ShellOverlay>(POINTS.shellOverlay, {
    id: "slash-commands.menu",
    component: () => <SlashMenu controller={controller} />,
  });
}
