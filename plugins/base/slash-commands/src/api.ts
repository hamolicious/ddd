import type { ReactNode } from "react";

import { createRegistry, s, type DocumentId } from "@kernel";
import type { TextMark } from "plugin:editor";

export interface SlashCommandContext {
  readonly documentId: DocumentId;
  readonly mark: TextMark;
  focus(): void;
}

export interface SlashCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly keywords?: readonly string[];
  readonly order?: number;
  readonly when?: (context: { readonly documentId: DocumentId }) => boolean;
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
