import type { RegistryEntry } from "@kernel";

import type { ContextAction, MenuItem, MenuRequest, MenuSection } from "./api.js";

import { LONG_PRESS_MS, PRESS_ATTR, markedElements, targetsOf } from "../../_shared/target.js";

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const LONG_PRESS_SLOP = 10;

export function buildMenu(
  from: Element | null,
  actions: readonly RegistryEntry<ContextAction>[],
  report: (action: RegistryEntry<ContextAction>, error: unknown) => void = () => {},
): Omit<MenuRequest, "anchor"> | undefined {
  const elements = markedElements(from);
  const chain = elements.flatMap(targetsOf);
  const sections: MenuSection[] = [];
  let title: string | undefined;
  const seen = new Set<string>();
  const unique = actions.filter((entry) => !seen.has(entry.value.id) && seen.add(entry.value.id));
  for (const element of elements) {
    const own = chain.filter((each) => each.element === element);
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
    if (sections.length === 0) title = label;
    sections.push({ title: sections.length === 0 ? undefined : label, items });
  }
  if (sections.length === 0) return undefined;
  return { title: title ?? "Actions", sections };
}

export function editableFirst(from: Element | null): boolean {
  const editable = from?.closest(EDITABLE);
  if (!editable) return false;
  const [mark] = markedElements(from);
  return !mark || !editable.contains(mark);
}

export type OpenAt = (from: Element, anchor: HTMLElement | null) => boolean;

export function listen(openAt: OpenAt): () => void {
  let press: { id: number; x: number; y: number; at: number; from: Element; timer: number | undefined; release: boolean } | undefined;
  let pressOpened = false;
  const cancel = (): void => {
    if (press?.timer !== undefined) clearTimeout(press.timer);
    press = undefined;
  };
  const onContextMenu = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.shiftKey) return;
    if (pressOpened) {
      event.preventDefault();
      return;
    }
    if (press?.release) {
      event.preventDefault();
      return;
    }
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
