/**
 * The service `context-menu` provides
 * (`kernel.services.require<ContextMenuApi>("context-menu")`).
 *
 * One menu is open at a time; opening another replaces it. With an `anchor` (the
 * button that opened it) it is a popover beside that button on a wide screen; on a
 * phone, or with no anchor, it is a bottom sheet. Focus moves in on open, Tab stays
 * inside, Escape and a click outside close it, and focus returns to whatever opened it.
 *
 * `modal` and `confirm` ask a question instead: always a centred dialog (a bottom sheet
 * on a phone), never a popover, and they resolve with the answer.
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

interface FieldCommon {
  /** The key of this field's value in `ModalResult.values`. */
  readonly id: string;
  readonly label: string;
  /** A quieter line under the field. */
  readonly hint?: string;
}

export interface TextField extends FieldCommon {
  readonly kind: "text";
  readonly type?: "text" | "email" | "password" | "url" | "number";
  readonly value?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  /** A message when the value is not acceptable, `undefined` when it is. */
  validate?(value: string, values: Readonly<Record<string, ModalValue>>): string | undefined;
}

export interface TextAreaField extends FieldCommon {
  readonly kind: "textarea";
  readonly value?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  validate?(value: string, values: Readonly<Record<string, ModalValue>>): string | undefined;
}

export interface CheckboxField extends FieldCommon {
  readonly kind: "checkbox";
  readonly value?: boolean;
}

export interface SelectField extends FieldCommon {
  readonly kind: "select";
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** Defaults to the first option. */
  readonly value?: string;
}

export type ModalField = TextField | TextAreaField | CheckboxField | SelectField;

export type ModalValue = string | boolean;

export interface ModalButton {
  /** `ModalResult.button` when this one is chosen. */
  readonly id: string;
  readonly label: string;
  /** `primary` is the accent colour, `danger` red; the rest are plain. */
  readonly tone?: "plain" | "primary" | "danger";
  /** Closes the modal as a cancel: resolves `undefined`, skips validation. */
  readonly dismiss?: boolean;
  /** The button Enter presses. Defaults to the last button that does not dismiss. */
  readonly default?: boolean;
  /** Takes focus on open when there are no fields. Defaults to the default button. */
  readonly autoFocus?: boolean;
}

export interface ModalRequest {
  readonly title: string;
  readonly description?: ReactNode;
  /** Laid out in a column, in this order. */
  readonly fields?: readonly ModalField[];
  /** In reading order, left to right. Defaults to a single "OK". */
  readonly buttons?: readonly ModalButton[];
  /** Where focus returns when it closes. */
  readonly anchor?: HTMLElement | null;
}

export interface ModalResult {
  readonly button: string;
  /** Every field's value, by `id`: a string, or a boolean for a checkbox. */
  readonly values: Readonly<Record<string, ModalValue>>;
}

export interface ConfirmRequest {
  readonly title: string;
  readonly description?: ReactNode;
  /** Defaults to "Confirm", or "Delete" when `danger`. */
  readonly confirmLabel?: string;
  /** Defaults to "Cancel". */
  readonly cancelLabel?: string;
  /** Red confirm button, and focus starts on Cancel. */
  readonly danger?: boolean;
  /** When set, this exact text must be typed before the confirm button goes through. */
  readonly typeToConfirm?: string;
  readonly anchor?: HTMLElement | null;
}

export interface ContextMenuApi {
  open(menu: MenuRequest): void;
  openSheet(sheet: SheetRequest): void;
  /**
   * Ask something: fields and buttons. Resolves with the button chosen and the field
   * values, or `undefined` when dismissed (a `dismiss` button, Escape, a click outside,
   * ✕, or another menu opening). Validation runs before a non-dismiss button resolves.
   */
  modal(request: ModalRequest): Promise<ModalResult | undefined>;
  /** "Are you sure?": resolves `true` only when the confirm button is chosen. */
  confirm(request: ConfirmRequest): Promise<boolean>;
  close(): void;
}
