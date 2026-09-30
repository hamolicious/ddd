/**
 * The `/` menu's state machine, over every text surface (`plugin:editor`).
 *
 * Each surface is watched through its own `subscribe`: after every change the text before
 * the caret is checked for `/word` (`match.ts`), and the menu opens, narrows or closes.
 * Keys are taken in the capture phase on the surface's element, before the editor sees
 * them, and only while the menu is open: ↑ / ↓ move, Enter or Tab choose, Escape
 * dismisses until the typed trigger changes.
 *
 * Choosing removes the typed `/word` first, then runs the command with a mark at that
 * spot, still inside the key press or tap, so a command may open a file picker.
 */

import type { Kernel, Unsubscribe } from "@kernel";
import type { TextSurface } from "plugin:editor";

import type { SlashCommand } from "./api.js";

import { matchCommands, slashQuery } from "./match.js";

export interface MenuState {
  readonly surface: TextSurface;
  readonly query: string;
  readonly items: readonly SlashCommand[];
  readonly selected: number;
  readonly rect: { readonly left: number; readonly top: number; readonly bottom: number };
}

export interface SlashController {
  state(): MenuState | undefined;
  subscribe(listener: () => void): () => void;
  choose(index: number): void;
  select(index: number): void;
  close(): void;
  /** Stop watching every surface and take the key listeners off their elements. */
  dispose(): void;
}

export function createController(
  kernel: Kernel,
  watchSurfaces: (listener: (surfaces: readonly TextSurface[]) => void) => Unsubscribe,
  commands: () => readonly SlashCommand[],
): SlashController {
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
    if (!surface.hasFocus()) {
      if (current?.surface === surface) set(undefined);
      return;
    }
    const before = surface.textBeforeCaret();
    const query = slashQuery(before);
    if (dismissed && (dismissed.surface !== surface.id || dismissed.before !== before)) dismissed = undefined;
    const rect = query === undefined || dismissed ? null : surface.caretRect();
    const items = rect ? matchCommands(commands(), query ?? "", surface.documentId) : [];
    if (!rect || items.length === 0) {
      if (current?.surface === surface || current === undefined) set(undefined);
      return;
    }
    const keep = current?.surface === surface ? items.indexOf(current.items[current.selected]!) : -1;
    set({ surface, query: query ?? "", items, selected: Math.max(keep, 0), rect });
  };

  const choose = (index: number): void => {
    const state = current;
    const command = state?.items[index];
    if (!state || !command) return;
    set(undefined);
    const mark = state.surface.takeBeforeCaret(state.query.length + 1);
    try {
      command.run({ documentId: state.surface.documentId, mark, focus: () => state.surface.focus() });
    } catch (error) {
      kernel.log.error(`slash command "${command.id}" failed`, error);
      kernel.ui.notify({
        id: `slash.failed.${command.id}`,
        level: "error",
        message: `"${command.title}" failed.`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
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
    close: () => set(undefined),
    dispose: () => {
      unwatch();
      for (const detach of attached.values()) detach();
      attached.clear();
      set(undefined);
    },
  };
}
