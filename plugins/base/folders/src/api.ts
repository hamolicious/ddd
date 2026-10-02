import type { ReactNode } from "react";

import { s, type Unsubscribe } from "@kernel";

export interface NoteLook {
  readonly background?: string;
  readonly color?: string;
  readonly icon?: ReactNode;
}

export interface Folders {
  readonly parentOf: (id: string) => string | undefined;
  readonly childrenOf: (id: string) => readonly string[];
  readonly onChange: (listener: () => void) => Unsubscribe;
  readonly file: (id: string, parent: string, index?: number) => Promise<void>;
  readonly fileNew: (id: string, kind: "note" | "file") => Promise<void>;
  readonly look: (id: string) => NoteLook | undefined;
  readonly onLookChange: (listener: () => void) => Unsubscribe;
  readonly ensurePath: (titles: readonly string[]) => Promise<string>;
}

export interface FolderLook {
  readonly background?: string;
  readonly color?: string;
  readonly icon?: ReactNode;
}

export interface FolderDecoration {
  readonly id: string;
  readonly decorate: (id: string) => FolderLook | undefined;
  readonly onChange: (listener: () => void) => Unsubscribe;
  readonly order?: number;
}

export const FOLDER_DECORATION_SHAPE = s.object({
  id: s.string(),
  decorate: s.func(),
  onChange: s.func(),
  order: s.optional(s.number()),
});
