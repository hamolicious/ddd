import type { Kernel } from "@kernel";
import { onSurfacesChange } from "plugin:editor";
import { addRemarkPlugin } from "plugin:markdown";
import { addOverlay } from "plugin:shell-ui";

import { createController, type MenuController } from "./controller.js";
import { load, type EmojiSet } from "./emojis.js";
import { EmojiMenu } from "./Menu.js";
import { remarkShortcodes } from "./shortcodes.js";

let liveController: MenuController | undefined;
let stopped = false;
let removeRemark: (() => void) | undefined;

export default function activate(kernel: Kernel): void {
  stopped = false;
  let emojis: EmojiSet | undefined;
  const controller = createController(() => emojis, onSurfacesChange);
  liveController = controller;
  addOverlay({
    id: "emoji.menu",
    component: () => <EmojiMenu controller={controller} />,
  });

  load().then(
    (set) => {
      if (stopped) return;
      emojis = set;
      removeRemark = addRemarkPlugin({ id: "emoji.shortcodes", plugin: remarkShortcodes(set) });
    },
    (error: unknown) => kernel.log.warn("the emoji set did not load; shortcodes stay as typed", error),
  );
}

export function deactivate(): void {
  stopped = true;
  removeRemark?.();
  removeRemark = undefined;
  liveController?.dispose();
  liveController = undefined;
}
