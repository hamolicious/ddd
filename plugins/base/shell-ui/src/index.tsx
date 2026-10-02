import type { Kernel, Unsubscribe } from "@kernel";

import {
  altbarPanels,
  footers,
  headers,
  overlays,
  sidebarPanels,
  views,
  type AltbarPanel,
  type MainView,
  type ShellFooterComponent,
  type ShellHeaderComponent,
  type ShellLayout,
  type ShellOverlay,
  type SidebarPanel,
} from "./api.js";
import { ALTBAR_ID, SIDEBAR_ID, Shell as ShellView } from "./Shell.js";
import { ShellState } from "./state.js";

export type {
  AltbarPanel,
  MainView,
  Shell,
  ShellFooterComponent,
  ShellHeaderComponent,
  ShellLayout,
  ShellOverlay,
  ShownView,
  SidebarPanel,
} from "./api.js";
export type { Shell as ShellUiApi } from "./api.js";

let live: ShellState | undefined;
let kernelRef: Kernel | undefined;

function state(): ShellState {
  if (!live) throw new Error("shell-ui: the shell is not active yet (call it from your own activate or later)");
  return live;
}

export const addView: (items: MainView | readonly MainView[]) => () => void = views.add;
export const addOverlay: (items: ShellOverlay | readonly ShellOverlay[]) => () => void = overlays.add;
export const addSidebarPanel: (items: SidebarPanel | readonly SidebarPanel[]) => () => void = sidebarPanels.add;
export const addAltbarPanel: (items: AltbarPanel | readonly AltbarPanel[]) => () => void = altbarPanels.add;

export function setHeader(component: ShellHeaderComponent): () => void {
  if (headers.get().length > 0) {
    const warn = kernelRef?.log.warn.bind(kernelRef.log) ?? console.warn;
    warn("shell-ui: setHeader called while a header is already set; the new one replaces it");
  }
  return headers.add({ component });
}

export function setFooter(component: ShellFooterComponent): () => void {
  if (footers.get().length > 0) {
    const warn = kernelRef?.log.warn.bind(kernelRef.log) ?? console.warn;
    warn("shell-ui: setFooter called while a footer is already set; the new one replaces it");
  }
  return footers.add({ component });
}

export function isCompact(): boolean {
  return state().compact;
}

export function onLayoutChange(listener: (compact: boolean) => void): Unsubscribe {
  return state().onLayoutChange(listener);
}

export function layout(): ShellLayout {
  return state().layout();
}

export function subscribeLayout(listener: () => void): Unsubscribe {
  return state().subscribe(listener);
}

export const sidebarId = SIDEBAR_ID;
export const altbarId = ALTBAR_ID;

export function toggleSidebar(open?: boolean): void {
  state().toggleSidebar(open);
}

export function toggleAltbar(open?: boolean): void {
  state().toggleAltbar(open);
}

export function setMainView(id: string, params?: Readonly<Record<string, string>>): void {
  state().setMainView(id, params);
}

export default function activate(kernel: Kernel): void {
  kernelRef = kernel;
  const shellState = new ShellState();
  live = shellState;

  kernel.ui.mount(<ShellView kernel={kernel} state={shellState} />);
}

export function deactivate(): void {
  live?.dispose();
  live = undefined;
  kernelRef = undefined;
}
