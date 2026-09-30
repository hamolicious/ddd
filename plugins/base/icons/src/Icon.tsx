import { useEffect, useState, type ReactElement } from "react";

import type { IconProps } from "./api.js";

import { drawingNow, loadDrawing, type IconPath } from "./data.js";

/** `stroke-linecap` → `strokeLinecap`: Tabler's attribute names, as React props. */
const prop = (attribute: string): string =>
  attribute.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

const paths = (drawing: readonly IconPath[]): ReactElement[] =>
  drawing.map((path, key) =>
    typeof path === "string" ? (
      <path key={key} d={path} />
    ) : (
      <path key={key} {...Object.fromEntries(Object.entries(path).map(([name, value]) => [prop(name), value]))} />
    ),
  );

/**
 * One icon, drawn in `currentColor`. Outline icons are strokes and `-filled` ones are
 * fills, the way Tabler's own components draw them. Until its shard arrives it holds its
 * space empty, so rows do not shift when it appears.
 */
export function Icon({ name, size = "1em", className, title }: IconProps): ReactElement {
  const [drawing, setDrawing] = useState(() => drawingNow(name));
  useEffect(() => {
    const now = drawingNow(name);
    setDrawing(now);
    if (now !== undefined) return;
    let live = true;
    loadDrawing(name).then(
      () => {
        if (live) setDrawing(drawingNow(name));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [name]);

  const filled = name.endsWith("-filled");
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(title !== undefined ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      {title !== undefined && <title>{title}</title>}
      {drawing !== undefined && paths(drawing)}
    </svg>
  );
}
