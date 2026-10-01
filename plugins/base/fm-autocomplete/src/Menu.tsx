/**
 * The suggestion dropdown, drawn from `shell-ui`'s overlay spot. A copy of
 * `slash-commands`' `/` menu in this plugin's own classes, so the two look and sit alike.
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

export function SuggestionMenu({ controller }: { readonly controller: MenuController }): ReactNode {
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
      aria-label="Suggestions"
      className="fm-autocomplete-menu fmac:fixed fmac:z-50 fmac:overflow-y-auto fmac:rounded-lg fmac:border fmac:border-border-strong fmac:bg-bg-raised fmac:p-1 fmac:font-sans fmac:text-text fmac:shadow-2"
      style={{ left, width, ...position }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {state.items.map((item, index) => (
        <div
          key={item.insert}
          role="option"
          aria-selected={index === state.selected}
          className={`fmac:flex fmac:min-h-[calc(var(--ddd-tap-target)-8px)] fmac:cursor-pointer fmac:items-center fmac:gap-2 fmac:rounded fmac:px-2 fmac:py-1 ${
            index === state.selected ? "fmac:bg-accent-subtle" : ""
          }`}
          onPointerEnter={() => controller.select(index)}
          onClick={() => controller.choose(index)}
        >
          <span className="fmac:flex fmac:min-w-0 fmac:flex-col">
            <span className="fmac:truncate">{item.label}</span>
            {item.detail ? (
              <span className="fmac:truncate fmac:text-sm fmac:text-text-muted">{item.detail}</span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
