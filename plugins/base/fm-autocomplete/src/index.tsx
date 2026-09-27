/**
 * `fm-autocomplete` — while a document's frontmatter is being typed, suggests the keys in
 * use across the workspace, and then the values the typed key already has.
 *
 * - `suggest.ts` — what to offer for the text before the caret. Pure.
 * - `controller.ts` — watches every `text.surface`, takes ↑ ↓ Enter Tab Escape while open.
 * - `Menu.tsx` — the dropdown at the caret, in `shell-ui`'s overlay spot.
 *
 * What it knows comes from `indexer` (its one dependency). Where it works comes from the
 * `text.surface` point `slash-commands` defines, which it reads without depending on:
 * with no surfaces there is no menu, and nothing else is lost. A surface also has to
 * offer `documentBeforeCaret` and `replaceBeforeCaret`; `editor` and `alt-editor` do.
 */

import type { Kernel } from "@kernel";

import type { IndexerApi } from "../../_shared/indexer-api.js";
import { POINTS, type ShellOverlay } from "../../_shared/points.js";

import { createController } from "./controller.js";
import { SuggestionMenu } from "./Menu.js";

export default function activate(kernel: Kernel): void {
  const controller = createController(kernel, kernel.services.require<IndexerApi>("indexer"));
  kernel.extensions.contribute<ShellOverlay>(POINTS.shellOverlay, {
    id: "fm-autocomplete.menu",
    component: () => <SuggestionMenu controller={controller} />,
  });
}
