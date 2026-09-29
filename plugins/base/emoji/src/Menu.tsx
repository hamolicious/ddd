/**
 * The shortcode dropdown, drawn from `shell-ui`'s overlay spot. A copy of
 * `fm-autocomplete`'s menu in this plugin's own classes, so the two look and sit alike.
 *
 * Fixed-position at the caret: under it, or above it when the space below is short (a
 * phone's keyboard takes the bottom half, so the visual viewport is what counts). Never
 * wider than the screen. Pointer presses are cancelled before they reach the editor, so
 * choosing with a tap does not take the editor's focus, and with it the menu, away.
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import type { MenuController } from "./controller.js";

const WIDTH = 288;
const MAX_HEIGHT = 264;
const GAP = 4;
const EDGE = 8;

export function EmojiMenu({ controller }: { readonly controller: MenuController }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.state);
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [state?.selected, state?.items]);

  if (!state) return null;

  const viewport = window.visualViewport;
  const width = Math.min(WIDTH, window.innerWidth - 2 * EDGE);
  const height = viewport?.height ?? window.innerHeight;
  const offsetTop = viewport?.offsetTop ?? 0;
  const left = Math.max(EDGE, Math.min(state.rect.left, window.innerWidth - width - EDGE));
  const below = offsetTop + height - state.rect.bottom - GAP - EDGE;
  const above = state.rect.top - offsetTop - GAP - EDGE;
  const placeBelow = below >= Math.min(MAX_HEIGHT, 160) || below >= above;
  const position = placeBelow
    ? { top: state.rect.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) }
    : { bottom: window.innerHeight - state.rect.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) };

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Emoji"
      className="emoji-menu emoji:fixed emoji:z-50 emoji:overflow-y-auto emoji:rounded-lg emoji:border emoji:border-border-strong emoji:bg-bg-raised emoji:p-1 emoji:font-sans emoji:text-text emoji:shadow-2"
      style={{ left, width, ...position }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {state.items.map((item, index) => (
        <div
          key={item.insert}
          role="option"
          aria-selected={index === state.selected}
          className={`emoji:flex emoji:min-h-[calc(var(--lm-tap-target)-8px)] emoji:cursor-pointer emoji:items-center emoji:gap-2 emoji:rounded emoji:px-2 emoji:py-1 ${
            index === state.selected ? "emoji:bg-accent-subtle" : ""
          }`}
          onPointerEnter={() => controller.select(index)}
          onClick={() => controller.choose(index)}
        >
          <span className="emoji:w-6 emoji:shrink-0 emoji:text-center emoji:text-lg" aria-hidden="true">
            {item.emoji}
          </span>
          <span className="emoji:truncate emoji:font-mono emoji:text-sm">{item.insert}</span>
        </div>
      ))}
    </div>
  );
}
