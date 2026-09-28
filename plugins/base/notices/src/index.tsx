/**
 * `notices` — the notice bell, in the header's `end` seat.
 *
 * - `NoticeBell.tsx` — the bell, its count badge and the panel it opens.
 */

import type { Kernel } from "@kernel";

import type { NavbarItem } from "@protocols/lm/navbar.item";

import { NoticeBell } from "./NoticeBell.js";

export default function activate(kernel: Kernel): void {
  kernel.ports.offer<NavbarItem>("bell", {
    id: "notices.bell",
    label: "Notices",
    side: "end",
    // Default-seat hint: after every other end item, the bell and the sync pill close
    // the bar. The wiring's seat order is what the header reads.
    order: 900,
    component: () => <NoticeBell kernel={kernel} />,
  });
}
