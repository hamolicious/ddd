import type { Kernel } from "@kernel";

import { addItem } from "plugin:toolbar";

import { SyncIndicator } from "./SyncIndicator.js";

export default function activate(kernel: Kernel): void {
  addItem({
    id: "sync-status.pill",
    label: "Sync status",
    side: "end",
    order: 1000,
    mobile: { bar: "top" },
    component: () => <SyncIndicator kernel={kernel} />,
  });
}
