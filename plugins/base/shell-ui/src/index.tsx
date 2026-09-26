/**
 * `shell-ui` — the layout skeleton, and the only plugin that takes the kernel's UI
 * mount (SPEC §6.5).
 *
 * It owns four points and no features: a header spot, a sidebar of panels, one main
 * region that renders whichever `main.view` the router selected, and always-mounted
 * overlays (the command palette). Everything visible inside them belongs to somebody
 * else — the top bar itself is the `header` plugin — which is what makes this plugin
 * replaceable: a different shell defines the same four points and nothing else has to
 * change.
 *
 * What lives where:
 *
 * - `state.ts` — the shell's own state (selected view, sidebar, breakpoint), outside
 *   React because the router and `matchMedia` both drive it from outside the tree.
 * - `Shell.tsx` — the layout, the landmarks, the drawer, the error boundaries.
 * - `resize.ts` — the sidebar width, clamped and remembered per device.
 */

import { type Kernel } from "@kernel";

import {
  POINTS,
  mainViewShape,
  shellHeaderShape,
  shellOverlayShape,
  sidebarPanelShape,
  type MainView,
  type ShellHeader,
  type ShellOverlay,
  type SidebarPanel,
} from "../../_shared/points.js";
import type { ShellUiApi } from "../../_shared/shell-api.js";

import { SIDEBAR_ID, Shell } from "./Shell.js";
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
    layout: state.layout,
    subscribeLayout: state.subscribe,
    sidebarId: SIDEBAR_ID,
    toggleSidebar: (open) => state.toggleSidebar(open),
    setMainView: (id, params) => state.setMainView(id, params),
  };
}
