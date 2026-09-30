/**
 * `header` — the top bar, set as `shell-ui`'s header.
 *
 * It exposes two **seats** through `addItem`: `side: "start"` and `side: "end"`, each in
 * `order`. Most of what sits in them is another plugin's (Admin, `notices`' bell,
 * `sync-status`' pill), and none of them learns which plugin draws the bar. Three are
 * the header's own: the ☰ sidebar toggle, the altbar toggle and the settings gear — they
 * drive `shell-ui` and `settings`, which the bar depends on anyway.
 *
 * What lives where:
 *
 * - `api.ts` — `NavbarItem` and the item registry.
 * - `Header.tsx` — the row: the two seats.
 * - `Toggles.tsx` — the ☰ and the altbar button.
 * - `layout.ts` — which seat and position each item gets; pure and unit-tested.
 * - `arrangement.ts` — the user's arrangement, kept in `kernel.settings`.
 * - `BarSettings.tsx` — "Top bar" in Settings, where the arrangement is edited.
 */

import type { Kernel } from "@kernel";
import { addSection, open as openSettings } from "plugin:settings";
import { setHeader } from "plugin:shell-ui";

import { itemRegistry, type NavbarItem } from "./api.js";
import { createArrangementStore } from "./arrangement.js";
import { BarSettings } from "./BarSettings.js";
import { Header } from "./Header.js";
import { AltbarToggle, SidebarToggle } from "./Toggles.js";

export type { NavbarItem } from "./api.js";

/** Put an item (or several) in the top bar. Returns the function that takes it out again. */
export const addItem: (items: NavbarItem | readonly NavbarItem[]) => () => void = itemRegistry.add;

export default function activate(kernel: Kernel): void {
  const store = createArrangementStore(kernel);

  setHeader(() => <Header kernel={kernel} items={itemRegistry} store={store} />);

  // The built-ins keep their old ids, so an arrangement saved before they moved here
  // still places them.
  addItem([
    {
      id: "shell-ui.sidebar-toggle",
      label: "Sidebar",
      side: "start",
      order: 0,
      component: SidebarToggle,
    },
    {
      id: "settings.open",
      label: "Settings",
      icon: "⚙",
      side: "end",
      order: 90,
      onSelect: () => openSettings(),
    },
    // Rightmost, mirroring the ☰: each button sits on the side of the column it opens.
    {
      id: "shell-ui.altbar-toggle",
      label: "Side panel",
      side: "end",
      order: 2000,
      component: AltbarToggle,
    },
  ]);

  addSection({
    id: "header.bar",
    title: "Top bar",
    description: "Reorder the items in the top bar.",
    order: 150,
    component: () => <BarSettings items={itemRegistry} store={store} />,
  });
}
