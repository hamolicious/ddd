/**
 * The service `context-menu` provides
 * (`kernel.services.require<ContextMenuApi>("context-menu")`).
 *
 * One menu is open at a time; opening another replaces it. With an `anchor` (the
 * button that opened it) it is a popover beside that button on a wide screen; on a
 * phone, or with no anchor, it is a bottom sheet. Focus moves in on open, Tab stays
 * inside, Escape and a click outside close it, and focus returns to whatever opened it.
 */

import type { ReactNode } from "react";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** A second, quieter line under the label. */
  readonly hint?: string;
  /** Drawn in the danger colour: deleting, trashing. */
  readonly danger?: boolean;
  /** Present on choice items: `true` marks the current choice. */
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Runs after the menu has closed, so it may open another menu or sheet. */
  run(): void;
}

export interface MenuSection {
  /** Shown above the items; a menu of one untitled section needs none. */
  readonly title?: string;
  readonly items: readonly MenuItem[];
}

interface Common {
  readonly title: string;
  readonly description?: ReactNode;
  /** The control that opened it: the popover sits beside it, focus returns to it. */
  readonly anchor?: HTMLElement | null;
  /** Called however it closes: an item, Escape, a click outside, another menu opening. */
  readonly onClose?: () => void;
}

export interface MenuRequest extends Common {
  readonly sections: readonly MenuSection[];
}

/** A sheet whose body the caller draws (a picker, a confirmation). */
export interface SheetRequest extends Common {
  render(close: () => void): ReactNode;
}

export interface ContextMenuApi {
  open(menu: MenuRequest): void;
  openSheet(sheet: SheetRequest): void;
  close(): void;
}
