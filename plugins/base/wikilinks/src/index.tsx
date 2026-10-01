/**
 * `wikilinks` — type `[[` in an editor to link a note, `![[` to embed one, and see each
 * linked note's title above its link while writing.
 *
 * - `suggest.ts` — what to offer for the text before the caret. Pure.
 * - `controller.ts` / `Menu.tsx` — the dropdown at the caret, as `emoji` has it.
 * - `decorate.ts` — the editor extension that draws titles over `doc://` links.
 *
 * A chosen note is written as a plain markdown link, `[](doc://<id>)`: nothing new for
 * read mode to learn, and empty link text so `markdown` draws the note's live title. In
 * the frontmatter it is the bare `doc://<id>` a property holds when it points at a note.
 * Notes and titles come from `plugin:indexer`; a click on a title opens the note when the
 * optional `router` is enabled.
 */

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

/** What the kernel does not withdraw: the key listeners on each surface's element. */
export function deactivate(): void {
  liveController?.dispose();
  liveController = undefined;
}
