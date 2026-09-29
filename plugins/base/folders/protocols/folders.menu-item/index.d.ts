/**
 * lm/folders.menu-item@2.0.0: slot, owned by `folders`.
 *
 * An entry in a note's actions menu in the folder tree (the ⋯ button, right-click, long
 * press), listed after the tree's own entries and before "Delete", in seat order. `run` is
 * called once the menu has closed, so it may open a menu or sheet of its own.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/folders.menu-item";
export type ProtocolVersion = "2.0.0";

export interface FolderMenuItem {
  readonly id: string;
  readonly label: string;
  /** A second, quieter line under the label. */
  readonly hint?: string;
  /** Return `false` to leave the entry out for this note. */
  readonly when?: (id: string) => boolean;
  /** `id` is the note's; `anchor` is the control that opened the menu, when there was one. */
  readonly run: (id: string, anchor?: HTMLElement) => void;
}
