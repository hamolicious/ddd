/**
 * `toolbar` — the bars around the app, set as `shell-ui`'s header and footer.
 *
 * On desktop, a header along the top and a slim IDE-style status bar along the bottom;
 * on a phone, a thin bar along the top and a row of big icon buttons along the bottom,
 * within thumb reach. Each is a set of **seats** filled through `addItem`: an item says
 * which bar and side it would like (`bar`, `side`, and `mobile` for a phone), and the
 * user's layout — one per kind of device — overrides that.
 *
 * Most of what sits in the bars is another plugin's (Admin, `notices`' bell,
 * `sync-status`' pill), and none of them learns which plugin draws the bars. Three are the
 * toolbar's own: the ☰ sidebar toggle, the altbar toggle and the settings gear — they
 * drive `shell-ui` and `settings`, which the toolbar depends on anyway.
 *
 * What lives where:
 *
 * - `api.ts` — `ToolbarItem` and the item registry.
 * - `Bars.tsx` — the top and bottom bars: their seats, per profile.
 * - `Toggles.tsx` — the ☰ and the altbar button.
 * - `layout.ts` — the profiles, their seats, and which seat and position each item
 *   gets; pure and unit-tested.
 * - `arrangement.ts` — the user's layouts, kept in `kernel.settings`.
 * - `BarSettings.tsx` — "Toolbar" in Settings: a tab per device, where the layouts are edited.
 */

import type { Kernel } from "@kernel";
import { addSection, open as openSettings } from "plugin:settings";
import { setFooter, setHeader } from "plugin:shell-ui";

import { itemRegistry, type ToolbarItem } from "./api.js";
import { createArrangementStore } from "./arrangement.js";
import { BarSettings } from "./BarSettings.js";
import { BottomBar, TopBar } from "./Bars.js";
import { AltbarToggle, SidebarToggle } from "./Toggles.js";

export type { Bar, NavbarItem, Placement, Side, ToolbarItem } from "./api.js";

type IconsModule = typeof import("plugin:icons");

/** Put an item (or several) in the toolbar. Returns the function that takes it out again. */
export const addItem: (items: ToolbarItem | readonly ToolbarItem[]) => () => void = itemRegistry.add;

export default function activate(kernel: Kernel): void {
  const store = createArrangementStore(kernel);

  setHeader(() => <TopBar kernel={kernel} items={itemRegistry} store={store} />);
  setFooter(() => <BottomBar kernel={kernel} items={itemRegistry} store={store} />);

  // The built-ins keep their old ids from when they were `shell-ui`'s and `settings`'.
  // On a phone all three default to the bottom toolbar.
  addItem([
    {
      id: "shell-ui.sidebar-toggle",
      label: "Sidebar",
      side: "start",
      order: 0,
      component: SidebarToggle,
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
  // The gear is `icons`' when that plugin is installed (an optional dependency, already
  // active by now when present), a plain glyph otherwise.
  void kernel.plugins
    .optional<IconsModule>("icons")
    .catch(() => undefined)
    .then((icons) =>
      addItem({
        id: "settings.open",
        label: "Settings",
        icon: icons ? <icons.Icon name="settings" /> : "⚙",
        side: "end",
        order: 90,
        onSelect: () => openSettings(),
      }),
    );

  addSection({
    id: "toolbar.layout",
    title: "Toolbar",
    description: "Arrange the top and bottom bars, separately for desktop and phone.",
    order: 150,
    component: () => <BarSettings items={itemRegistry} store={store} />,
  });
}
