/**
 * `header` — the top bar, offered to `shell-ui`'s `shell.header` seat.
 *
 * It draws nothing of its own and exposes two **seats** through its `items` port
 * (`lm/navbar.item`): `side: "start"` and `side: "end"`, in the wiring's seat order.
 * Everything in them is another plugin's (`shell-ui`'s ☰, Settings, Admin, `notices`'
 * bell, `sync-status`' pill), and none of them learns which plugin draws the bar.
 * Replacing the bar means wiring another `lm/shell.header` into `shell-ui`'s single
 * header seat — and, if the replacement hosts `lm/navbar.item` too, rewiring the items
 * to it.
 *
 * What lives where:
 *
 * - `Header.tsx` — the row: the two seats.
 * - `layout.ts` — which seat and position each item gets; pure and unit-tested.
 * - `arrangement.ts` — the user's arrangement, kept in `kernel.settings`.
 * - `BarSettings.tsx` — "Top bar" in Settings, where the arrangement is edited.
 */

import type { Kernel } from "@kernel";

import type { NavbarItem } from "@protocols/lm/navbar.item";
import type { SettingsSection } from "@protocols/lm/settings.section";
import type { ShellHeader } from "@protocols/lm/shell.header";

import { createArrangementStore } from "./arrangement.js";
import { BarSettings } from "./BarSettings.js";
import { Header } from "./Header.js";

export default function activate(kernel: Kernel): void {
  // The items host, in seat order: the workspace default that Settings → Top bar lets
  // each person rearrange on top of (PLUGIN-PROTOCOLS §6a).
  const items = kernel.ports.collect<NavbarItem>("items");

  const store = createArrangementStore(kernel);

  kernel.ports.offer<ShellHeader>("bar", {
    id: "header",
    component: () => <Header kernel={kernel} items={items} store={store} />,
  });

  kernel.ports.offer<SettingsSection>("settings", {
    id: "header.bar",
    title: "Top bar",
    description: "Reorder the items in the top bar.",
    order: 150,
    component: () => <BarSettings items={items} store={store} />,
  });
}
