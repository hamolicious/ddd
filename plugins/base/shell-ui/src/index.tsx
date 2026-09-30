/**
 * `shell-ui` — the layout skeleton, and the only plugin that takes the kernel's UI
 * mount (SPEC §6.5).
 *
 * It hosts six contribution points and no features: a header spot (`setHeader`), a
 * footer spot (`setFooter`), a sidebar of panels (`addSidebarPanel`), one main region that renders whichever view
 * the router selected (`addView`), an altbar of panels about that view
 * (`addAltbarPanel`), and always-mounted overlays (`addOverlay`). Everything visible
 * inside them belongs to somebody else — the top and bottom bars, with the ☰ and the
 * altbar toggle, are the `toolbar` plugin's.
 *
 * What lives where:
 *
 * - `api.ts` — the exported types and the module-scope registries.
 * - `state.ts` — the shell's own state (selected view, sidebar, breakpoint), outside
 *   React because the router and `matchMedia` both drive it from outside the tree.
 * - `Shell.tsx` — the layout, the landmarks, the drawer, the error boundaries.
 * - `resize.ts` — the column widths, clamped and remembered per device.
 */

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
/** Kept for dependents that named the service type this way. */
export type { Shell as ShellUiApi } from "./api.js";

let live: ShellState | undefined;
let kernelRef: Kernel | undefined;

function state(): ShellState {
  if (!live) throw new Error("shell-ui: the shell is not active yet (call it from your own activate or later)");
  return live;
}

// ---------------------------------------------------------------------------
// Contribution points
// ---------------------------------------------------------------------------

/** Add a full-pane view (or several). Returns the function that takes it out again. */
export const addView: (items: MainView | readonly MainView[]) => () => void = views.add;
/** Add an always-mounted component (a palette, a toast stack). Returns its remover. */
export const addOverlay: (items: ShellOverlay | readonly ShellOverlay[]) => () => void = overlays.add;
/** Add a collapsible sidebar panel. Returns its remover. */
export const addSidebarPanel: (items: SidebarPanel | readonly SidebarPanel[]) => () => void = sidebarPanels.add;
/** Add an altbar panel about the current view. Returns its remover. */
export const addAltbarPanel: (items: AltbarPanel | readonly AltbarPanel[]) => () => void = altbarPanels.add;

/**
 * Put `component` in the header spot above the sidebar and main region. There is one
 * spot: a second call replaces the first (and logs a warning). Returns the function that
 * takes it out again, bringing back whatever it replaced.
 */
export function setHeader(component: ShellHeaderComponent): () => void {
  if (headers.get().length > 0) {
    const warn = kernelRef?.log.warn.bind(kernelRef.log) ?? console.warn;
    warn("shell-ui: setHeader called while a header is already set; the new one replaces it");
  }
  return headers.add({ component });
}

/**
 * Put `component` in the footer spot below the sidebar and main region. Like `setHeader`:
 * one spot, a second call replaces the first. While a footer is shown the shell publishes
 * its height as `--shell-footer-height`, so anything fixed to the bottom of the screen
 * can sit above it.
 */
export function setFooter(component: ShellFooterComponent): () => void {
  if (footers.get().length > 0) {
    const warn = kernelRef?.log.warn.bind(kernelRef.log) ?? console.warn;
    warn("shell-ui: setFooter called while a footer is already set; the new one replaces it");
  }
  return footers.add({ component });
}

// ---------------------------------------------------------------------------
// The shell service
// ---------------------------------------------------------------------------

/** `true` below the mobile breakpoint: adapt rather than re-measure. */
export function isCompact(): boolean {
  return state().compact;
}

/** Called with the new `compact` whenever the window crosses the mobile breakpoint. */
export function onLayoutChange(listener: (compact: boolean) => void): Unsubscribe {
  return state().onLayoutChange(listener);
}

/** The current layout; the same object until something in it changes, for `useSyncExternalStore`. */
export function layout(): ShellLayout {
  return state().layout();
}

/** Called after every layout change. */
export function subscribeLayout(listener: () => void): Unsubscribe {
  return state().subscribe(listener);
}

/** The sidebar element's id, for a toggle's `aria-controls`. */
export const sidebarId = SIDEBAR_ID;
/** The altbar element's id, for a toggle's `aria-controls`. */
export const altbarId = ALTBAR_ID;

/** Open or close the drawer (phone), or collapse the column (desktop). No argument toggles. */
export function toggleSidebar(open?: boolean): void {
  state().toggleSidebar(open);
}

/** Open or close the altbar: a column on a wide screen, a drawer on a phone. No argument toggles. */
export function toggleAltbar(open?: boolean): void {
  state().toggleAltbar(open);
}

/** Which main view is showing; the router sets it. */
export function setMainView(id: string, params?: Readonly<Record<string, string>>): void {
  state().setMainView(id, params);
}

export default function activate(kernel: Kernel): void {
  kernelRef = kernel;
  const shellState = new ShellState();
  live = shellState;

  // The one mount (SPEC §6.4). Everything below this line is React reading the
  // registries live: a plugin that adds a panel or a view later — or fails and has its
  // items withdrawn — changes the layout without another mount.
  kernel.ui.mount(<ShellView kernel={kernel} state={shellState} />);
}

export function deactivate(): void {
  live?.dispose();
  live = undefined;
  kernelRef = undefined;
}
