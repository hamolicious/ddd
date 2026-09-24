/**
 * `shell-ui` — the layout skeleton, and the only plugin that takes the kernel's UI
 * mount (SPEC §6.5).
 *
 * It owns three points and no features: a navbar, a sidebar of panels, and one main
 * region that renders whichever `main.view` the router selected. Everything visible
 * inside them belongs to somebody else, which is what makes this plugin replaceable —
 * a different shell defines the same three points and nothing else has to change.
 *
 * What lives where:
 *
 * - `state.ts` — the shell's own state (selected view, sidebar, breakpoint), outside
 *   React because the router and `matchMedia` both drive it from outside the tree.
 * - `Shell.tsx` — the layout, the landmarks, the drawer, the error boundaries.
 * - `indicators.tsx` — the sync-status indicator and the notice bell, the two things
 *   the shell renders that nobody contributed.
 * - `sync-status.ts` — the words the indicator says, pure and unit-tested.
 */

import { type Kernel, type Unsubscribe } from "@kernel";

import {
  POINTS,
  mainViewShape,
  navbarItemShape,
  sidebarPanelShape,
  type MainView,
  type NavbarItem,
  type SidebarPanel,
} from "../../_shared/points.js";

import { Shell } from "./Shell.js";
import { ShellState } from "./state.js";

export interface ShellUiApi {
  /** `true` below the mobile breakpoint — dependents adapt rather than re-measure. */
  isCompact(): boolean;
  onLayoutChange(listener: (compact: boolean) => void): Unsubscribe;
  /** Open or close the drawer sidebar (mobile) / collapse it (desktop). */
  toggleSidebar(open?: boolean): void;
  /** Which `main.view` is showing; the router sets it. */
  setMainView(id: string, params?: Readonly<Record<string, string>>): void;
}

export default function activate(kernel: Kernel): ShellUiApi {
  kernel.extensions.definePoint<NavbarItem>({
    name: POINTS.navbarItem,
    shape: navbarItemShape,
    key: (item) => item.id,
    description: "An item in the navigation bar.",
  });
  kernel.extensions.definePoint<SidebarPanel>({
    name: POINTS.sidebarPanel,
    shape: sidebarPanelShape,
    key: (panel) => panel.id,
    description: "A collapsible panel in the sidebar.",
  });
  kernel.extensions.definePoint<MainView>({
    name: POINTS.mainView,
    shape: mainViewShape,
    key: (view) => view.id,
    description: "A full-pane view, addressed by id and selected by the router.",
  });

  const state = new ShellState();

  // The one mount (SPEC §6.4). Everything below this line is React reading the
  // registry live: a plugin that contributes a panel or a view later — or fails and
  // has its contributions withdrawn — changes the layout without another mount.
  kernel.ui.mount(<Shell kernel={kernel} state={state} />);

  return {
    isCompact: () => state.compact,
    onLayoutChange: (listener) => state.onLayoutChange(listener),
    toggleSidebar: (open) => state.toggleSidebar(open),
    setMainView: (id, params) => state.setMainView(id, params),
  };
}
