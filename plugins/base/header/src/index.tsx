/**
 * `header` — the top bar, contributed to `shell-ui`'s `shell.header` spot.
 *
 * It owns `navbar.item`: the buttons and widgets other plugins put in the bar ("New
 * document", the search box, the command palette) contribute there and never learn
 * which plugin draws them. Replacing the bar means contributing a `shell.header` with a
 * lower `order` — and, if the replacement keeps `navbar.item`, disabling this plugin so
 * the point has one owner.
 *
 * What lives where:
 *
 * - `Header.tsx` — the row: sidebar toggle, brand, navbar items.
 * - `indicators.tsx` — the sync-status indicator and the notice bell.
 * - `sync-status.ts` — the words the indicator says, pure and unit-tested.
 */

import type { Kernel } from "@kernel";

import {
  POINTS,
  navbarItemShape,
  type NavbarItem,
  type ShellHeader,
} from "../../_shared/points.js";
import type { ShellUiApi } from "../../_shared/shell-api.js";

import { Header } from "./Header.js";

export default function activate(kernel: Kernel): void {
  kernel.extensions.definePoint<NavbarItem>({
    name: POINTS.navbarItem,
    shape: navbarItemShape,
    key: (item) => item.id,
    description: "An item in the top bar.",
  });

  const shell = kernel.services.require<ShellUiApi>("shell-ui");

  kernel.extensions.contribute<ShellHeader>(POINTS.shellHeader, {
    id: "header",
    component: () => <Header kernel={kernel} shell={shell} />,
  });
}
