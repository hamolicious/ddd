/**
 * The admin screens' icons: inline SVG in `currentColor`, so they follow the button's
 * text colour (danger red included) in both themes. Decorative: the button carries the
 * name, as `aria-label` and `title`.
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

/** A key: issue a password reset link. */
export function KeyIcon(): ReactElement {
  return (
    <svg {...common}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
    </svg>
  );
}

/** A bin: delete. */
export function TrashIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}
