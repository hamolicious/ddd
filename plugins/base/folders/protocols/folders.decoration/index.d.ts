/**
 * lm/folders.decoration@1.0.0: slot, owned by `folders`.
 *
 * Dresses folder rows in the tree: a background, a text colour, an icon, in any
 * combination. The icon and the name are drawn together in a pill that takes `background`.
 * The tree asks `decorate` for every folder it draws and redraws when `onChange` fires.
 * With several providers, each field comes from the first one in seat order that sets it.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ReactNode } from "react";
import type { Unsubscribe } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/folders.decoration";
export type ProtocolVersion = "1.0.0";

export interface FolderLook {
  /** Any CSS colour, behind the icon and the name. Pair it with a `color` that reads on it. */
  readonly background?: string;
  /** Any CSS colour, for the icon and the name. */
  readonly color?: string;
  /** Drawn before the name, about one line high. It inherits `color` as `currentColor`. */
  readonly icon?: ReactNode;
}

export interface FolderDecoration {
  readonly id: string;
  /** Called on every render of every folder row: answer from memory, never await. */
  readonly decorate: (path: string) => FolderLook | undefined;
  /** Fires when any answer `decorate` gives may have changed. */
  readonly onChange: (listener: () => void) => Unsubscribe;
}
