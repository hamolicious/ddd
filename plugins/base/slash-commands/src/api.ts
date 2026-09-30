/**
 * What `slash-commands` exports to other plugins (`plugin:slash-commands`): the command
 * type and the module-scope registry that collects them.
 */

import type { ReactNode } from "react";

import { createRegistry, s, type DocumentId } from "@kernel";
import type { TextMark } from "plugin:editor";

export interface SlashCommandContext {
  readonly documentId: DocumentId;
  /** Where the `/command` was: insert here, now or after something slow. */
  readonly mark: TextMark;
  /** Give the editor its focus back. */
  focus(): void;
}

/**
 * One entry in the `/` menu. Typing `/att` lists the commands whose title or keywords
 * start with it. With nothing typed, and among equally good matches, commands appear in
 * `order`. The same `id` added twice: the later replaces the earlier.
 */
export interface SlashCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  /** Other words it is found by. */
  readonly keywords?: readonly string[];
  /** Lower first. Default 100. */
  readonly order?: number;
  /** `false` ⇒ not offered in this document. */
  readonly when?: (context: { readonly documentId: DocumentId }) => boolean;
  /**
   * Called with the typed `/command` removed, inside the key press or tap that chose it,
   * so it may open a file picker or anything else that needs a user gesture.
   */
  readonly run: (context: SlashCommandContext) => void;
}

export const commandRegistry = createRegistry<SlashCommand>({
  key: (command) => command.id,
  order: (command) => command.order ?? 100,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    description: s.optional(s.string()),
    icon: s.optional(s.any()),
    keywords: s.optional(s.array(s.string())),
    order: s.optional(s.number()),
    when: s.optional(s.func()),
    run: s.func(),
  }),
});
