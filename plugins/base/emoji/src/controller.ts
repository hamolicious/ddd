/**
 * The shortcode menu's state machine, over every `text.surface`. The same shape as
 * `fm-autocomplete`'s and `slash-commands`' menus, deliberately, so the three feel alike
 * and never open together (none of them answers what the others do).
 *
 * After every change the text before the caret goes to `suggest.ts`. Keys are taken in the
 * capture phase on the surface's element, only while the menu is open: ↑ / ↓ move, Enter
 * or Tab choose, Escape dismisses until the typed text changes. Until the emoji set has
 * loaded there is nothing to suggest, and the menu stays shut.
 */

import type { Kernel } from "@kernel";

import type { TextSurface } from "@protocols/lm/text.surface";

import type { EmojiSet } from "./emojis.js";
import { suggest, type Suggestion } from "./suggest.js";

export interface MenuState {
  readonly surface: TextSurface;
  /** The caret's line when this was worked out. */
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
  /** Stop watching every surface and take the key listeners off their elements. */
  dispose(): void;
}

export function createController(kernel: Kernel, emojis: () => EmojiSet | undefined): MenuController {
  let current: MenuState | undefined;
  /** Escape was pressed on this text: stay shut until it changes. */
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

  /** Surfaces being watched, and how to stop. Surfaces come and go with editors. */
  const attached = new Map<TextSurface, () => void>();
  // The `surfaces` host: every `text.surface` wired to this plugin, in seat order.
  const unwatch = kernel.ports.collect<TextSurface>("surfaces").subscribe((all) => {
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
