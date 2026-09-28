/**
 * `sync-status` — the sync pill, in the header's `end` seat.
 *
 * - `SyncIndicator.tsx` — the dot, the unsynced chip and the Retry / Sign in action.
 * - `sync-status.ts` — the words the indicator says, pure and unit-tested.
 */

import type { Kernel } from "@kernel";

import type { NavbarItem } from "@protocols/lm/navbar.item";

import { SyncIndicator } from "./SyncIndicator.js";

export default function activate(kernel: Kernel): void {
  kernel.ports.offer<NavbarItem>("pill", {
    id: "sync-status.pill",
    label: "Sync status",
    side: "end",
    // Default-seat hint: last in the bar, after the notice bell.
    order: 1000,
    component: () => <SyncIndicator kernel={kernel} />,
  });
}
