import type { ReactNode } from "react";

import type { Target } from "../../_shared/target.js";

export type { Target } from "../../_shared/target.js";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly danger?: boolean;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  run(): void;
}

export interface MenuSection {
  readonly title?: string;
  readonly items: readonly MenuItem[];
}

export interface MenuCommon {
  readonly title: string;
  readonly description?: ReactNode;
  readonly anchor?: HTMLElement | null;
  readonly onClose?: () => void;
}

export interface MenuRequest extends MenuCommon {
  readonly sections: readonly MenuSection[];
}

export interface SheetRequest extends MenuCommon {
  render(close: () => void): ReactNode;
}

export interface FieldCommon {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

export interface TextField extends FieldCommon {
  readonly kind: "text";
  readonly type?: "text" | "email" | "password" | "url" | "number";
  readonly value?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
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
  readonly value?: string;
}

export type ModalField = TextField | TextAreaField | CheckboxField | SelectField;

export type ModalValue = string | boolean;

export interface ModalButton {
  readonly id: string;
  readonly label: string;
  readonly tone?: "plain" | "primary" | "danger";
  readonly dismiss?: boolean;
  readonly default?: boolean;
  readonly autoFocus?: boolean;
}

export interface ModalRequest {
  readonly title: string;
  readonly description?: ReactNode;
  readonly fields?: readonly ModalField[];
  readonly buttons?: readonly ModalButton[];
  readonly anchor?: HTMLElement | null;
}

export interface ModalResult {
  readonly button: string;
  readonly values: Readonly<Record<string, ModalValue>>;
}

export interface ConfirmRequest {
  readonly title: string;
  readonly description?: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  readonly typeToConfirm?: string;
  readonly anchor?: HTMLElement | null;
}

export interface ContextMenu {
  readonly open: (menu: MenuRequest) => void;
  readonly openSheet: (sheet: SheetRequest) => void;
  readonly modal: (request: ModalRequest) => Promise<ModalResult | undefined>;
  readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
  readonly close: () => void;
  readonly openFor: (element: HTMLElement, anchor?: HTMLElement | null) => boolean;
}

export interface ContextAction {
  readonly id: string;
  readonly target: string;
  readonly order?: number;
  readonly items: (target: Target, chain: readonly Target[]) => readonly MenuItem[];
}
