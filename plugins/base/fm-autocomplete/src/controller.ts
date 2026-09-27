/**
 * The suggestion menu's state machine, over every `text.surface`.
 *
 * Each surface is watched through its own `subscribe`: after every change the text before
 * the caret is handed to `suggest.ts` (keys, or the typed key's values), and the menu
 * opens, narrows or closes. Keys are
 * taken in the capture phase on the surface's element, before the editor sees them, and
 * only while the menu is open: ↑ / ↓ move, Enter or Tab choose, Escape dismisses until
 * the typed text changes. The same shape as `slash-commands`' `/` menu, deliberately: the
 * two never open together (a `/word` is not a value anyone has), and they feel the same.
 *
 * A surface that does not offer `documentBeforeCaret` and `replaceBeforeCaret` gets no
 * suggestions — without the first there is no telling the frontmatter from the body.
 */

import type { Kernel } from "@kernel";

import type { IndexerApi } from "../../_shared/indexer-api.js";
import { POINTS, type TextSurface } from "../../_shared/points.js";
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
}

export function createController(kernel: Kernel, indexer: IndexerApi): MenuController {
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
    const found = dismissed ? undefined : suggest(before, surface.documentBeforeCaret(), {
          fmFields: () => indexer.fmFields({ exclude: surface.documentId }),
          fmValues: (key) => indexer.fmValues(key, { exclude: surface.documentId }),
        });
    const rect = found ? surface.caretRect() : null;
    if (!found || !rect) {
      if (current?.surface === surface || current === undefined) set(undefined);
      return;
    }
    // Typing puts the best match first and selects it; a refresh under unchanged text (the
    // index moved) keeps whatever was selected.
    const same = current?.surface === surface && current.before === before;
    const was = same ? current?.items[current.selected]?.insert : undefined;
    const keep = was === undefined ? -1 : found.items.findIndex((item) => item.insert === was);
    set({ surface, before, replace: found.replace, items: found.items, selected: Math.max(keep, 0), rect });
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
  kernel.extensions.subscribe<TextSurface>(POINTS.textSurface, (all) => {
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

  // The values change under an open menu when another note is edited, or this one's row
  // catches up with what was just typed.
  indexer.subscribe(() => {
    if (current) evaluate(current.surface);
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
  };
}
