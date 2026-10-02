import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import type { SlashController } from "./controller.js";

const WIDTH = 288;
const MAX_HEIGHT = 264;
const GAP = 4;
const EDGE = 8;

export function SlashMenu({ controller }: { readonly controller: SlashController }): ReactNode {
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
      aria-label="Commands"
      className="slash-menu slash:fixed slash:z-50 slash:overflow-y-auto slash:rounded-lg slash:border slash:border-border-strong slash:bg-bg-raised slash:p-1 slash:font-sans slash:text-text slash:shadow-2"
      style={{ left, width, ...position }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {state.items.map((command, index) => (
        <div
          key={command.id}
          role="option"
          aria-selected={index === state.selected}
          className={`slash:flex slash:min-h-[calc(var(--ddd-tap-target)-8px)] slash:cursor-pointer slash:items-center slash:gap-2 slash:rounded slash:px-2 slash:py-1 ${
            index === state.selected ? "slash:bg-accent-subtle" : ""
          }`}
          onPointerEnter={() => controller.select(index)}
          onClick={() => controller.choose(index)}
        >
          {command.icon !== undefined ? (
            <span aria-hidden="true" className="slash:flex slash:w-5 slash:shrink-0 slash:justify-center">
              {command.icon}
            </span>
          ) : null}
          <span className="slash:flex slash:min-w-0 slash:flex-col">
            <span className="slash:truncate">{command.title}</span>
            {command.description ? (
              <span className="slash:truncate slash:text-sm slash:text-text-muted">{command.description}</span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
