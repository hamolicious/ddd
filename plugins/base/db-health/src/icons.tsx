/**
 * Inline SVG in `currentColor`, so the icons follow the button's text colour (danger red
 * included) in both themes. Decorative: the button carries the name.
 */

import type { ReactElement } from "react";

const common = {
  "aria-hidden": true,
  viewBox: "0 0 24 24",
  width: "1.15em",
  height: "1.15em",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** A bin: delete, or move to the Trash. */
export function TrashIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

/** A magnifier: run a scan. */
export function ScanIcon(): ReactElement {
  return (
    <svg {...common}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </svg>
  );
}

/** Two arrows round: refresh. */
export function RefreshIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M20 11a8 8 0 0 0-14.6-4.5M4 13a8 8 0 0 0 14.6 4.5" />
      <path d="M5 3v4h4M19 21v-4h-4" />
    </svg>
  );
}
