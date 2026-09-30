/**
 * What `folders` exports to other plugins (`plugin:folders`): where a note sits in the
 * tree, and how it is dressed. These were the `lm/folders` and `lm/folders.decoration`
 * protocols before kernel 3.0; the member names are unchanged.
 */

import type { ReactNode } from "react";

import { s, type Unsubscribe } from "@kernel";

/** How a note is dressed: the first of each field in the decorations' order. */
export interface NoteLook {
  readonly background?: string;
  readonly color?: string;
  /** About one line high; inherits `color` as `currentColor`. */
  readonly icon?: ReactNode;
}

/**
 * Where a note sits in the folder tree. A folder is a note: its children are listed in its
 * own `%%% folders` section, which only `folders` writes, so other plugins file notes
 * through these functions. A note has at most one parent; `""` is the root.
 */
export interface Folders {
  /** The note's parent id, `""` at the root, `undefined` for a note the tree does not know. */
  readonly parentOf: (id: string) => string | undefined;
  /** The notes filed under `id`, in the tree's order; `[]` for none. */
  readonly childrenOf: (id: string) => readonly string[];
  /** Fires when the tree may have changed: a note filed, moved, added or removed. */
  readonly onChange: (listener: () => void) => Unsubscribe;
  /** Put the note under `parent` (`""` for the root), before the child at `index` or last. Rejects a parent inside the note itself. */
  readonly file: (id: string, parent: string, index?: number) => Promise<void>;
  /** File a document just created where the person asked new ones of that kind to go ("New notes go to", "Files go to"). Does nothing when that is the root. */
  readonly fileNew: (id: string, kind: "note" | "file") => Promise<void>;
  /** The note's colour and icon, as the tree draws them. */
  readonly look: (id: string) => NoteLook | undefined;
  /** Fires when any answer `look` gives may have changed. */
  readonly onLookChange: (listener: () => void) => Unsubscribe;
  /** The id of the note at that chain of titles from the root, creating the missing ones (without opening them). `[]` is the root, `""`. */
  readonly ensurePath: (titles: readonly string[]) => Promise<string>;
}

/** What one decoration gives a row: any combination of a background, a text colour and an icon. */
export interface FolderLook {
  /** Any CSS colour, behind the icon and the name. Pair it with a `color` that reads on it. */
  readonly background?: string;
  /** Any CSS colour, for the icon and the name. */
  readonly color?: string;
  /** Drawn before the name, about one line high. It inherits `color` as `currentColor`. */
  readonly icon?: ReactNode;
}

/**
 * Dresses note rows in the folder tree (`addDecoration`). The icon and the name are drawn
 * together in a pill that takes `background`. The tree asks `decorate` for every note it
 * draws, by id, and redraws when `onChange` fires. With several decorations, each field
 * comes from the first one (by `order`, then the order they were added) that sets it.
 */
export interface FolderDecoration {
  /** Unique; a decoration added later with the same id replaces the earlier one. */
  readonly id: string;
  /** Called on every render of every row, with the note's id: answer from memory, never await. */
  readonly decorate: (id: string) => FolderLook | undefined;
  /** Fires when any answer `decorate` gives may have changed. */
  readonly onChange: (listener: () => void) => Unsubscribe;
  /** Low first. Default 0. */
  readonly order?: number;
}

/** A decoration as `addDecoration` checks it. */
export const FOLDER_DECORATION_SHAPE = s.object({
  id: s.string(),
  decorate: s.func(),
  onChange: s.func(),
  order: s.optional(s.number()),
});
