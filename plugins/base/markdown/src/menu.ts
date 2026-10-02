import { useCallback, useRef } from "react";

import type { ContextAction, MenuItem } from "plugin:context-menu";

const menus = new WeakMap<HTMLElement, () => readonly MenuItem[]>();

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
