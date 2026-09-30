/**
 * `emoji` — `:tada:` in a note reads as 🎉, and typing `:ta` in an editor offers the
 * shortcodes that fit. GitHub's set (gemoji), packed by `build.mjs`.
 *
 * - `emojis.ts` — the set, fetched from next to this module on activation.
 * - `shortcodes.ts` — the remark plugin added to `plugin:markdown`.
 * - `suggest.ts` — what to offer for the text before the caret. Pure.
 * - `controller.ts` / `Menu.tsx` — the dropdown at the caret, as `fm-autocomplete` has it.
 *
 * The set loads after activation, so boot never waits on it; the remark plugin is added
 * once it is here, which re-renders open notes with their emoji.
 */

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
/** Takes the remark plugin out again, once it is in. */
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

/** Take off the key listeners on each surface's element and the remark plugin. */
export function deactivate(): void {
  stopped = true;
  removeRemark?.();
  removeRemark = undefined;
  liveController?.dispose();
  liveController = undefined;
}
