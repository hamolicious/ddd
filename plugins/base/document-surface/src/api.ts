import type { ComponentType, ReactNode } from "react";

import { createRegistry, s, type DocumentId, type DocumentRow, type OpenDocument } from "@kernel";

export interface DocumentModeProps {
  readonly id: DocumentId;
  readonly row: DocumentRow;
  readonly open?: OpenDocument;
  readonly line?: number;
  readonly unavailable?: boolean;
  readonly embedded?: boolean;
}

export interface DocumentMode {
  readonly id: string;
  readonly label: string;
  readonly component: ComponentType<DocumentModeProps>;
  readonly icon?: ReactNode;
  readonly order?: number;
  readonly when?: (row: DocumentRow) => boolean;
  readonly prefer?: (row: DocumentRow) => boolean;
  readonly forNew?: boolean;
}

export const modeRegistry = createRegistry<DocumentMode>({
  key: (mode) => mode.id,
  order: (mode) => mode.order ?? 100,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    component: s.component(),
    icon: s.optional(s.any()),
    order: s.optional(s.number()),
    when: s.optional(s.func()),
    prefer: s.optional(s.func()),
    forNew: s.optional(s.boolean()),
  }),
});
