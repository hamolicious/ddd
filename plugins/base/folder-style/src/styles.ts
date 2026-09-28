/**
 * Folder looks as they are stored: pure, so tested without a kernel.
 *
 * Settings values are flat (`kernel/src/runtime/settings.ts`), so each folder is one line
 * of the `styles` list: `<background> <icon> <path>`, with `-` for "none". The path goes
 * last because it is the only part that may hold a space. `#e03131 briefcase work/clients`.
 *
 * Only the background is stored. The text on it is black or white, whichever reads
 * better (`textOn`), so it is worked out rather than chosen.
 */

import type { FolderMoved } from "@protocols/lm/folders.moved";

export interface FolderStyle {
  /** `#rrggbb`, lower case. */
  readonly background?: string;
  /** An `lm/icons` name. */
  readonly icon?: string;
}

export type Styles = ReadonlyMap<string, FolderStyle>;

/** `#abc`, `#AABBCC` and `aabbcc` → `#aabbcc`; anything else → `undefined`. */
export function normalizeColor(input: string | undefined): string | undefined {
  const hex = (input ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map((digit) => digit + digit).join("")}`;
  return undefined;
}

const ICON = /^[a-z0-9][a-z0-9-]*$/;

/** The stored list; lines that do not parse are dropped, a later line for a path wins. */
export function parseStyles(value: unknown): Styles {
  const styles = new Map<string, FolderStyle>();
  if (!Array.isArray(value)) return styles;
  for (const line of value) {
    if (typeof line !== "string") continue;
    const match = /^(\S+) (\S+) (.+)$/.exec(line);
    if (!match) continue;
    const [, rawBackground = "-", rawIcon = "-", path = ""] = match;
    const background = rawBackground === "-" ? undefined : normalizeColor(rawBackground);
    const icon = rawIcon !== "-" && ICON.test(rawIcon) ? rawIcon : undefined;
    const style = withStyle(undefined, { background, icon });
    if (style) styles.set(path, style);
    else styles.delete(path);
  }
  return styles;
}

export function serializeStyles(styles: Styles): string[] {
  return [...styles]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, style]) => `${style.background ?? "-"} ${style.icon ?? "-"} ${path}`);
}

/** `base` with `change` laid over it; a field set to `undefined` is cleared. `undefined` when nothing is left. */
export function withStyle(
  base: FolderStyle | undefined,
  change: { readonly background?: string | undefined; readonly icon?: string | undefined },
): FolderStyle | undefined {
  const background = "background" in change ? change.background : base?.background;
  const icon = "icon" in change ? change.icon : base?.icon;
  if (background === undefined && icon === undefined) return undefined;
  return {
    ...(background !== undefined ? { background } : {}),
    ...(icon !== undefined ? { icon } : {}),
  };
}

/** WCAG 2 relative luminance of a `#rrggbb` colour: 0 for black, 1 for white. */
function luminance(hex: string): number {
  const channel = (at: number): number => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Black or white, whichever has more contrast on `background`; white on a tie. */
export function textOn(background: string): "#000000" | "#ffffff" {
  return contrast(background, "#000000") > contrast(background, "#ffffff") ? "#000000" : "#ffffff";
}

const join = (parent: string, rest: string): string =>
  parent === "" ? rest : rest === "" ? parent : `${parent}/${rest}`;

/** `path` relative to `folder` when it is that folder or inside it (`""` for the folder itself). */
const within = (path: string, folder: string): string | undefined =>
  path === folder ? "" : path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : undefined;

/**
 * The looks after a folder moved (`lm/folders.moved`): a rename carries the folder's look
 * and its subfolders' with it; a delete drops the folder's own, and either carries its
 * subfolders' up to `contentsTo` or drops them with the contents. A look moved onto a
 * folder that already had one replaces it: it is the one the person just moved there.
 */
export function followMove(styles: Styles, event: FolderMoved): Styles {
  const next = new Map<string, FolderStyle>();
  const moved: [string, FolderStyle][] = [];
  for (const [path, style] of styles) {
    const rest = within(path, event.from);
    if (rest === undefined) next.set(path, style);
    else if (event.to !== undefined) moved.push([join(event.to, rest), style]);
    else if (rest !== "" && event.contentsTo !== undefined) moved.push([join(event.contentsTo, rest), style]);
  }
  for (const [path, style] of moved) if (path !== "") next.set(path, style);
  return next;
}

export function sameStyles(a: Styles, b: Styles): boolean {
  if (a.size !== b.size) return false;
  for (const [path, style] of a) {
    const other = b.get(path);
    if (other?.background !== style.background || other?.icon !== style.icon) return false;
  }
  return true;
}
