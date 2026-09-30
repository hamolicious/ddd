/**
 * `sync-status` — the sync pill, in the header's `end` seat.
 *
 * - `SyncIndicator.tsx` — the dot, the unsynced chip and the Retry / Sign in action.
 * - `sync-status.ts` — the words the indicator says, pure and unit-tested.
 */

import type { Kernel } from "@kernel";

import { addItem } from "plugin:toolbar";

import { SyncIndicator } from "./SyncIndicator.js";

export default function activate(kernel: Kernel): void {
  addItem({
    id: "sync-status.pill",
    label: "Sync status",
    side: "end",
    // Last in the bar, after the notice bell.
    order: 1000,
    // On a phone, up in the thin top bar: a status, not something to tap all day.
    mobile: { bar: "top" },
    component: () => <SyncIndicator kernel={kernel} />,
  });
}
