/**
 * `notices` — the notice bell, in the header's `end` seat.
 *
 * - `NoticeBell.tsx` — the bell, its count badge and the panel it opens.
 */

import type { Kernel } from "@kernel";

import { addItem } from "plugin:toolbar";

import { NoticeBell } from "./NoticeBell.js";

export default function activate(kernel: Kernel): void {
  addItem({
    id: "notices.bell",
    label: "Notices",
    side: "end",
    // After every other end item: the bell and the sync pill close the bar.
    order: 900,
    // On a phone, up in the thin top bar: a status, not something to tap all day.
    mobile: { bar: "top" },
    component: () => <NoticeBell kernel={kernel} />,
  });
}
