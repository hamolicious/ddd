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

export type ContextMenuApi = ContextMenu;

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

export const addAction: (items: ContextAction | readonly ContextAction[]) => () => void = actions.add;

let current: Open | undefined;
const listeners = new Set<() => void>();
let warn: (message: string, error: unknown) => void = (message, error) => console.warn(`[context-menu] ${message}`, error);

function set(next: Open | undefined): void {
  const previous = current;
  current = next;
  for (const listener of [...listeners]) listener();
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

export function open(menu: MenuRequest): void {
  set({ kind: "menu", request: menu });
}

export function openSheet(sheet: SheetRequest): void {
  set({ kind: "sheet", request: sheet });
}

export function close(): void {
  set(undefined);
}

export function modal(request: ModalRequest): Promise<ModalResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ModalResult | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    set({ kind: "modal", request: { ...request, onClose: () => settle(undefined) }, settle });
  });
}

export async function confirm(request: ConfirmRequest): Promise<boolean> {
  return (await modal(confirmModal(request)))?.button === "confirm";
}

export function openFor(element: HTMLElement, anchor?: HTMLElement | null): boolean {
  return openAt(element, anchor === undefined ? element : anchor);
}

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
