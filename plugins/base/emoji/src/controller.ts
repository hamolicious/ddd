import type { Unsubscribe } from "@kernel";
import type { TextSurface } from "plugin:editor";

import type { EmojiSet } from "./emojis.js";
import { suggest, type Suggestion } from "./suggest.js";

export interface MenuState {
  readonly surface: TextSurface;
  readonly before: string;
  readonly replace: number;
  readonly items: readonly Suggestion[];
  readonly selected: number;
  readonly rect: { readonly left: number; readonly top: number; readonly bottom: number };
}

export interface MenuController {
  state(): MenuState | undefined;
  subscribe(listener: () => void): () => void;
  choose(index: number): void;
  select(index: number): void;
  dispose(): void;
}

export function createController(
  emojis: () => EmojiSet | undefined,
  watchSurfaces: (listener: (surfaces: readonly TextSurface[]) => void) => Unsubscribe,
): MenuController {
  let current: MenuState | undefined;
  let dismissed: { surface: string; before: string } | undefined;
  const listeners = new Set<() => void>();

  const set = (next: MenuState | undefined): void => {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const evaluate = (surface: TextSurface): void => {
    if (!surface.hasFocus() || !surface.documentBeforeCaret || !surface.replaceBeforeCaret) {
      if (current?.surface === surface) set(undefined);
      return;
    }
    const before = surface.textBeforeCaret();
    if (dismissed && (dismissed.surface !== surface.id || dismissed.before !== before)) dismissed = undefined;
    const loaded = emojis();
    const found = dismissed || !loaded ? undefined : suggest(before, surface.documentBeforeCaret(), loaded);
    const rect = found ? surface.caretRect() : null;
    if (!found || !rect) {
      if (current?.surface === surface || current === undefined) set(undefined);
      return;
    }
    set({ surface, before, replace: found.replace, items: found.items, selected: 0, rect });
  };

  const choose = (index: number): void => {
    const state = current;
    const item = state?.items[index];
    if (!state || !item) return;
    set(undefined);
    state.surface.replaceBeforeCaret?.(state.replace, item.insert);
  };

  const onKey = (surface: TextSurface) => (event: KeyboardEvent): void => {
    const state = current;
    if (!state || state.surface !== surface || event.isComposing) return;
    const count = state.items.length;
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        set({ ...state, selected: (state.selected + 1) % count });
        break;
      case "ArrowUp":
        set({ ...state, selected: (state.selected - 1 + count) % count });
        break;
      case "Enter":
      case "Tab":
        choose(state.selected);
        break;
      case "Escape":
        dismissed = { surface: surface.id, before: surface.textBeforeCaret() };
        set(undefined);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const attached = new Map<TextSurface, () => void>();
  const unwatch = watchSurfaces((all) => {
    for (const [surface, detach] of [...attached]) {
      if (all.includes(surface)) continue;
      detach();
      attached.delete(surface);
      if (current?.surface === surface) set(undefined);
    }
    for (const surface of all) {
      if (attached.has(surface)) continue;
      const key = onKey(surface);
      surface.element.addEventListener("keydown", key, true);
      const off = surface.subscribe(() => evaluate(surface));
      attached.set(surface, () => {
        surface.element.removeEventListener("keydown", key, true);
        off();
      });
    }
  });

  return {
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    choose,
    select: (index) => {
      if (current && index >= 0 && index < current.items.length) set({ ...current, selected: index });
    },
    dispose: () => {
      unwatch();
      for (const detach of attached.values()) detach();
      attached.clear();
      set(undefined);
    },
  };
}
