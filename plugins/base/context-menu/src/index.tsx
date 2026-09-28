/**
 * `context-menu` — one menu and sheet service for every plugin.
 *
 * A plugin calls `open` with a list of actions (optionally in titled sections, with
 * choice items marked `checked`) or `openSheet` with a body it draws itself, and this
 * plugin shows it: a popover beside the anchor on a wide screen, a bottom sheet on a
 * phone. It renders from an `lm/shell.overlay` seat, so no plugin needs a React
 * presence of its own to show a menu. `modal` and `confirm` ask a question in the same
 * frame and resolve with the answer. The contract is the `lm/context-menu` protocol,
 * served on the `menu` port.
 *
 * - `Menu.tsx` — the popover / sheet, focus handling and the action list.
 * - `Modal.tsx` — a modal's fields, buttons and validation; `confirm` as a modal.
 */

import { useSyncExternalStore, type ReactNode } from "react";

import type { Kernel } from "@kernel";

import type { ContextMenu, ModalRequest, ModalResult } from "@protocols/lm/context-menu";
import type { ShellOverlay } from "@protocols/lm/shell.overlay";

import { MenuHost, type Open } from "./Menu.js";
import { confirmModal } from "./Modal.js";

export type { ContextMenu as ContextMenuApi } from "@protocols/lm/context-menu";

export default function activate(kernel: Kernel): ContextMenu {
  let current: Open | undefined;
  const listeners = new Set<() => void>();
  const set = (next: Open | undefined): void => {
    const previous = current;
    current = next;
    for (const listener of [...listeners]) listener();
    // After the swap, so a caller's onClose that opens another menu is not undone.
    if (previous && previous !== next) previous.request.onClose?.();
  };
  const close = (): void => set(undefined);
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const snapshot = (): Open | undefined => current;

  const Host = (): ReactNode => {
    const open = useSyncExternalStore(subscribe, snapshot, snapshot);
    return <MenuHost open={open} close={close} />;
  };
  kernel.ports.offer<ShellOverlay>("sheet", {
    id: "context-menu",
    component: Host,
  });

  const modal = (request: ModalRequest): Promise<ModalResult | undefined> =>
    new Promise((resolve) => {
      // The first answer wins: a chosen button settles before `close` fires `onClose`.
      let settled = false;
      const settle = (result: ModalResult | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      set({ kind: "modal", request: { ...request, onClose: () => settle(undefined) }, settle });
    });

  const api: ContextMenu = {
    open: (request) => set({ kind: "menu", request }),
    openSheet: (request) => set({ kind: "sheet", request }),
    modal,
    confirm: async (request) => (await modal(confirmModal(request)))?.button === "confirm",
    close,
  };
  kernel.ports.serve("menu", api);
  return api;
}
