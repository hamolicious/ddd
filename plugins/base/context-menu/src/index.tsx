/**
 * `context-menu` — one menu and sheet service for every plugin.
 *
 * ## API (`plugin:context-menu`)
 *
 * Contributions:
 * - `addAction(action | actions)` → unregister. A `ContextAction` is
 *   `{ id, target, order?, items(target, chain) }`: the items shown for every element
 *   marked with that target type. An action with the same `id` as an earlier one replaces it.
 *
 * The old `ddd/context-menu` service, member for member, as named exports:
 * - `open(menu: MenuRequest)`, `openSheet(sheet: SheetRequest)`, `close()`
 * - `modal(request: ModalRequest)` → `Promise<ModalResult | undefined>`
 * - `confirm(request: ConfirmRequest)` → `Promise<boolean>`
 * - `openFor(element, anchor?)` → `boolean`
 *
 * Types: `ContextMenu` (the menu functions as one type; `ContextMenuApi` is the same),
 * `ContextAction`, `Target` (from `_shared/target.ts`), `MenuItem`, `MenuSection`,
 * `MenuCommon`, `MenuRequest`, `SheetRequest`, `ModalRequest`, `ModalResult`,
 * `ModalField`, `ModalValue`, `ModalButton`, `FieldCommon`, `TextField`,
 * `TextAreaField`, `CheckboxField`, `SelectField`, `ConfirmRequest`.
 *
 * A plugin calls `open` with a list of actions (optionally in titled sections, with
 * choice items marked `checked`) or `openSheet` with a body it draws itself, and this
 * plugin shows it: a popover beside the anchor on a wide screen, a bottom sheet on a
 * phone. It renders from one `shell-ui` overlay, so no plugin needs a React presence of
 * its own to show a menu. `modal` and `confirm` ask a question in the same frame and
 * resolve with the answer.
 *
 * - `Menu.tsx` — the popover / sheet, focus handling and the action list.
 * - `Modal.tsx` — a modal's fields, buttons and validation; `confirm` as a modal.
 * - `targets.ts` — menus for marked elements: right-click, long press, the menu key.
 *
 * Whether something is a popover, a bottom sheet or a centred dialog is decided here and
 * only here (`Menu.tsx`): callers say what to show, never how.
 */

import { useSyncExternalStore, type ReactNode } from "react";

import { createRegistry, s, type Kernel } from "@kernel";

import { addOverlay } from "plugin:shell-ui";

import type {
  ConfirmRequest,
  ContextAction,
  ContextMenu,
  MenuRequest,
  ModalRequest,
  ModalResult,
  SheetRequest,
} from "./api.js";
import { MenuHost, type Open } from "./Menu.js";
import { confirmModal } from "./Modal.js";
import { buildMenu, listen } from "./targets.js";

export type {
  CheckboxField,
  ConfirmRequest,
  ContextAction,
  ContextMenu,
  FieldCommon,
  MenuCommon,
  MenuItem,
  MenuRequest,
  MenuSection,
  ModalButton,
  ModalField,
  ModalRequest,
  ModalResult,
  ModalValue,
  SelectField,
  SheetRequest,
  Target,
  TextAreaField,
  TextField,
} from "./api.js";

/** The menu functions as one type; the same as `ContextMenu`. */
export type ContextMenuApi = ContextMenu;

// ---------------------------------------------------------------------------
// Actions for marked elements
// ---------------------------------------------------------------------------

const actions = createRegistry<ContextAction>({
  key: (action) => action.id,
  order: (action) => action.order ?? 0,
  shape: s.object({
    id: s.string(),
    target: s.string(),
    order: s.optional(s.number()),
    items: s.func(),
  }),
});

/** Offer menu items for a target type (or several actions). Returns the function that removes them. */
export const addAction: (items: ContextAction | readonly ContextAction[]) => () => void = actions.add;

// ---------------------------------------------------------------------------
// What is open
// ---------------------------------------------------------------------------

let current: Open | undefined;
const listeners = new Set<() => void>();
let warn: (message: string, error: unknown) => void = (message, error) => console.warn(`[context-menu] ${message}`, error);

function set(next: Open | undefined): void {
  const previous = current;
  current = next;
  for (const listener of [...listeners]) listener();
  // After the swap, so a caller's onClose that opens another menu is not undone.
  if (previous && previous !== next) previous.request.onClose?.();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = (): Open | undefined => current;

function Host(): ReactNode {
  const open = useSyncExternalStore(subscribe, snapshot, snapshot);
  return <MenuHost open={open} close={close} />;
}

function openAt(from: Element, anchor: HTMLElement | null): boolean {
  const menu = buildMenu(from, actions.entries(), (entry, error) =>
    warn(`context action ${entry.value.id} from ${entry.pluginId} failed`, error),
  );
  if (!menu) return false;
  set({ kind: "menu", request: { ...menu, anchor } });
  return true;
}

// ---------------------------------------------------------------------------
// The menu functions
// ---------------------------------------------------------------------------

/** Show a menu: a popover beside `menu.anchor` on a wide screen, a bottom sheet on a phone. */
export function open(menu: MenuRequest): void {
  set({ kind: "menu", request: menu });
}

/** Show a sheet whose body the caller draws. */
export function openSheet(sheet: SheetRequest): void {
  set({ kind: "sheet", request: sheet });
}

/** Close whatever is open. */
export function close(): void {
  set(undefined);
}

/**
 * Ask something: resolves with the button and field values, or `undefined` when
 * dismissed (a `dismiss` button, Escape, a click outside, ✕, or another menu opening).
 * Validation runs before a non-dismiss button resolves.
 */
export function modal(request: ModalRequest): Promise<ModalResult | undefined> {
  return new Promise((resolve) => {
    // The first answer wins: a chosen button settles before `close` fires `onClose`.
    let settled = false;
    const settle = (result: ModalResult | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    set({ kind: "modal", request: { ...request, onClose: () => settle(undefined) }, settle });
  });
}

/** "Are you sure?": resolves `true` only when the confirm button is chosen. */
export async function confirm(request: ConfirmRequest): Promise<boolean> {
  return (await modal(confirmModal(request)))?.button === "confirm";
}

/**
 * Open the actions menu of the marked element at or around `element` (a ⋯ button's row),
 * beside `anchor` (default `element`). `false` when there is nothing to show.
 */
export function openFor(element: HTMLElement, anchor?: HTMLElement | null): boolean {
  return openAt(element, anchor === undefined ? element : anchor);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let teardown: (() => void) | undefined;

export default function activate(kernel: Kernel): void {
  teardown?.();
  warn = (message, error) => kernel.log.warn(message, error);
  const removeOverlay = addOverlay({ id: "context-menu", component: Host });
  const stopListening = listen(openAt);
  teardown = () => {
    stopListening();
    removeOverlay();
  };
}

export function deactivate(): void {
  teardown?.();
  teardown = undefined;
  close();
}
