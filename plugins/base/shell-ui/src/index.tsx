/**
 * `shell-ui` — the layout skeleton, and the only plugin that takes the kernel's UI
 * mount (SPEC §6.5).
 *
 * It owns five points and no features: a header spot, a sidebar of panels, one main
 * region that renders whichever `main.view` the router selected, an altbar of panels
 * about that view (opposite the sidebar), and always-mounted overlays (the command
 * palette). Everything visible inside them belongs to somebody
 * else — the top bar itself is the `header` plugin — which is what makes this plugin
 * replaceable: a different shell defines the same five points and nothing else has to
 * change.
 *
 * What lives where:
 *
 * - `state.ts` — the shell's own state (selected view, sidebar, breakpoint), outside
 *   React because the router and `matchMedia` both drive it from outside the tree.
 * - `Shell.tsx` — the layout, the landmarks, the drawer, the error boundaries.
 * - `SidebarToggle.tsx` — the ☰, contributed to the header's `start` seat.
 * - `AltbarToggle.tsx` — the altbar's button, in the header's `end` seat.
 * - `resize.ts` — the column widths, clamped and remembered per device.
 */

import { type Kernel } from "@kernel";

import {
  POINTS,
  altbarPanelShape,
  mainViewShape,
  shellHeaderShape,
  shellOverlayShape,
  sidebarPanelShape,
  type AltbarPanel,
  type MainView,
  type NavbarItem,
  type ShellHeader,
  type ShellOverlay,
  type SidebarPanel,
} from "../../_shared/points.js";
import type { ShellUiApi } from "../../_shared/shell-api.js";

import { AltbarToggle } from "./AltbarToggle.js";
import { ALTBAR_ID, SIDEBAR_ID, Shell } from "./Shell.js";
import { SidebarToggle } from "./SidebarToggle.js";
import { ShellState } from "./state.js";

export type { ShellUiApi } from "../../_shared/shell-api.js";

export default function activate(kernel: Kernel): ShellUiApi {
  kernel.extensions.definePoint<ShellHeader>({
    name: POINTS.shellHeader,
    shape: shellHeaderShape,
    key: (header) => header.id,
    description: "The row above the sidebar and main region; the lowest order is rendered.",
  });
  kernel.extensions.definePoint<ShellOverlay>({
    name: POINTS.shellOverlay,
    shape: shellOverlayShape,
    key: (overlay) => overlay.id,
    description: "An always-mounted component outside the layout (a palette, a toast stack).",
  });
  kernel.extensions.definePoint<SidebarPanel>({
    name: POINTS.sidebarPanel,
    shape: sidebarPanelShape,
    key: (panel) => panel.id,
    description: "A collapsible panel in the sidebar.",
  });
  kernel.extensions.definePoint<AltbarPanel>({
    name: POINTS.altbarPanel,
    shape: altbarPanelShape,
    key: (panel) => panel.id,
    description: "A collapsible panel in the altbar, opposite the sidebar, about the current view.",
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

  // The ☰ is a seat item like any other, so the top bar needs no knowledge of the
  // sidebar. It buffers until `header` defines the point, and is simply absent without it.
  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "shell-ui.sidebar-toggle",
    label: "Sidebar",
    side: "start",
    order: 0,
    component: () => <SidebarToggle state={state} />,
  });
  // Rightmost, mirroring the ☰: each button sits on the side of the column it opens.
  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "shell-ui.altbar-toggle",
    label: "Side panel",
    side: "end",
    order: 2000,
    component: () => <AltbarToggle state={state} />,
  });

  return {
    isCompact: () => state.compact,
    onLayoutChange: (listener) => state.onLayoutChange(listener),
    layout: state.layout,
    subscribeLayout: state.subscribe,
    sidebarId: SIDEBAR_ID,
    toggleSidebar: (open) => state.toggleSidebar(open),
    altbarId: ALTBAR_ID,
    toggleAltbar: (open) => state.toggleAltbar(open),
    setMainView: (id, params) => state.setMainView(id, params),
  };
}
