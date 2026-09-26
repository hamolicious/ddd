/**
 * `context-menu` — one menu and sheet service for every plugin.
 *
 * A plugin calls `open` with a list of actions (optionally in titled sections, with
 * choice items marked `checked`) or `openSheet` with a body it draws itself, and this
 * plugin shows it: a popover beside the anchor on a wide screen, a bottom sheet on a
 * phone. It renders from `shell-ui`'s `shell.overlay` spot, so no plugin needs a React
 * presence of its own to show a menu. The contract is `_shared/context-menu-api.ts`.
 *
 * - `Menu.tsx` — the popover / sheet, focus handling and the action list.
 */

import { useSyncExternalStore, type ReactNode } from "react";

import type { Kernel } from "@kernel";

import type { ContextMenuApi } from "../../_shared/context-menu-api.js";
import { POINTS, type ShellOverlay } from "../../_shared/points.js";

import { MenuHost, type Open } from "./Menu.js";

export type { ContextMenuApi } from "../../_shared/context-menu-api.js";

export default function activate(kernel: Kernel): ContextMenuApi {
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
  kernel.extensions.contribute<ShellOverlay>(POINTS.shellOverlay, {
    id: "context-menu",
    component: Host,
  });

  return {
    open: (request) => set({ kind: "menu", request }),
    openSheet: (request) => set({ kind: "sheet", request }),
    close,
  };
}
