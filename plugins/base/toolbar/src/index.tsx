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

export const addItem: (items: ToolbarItem | readonly ToolbarItem[]) => () => void = itemRegistry.add;

export default function activate(kernel: Kernel): void {
  const store = createArrangementStore(kernel);

  setHeader(() => <TopBar kernel={kernel} items={itemRegistry} store={store} />);
  setFooter(() => <BottomBar kernel={kernel} items={itemRegistry} store={store} />);

  addItem([
    {
      id: "shell-ui.sidebar-toggle",
      label: "Sidebar",
      side: "start",
      order: 0,
      component: SidebarToggle,
    },
    {
      id: "shell-ui.altbar-toggle",
      label: "Side panel",
      side: "end",
      order: 2000,
      component: AltbarToggle,
    },
  ]);
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
