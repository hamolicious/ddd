/**
 * `shell-ui` — the layout skeleton, and the only plugin that takes the kernel's UI
 * mount (SPEC §6.5).
 *
 * It hosts five slot ports and no features: a header spot, a sidebar of panels, one
 * main region that renders whichever `main.view` the router selected, an altbar of
 * panels about that view (opposite the sidebar), and always-mounted overlays (the
 * command palette). Everything visible inside them belongs to somebody else — the top
 * bar itself is the `header` plugin — which is what makes this plugin replaceable: a
 * different shell hosts the same five protocols and nothing else has to change.
 *
 * What lives where:
 *
 * - `state.ts` — the shell's own state (selected view, sidebar, breakpoint), outside
 *   React because the router and `matchMedia` both drive it from outside the tree.
 * - `Shell.tsx` — the layout, the landmarks, the drawer, the error boundaries.
 * - `SidebarToggle.tsx` — the ☰, offered to the header's `start` seat.
 * - `AltbarToggle.tsx` — the altbar's button, in the header's `end` seat.
 * - `resize.ts` — the column widths, clamped and remembered per device.
 */

import { type Kernel } from "@kernel";

import type { AltbarPanel } from "@protocols/lm/altbar.panel";
import type { MainView } from "@protocols/lm/main.view";
import type { NavbarItem } from "@protocols/lm/navbar.item";
import type { Shell as ShellApi } from "@protocols/lm/shell";
import type { ShellHeader } from "@protocols/lm/shell.header";
import type { ShellOverlay } from "@protocols/lm/shell.overlay";
import type { SidebarPanel } from "@protocols/lm/sidebar.panel";

import { AltbarToggle } from "./AltbarToggle.js";
import { ALTBAR_ID, SIDEBAR_ID, Shell, type ShellHosts } from "./Shell.js";
import { SidebarToggle } from "./SidebarToggle.js";
import { ShellState } from "./state.js";

export type { Shell as ShellUiApi } from "@protocols/lm/shell";

export default function activate(kernel: Kernel): ShellApi {
  // The five hosts, each a live list in seat order. `header` is a `seats: 1` port, so
  // its list holds at most the one seated header; the rest are benched by the wiring.
  const hosts: ShellHosts = {
    headers: kernel.ports.collect<ShellHeader>("header"),
    overlays: kernel.ports.collect<ShellOverlay>("overlays"),
    panels: kernel.ports.collect<SidebarPanel>("sidebar"),
    altbar: kernel.ports.collect<AltbarPanel>("altbar"),
    views: kernel.ports.collect<MainView>("views"),
  };

  const state = new ShellState();
  live = state;

  // The one mount (SPEC §6.4). Everything below this line is React reading the hosts
  // live: a plugin that offers a panel or a view later — or fails and has its offers
  // withdrawn — changes the layout without another mount.
  kernel.ui.mount(<Shell kernel={kernel} state={state} hosts={hosts} />);

  // The ☰ is a seat item like any other, so the top bar needs no knowledge of the
  // sidebar. It is simply absent while nothing hosts `lm/navbar.item`.
  kernel.ports.offer<NavbarItem>("sidebar-toggle", {
    id: "shell-ui.sidebar-toggle",
    label: "Sidebar",
    side: "start",
    order: 0,
    component: () => <SidebarToggle state={state} />,
  });
  // Rightmost, mirroring the ☰: each button sits on the side of the column it opens.
  kernel.ports.offer<NavbarItem>("altbar-toggle", {
    id: "shell-ui.altbar-toggle",
    label: "Side panel",
    side: "end",
    order: 2000,
    component: () => <AltbarToggle state={state} />,
  });

  const api: ShellApi = {
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
  kernel.ports.serve("shell", api);
  return api;
}

/** The breakpoint listener `activate` started; the kernel withdraws everything else (§6c). */
let live: ShellState | undefined;

export function deactivate(): void {
  live?.dispose();
  live = undefined;
}
