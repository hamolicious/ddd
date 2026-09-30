/**
 * Menus for marked elements (`addAction`).
 *
 * A component marks what it draws (`data-lm-target`, see `_shared/target.ts`); plugins
 * offer actions per target type; this file finds the marked elements under a right-click,
 * a long press or the menu key, and builds one menu from them: the innermost target's
 * items first, then each enclosing target's in its own titled section.
 *
 * **When the browser keeps its own menu.** Shift held; nothing marked; nothing to show;
 * or an editable (a text field, the editor) nearer than the nearest mark. The last keeps
 * copy and paste in the editor while a task checkbox inside it still has its menu.
 */

import type { RegistryEntry } from "@kernel";

import type { ContextAction, MenuItem, MenuRequest, MenuSection } from "./api.js";

import { LONG_PRESS_MS, PRESS_ATTR, markedElements, targetsOf } from "../../_shared/target.js";

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** How far a touch may drift and still be a long press. */
const LONG_PRESS_SLOP = 10;

/**
 * The menu for everything marked at or around `from`, or `undefined` when there is
 * nothing to show. `report` hears an action that threw; the rest of the menu still opens.
 */
export function buildMenu(
  from: Element | null,
  actions: readonly RegistryEntry<ContextAction>[],
  report: (action: RegistryEntry<ContextAction>, error: unknown) => void = () => {},
): Omit<MenuRequest, "anchor"> | undefined {
  const elements = markedElements(from);
  const chain = elements.flatMap(targetsOf);
  const sections: MenuSection[] = [];
  let title: string | undefined;
  // One action per id, the first in list order (the registry already keeps one per id).
  const seen = new Set<string>();
  const unique = actions.filter((entry) => !seen.has(entry.value.id) && seen.add(entry.value.id));
  for (const element of elements) {
    const own = chain.filter((each) => each.element === element);
    // Every type the element is, in one list: a kanban card's own items among a note's.
    const ranked = own
      .flatMap((target) =>
        unique.map((entry, place) => ({ entry, place, target })).filter(({ entry }) => entry.value.target === target.type),
      )
      .sort((a, b) => (a.entry.value.order ?? 0) - (b.entry.value.order ?? 0) || a.place - b.place);
    const items: MenuItem[] = [];
    for (const { entry, target } of ranked) {
      try {
        for (const item of entry.value.items(target, chain)) {
          items.push({ ...item, id: `${entry.value.id}:${item.id}` });
        }
      } catch (error) {
        report(entry, error);
      }
    }
    if (items.length === 0) continue;
    const label = own[0]?.label;
    // The nearest thing with items names the menu; the ones around it name their sections.
    if (sections.length === 0) title = label;
    sections.push({ title: sections.length === 0 ? undefined : label, items });
  }
  if (sections.length === 0) return undefined;
  return { title: title ?? "Actions", sections };
}

/** Whether an editable sits between `from` and the nearest mark, so the browser's menu belongs. */
export function editableFirst(from: Element | null): boolean {
  const editable = from?.closest(EDITABLE);
  if (!editable) return false;
  const [mark] = markedElements(from);
  return !mark || !editable.contains(mark);
}

/** Open a menu for an element, anchored or at the pointer; `false` when there was nothing. */
export type OpenAt = (from: Element, anchor: HTMLElement | null) => boolean;

/**
 * Right-click, long press and the menu key, on the whole document. Returns the teardown.
 * A long press on a `data-lm-press="release"` element opens when the finger lifts, so a
 * card that drags on a long press can still be dragged.
 */
export function listen(openAt: OpenAt): () => void {
  let press: { id: number; x: number; y: number; at: number; from: Element; timer: number | undefined; release: boolean } | undefined;
  let pressOpened = false;
  const cancel = (): void => {
    if (press?.timer !== undefined) clearTimeout(press.timer);
    press = undefined;
  };
  const onContextMenu = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.shiftKey) return;
    // A touch's own contextmenu comes after our long press has already opened the menu.
    if (pressOpened) {
      event.preventDefault();
      return;
    }
    // A card that drags on a long press decides on release, not on the browser's cue.
    if (press?.release) {
      event.preventDefault();
      return;
    }
    // A touch's contextmenu can beat the long-press timer: one menu, not two.
    cancel();
    const from = event.target instanceof Element ? event.target : null;
    if (!from || editableFirst(from)) return;
    if (openAt(from, null)) event.preventDefault();
  };

  const onPointerDown = (event: PointerEvent): void => {
    cancel();
    pressOpened = false;
    if (event.pointerType === "mouse" || !(event.target instanceof Element)) return;
    const from = event.target;
    const [mark] = markedElements(from);
    if (!mark || editableFirst(from)) return;
    const release = mark.getAttribute(PRESS_ATTR) === "release";
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now(), from, timer: undefined, release };
    if (!release) {
      press.timer = window.setTimeout(() => {
        const held = press;
        press = undefined;
        if (held && openAt(held.from, null)) pressOpened = true;
      }, LONG_PRESS_MS);
    }
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!press || event.pointerId !== press.id) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP) cancel();
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!press || event.pointerId !== press.id) return;
    const held = press;
    cancel();
    if (held.release && Date.now() - held.at >= LONG_PRESS_MS && openAt(held.from, null)) pressOpened = true;
  };
  // The click a long press ends in is not a tap on the row.
  const onClick = (event: MouseEvent): void => {
    if (!pressOpened) return;
    pressOpened = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const menuKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
    if (!menuKey || event.defaultPrevented) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || editableFirst(focused)) return;
    const [mark] = markedElements(focused);
    if (mark && openAt(focused, focused)) event.preventDefault();
  };

  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", cancel, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown);
  return () => {
    cancel();
    document.removeEventListener("contextmenu", onContextMenu);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown);
  };
}
