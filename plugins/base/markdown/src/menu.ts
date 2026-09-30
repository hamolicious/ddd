/**
 * The two right-click menus a rendered document has: a task's states (SPEC §6.6) and an
 * embedded attachment's actions (SPEC §3.6).
 *
 * Neither is drawn here. A task checkbox is marked `markdown/task` and an attachment
 * `markdown/attachment` (`_shared/target.ts`), and `context-menu` opens their menus —
 * on a right-click, a long press or the menu key, as a popover on a wide screen and a
 * bottom sheet on a phone. What goes in them depends on the rendered element (which
 * state is current, whether the embed is a preview), so each element registers its
 * items here as it renders, and the two actions `index.tsx` offers read them back.
 */

import { useCallback, useRef } from "react";

import type { ContextAction, MenuItem } from "plugin:context-menu";

const menus = new WeakMap<HTMLElement, () => readonly MenuItem[]>();

/**
 * A ref for the element whose menu `items` is. Read when the menu opens, so the items are
 * the latest render's.
 */
export function useMenuItems<T extends HTMLElement>(items: () => readonly MenuItem[]): (element: T | null) => void {
  const latest = useRef(items);
  latest.current = items;
  return useCallback((element: T | null) => {
    if (element) menus.set(element, () => latest.current());
  }, []);
}

export const MENU_ACTIONS: readonly ContextAction[] = [
  { id: "markdown.task", target: "markdown/task", items: (target) => menus.get(target.element)?.() ?? [] },
  { id: "markdown.attachment", target: "markdown/attachment", items: (target) => menus.get(target.element)?.() ?? [] },
];
