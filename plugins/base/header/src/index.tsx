/**
 * `header` — the top bar, contributed to `shell-ui`'s `shell.header` spot.
 *
 * It draws only the frame — the sidebar toggle — and exposes two **seats**
 * through the `navbar.item` point: `side: "start"` and `side: "end"`, sorted by `order`.
 * Everything in them is another plugin's (Settings, Admin, `notices`' bell,
 * `sync-status`' pill), and none of them learns which plugin draws the bar. Replacing
 * the bar means contributing a `shell.header` with a lower `order` — and, if the
 * replacement keeps `navbar.item`, disabling this plugin so the point has one owner.
 *
 * What lives where:
 *
 * - `Header.tsx` — the row: sidebar toggle, the two seats.
 * - `layout.ts` — which seat and position each item gets; pure and unit-tested.
 * - `arrangement.ts` — the user's arrangement, kept in `kernel.settings`.
 * - `BarSettings.tsx` — "Top bar" in Settings, where the arrangement is edited.
 */

import type { Kernel } from "@kernel";

import {
  POINTS,
  navbarItemShape,
  type NavbarItem,
  type SettingsSection,
  type ShellHeader,
} from "../../_shared/points.js";
import type { ShellUiApi } from "../../_shared/shell-api.js";

import { createArrangementStore } from "./arrangement.js";
import { BarSettings } from "./BarSettings.js";
import { Header } from "./Header.js";

export default function activate(kernel: Kernel): void {
  kernel.extensions.definePoint<NavbarItem>({
    name: POINTS.navbarItem,
    shape: navbarItemShape,
    key: (item) => item.id,
    description: "An item in the top bar.",
  });

  const shell = kernel.services.require<ShellUiApi>("shell-ui");
  const store = createArrangementStore(kernel);

  kernel.extensions.contribute<ShellHeader>(POINTS.shellHeader, {
    id: "header",
    component: () => <Header kernel={kernel} shell={shell} store={store} />,
  });

  kernel.extensions.contribute<SettingsSection>(POINTS.settingsSection, {
    id: "header.bar",
    title: "Top bar",
    description: "Reorder the items in the top bar.",
    order: 150,
    component: () => <BarSettings kernel={kernel} store={store} />,
  });
}
