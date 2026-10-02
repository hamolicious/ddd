import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import type { MenuController } from "./controller.js";

const WIDTH = 320;
const MAX_HEIGHT = 264;
const GAP = 4;
const EDGE = 8;

export function NoteMenu({ controller }: { readonly controller: MenuController }): ReactNode {
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
      aria-label={state.embed ? "Embed a note" : "Link a note"}
      className="wikilinks-menu wikilinks:fixed wikilinks:z-50 wikilinks:overflow-y-auto wikilinks:rounded-lg wikilinks:border wikilinks:border-border-strong wikilinks:bg-bg-raised wikilinks:p-1 wikilinks:font-sans wikilinks:text-text wikilinks:shadow-2"
      style={{ left, width, ...position }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {state.items.map((item, index) => (
        <div
          key={item.id}
          role="option"
          aria-selected={index === state.selected}
          className={`wikilinks:flex wikilinks:min-h-[calc(var(--ddd-tap-target)-8px)] wikilinks:cursor-pointer wikilinks:flex-col wikilinks:justify-center wikilinks:rounded wikilinks:px-2 wikilinks:py-1 ${
            index === state.selected ? "wikilinks:bg-accent-subtle" : ""
          }`}
          onPointerEnter={() => controller.select(index)}
          onClick={() => controller.choose(index)}
        >
          <span className="wikilinks:truncate wikilinks:text-sm">{item.title}</span>
          {item.folder !== "" && (
            <span className="wikilinks:truncate wikilinks:text-xs wikilinks:text-text-muted">{item.folder}</span>
          )}
        </div>
      ))}
    </div>
  );
}
