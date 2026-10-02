import type { Kernel } from "@kernel";

import { addItem } from "plugin:toolbar";

import { NoticeBell } from "./NoticeBell.js";

export default function activate(kernel: Kernel): void {
  addItem({
    id: "notices.bell",
    label: "Notices",
    side: "end",
    order: 900,
    mobile: { bar: "top" },
    component: () => <NoticeBell kernel={kernel} />,
  });
}
