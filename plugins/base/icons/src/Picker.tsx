import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { IconPickerProps } from "@protocols/lm/icons";

import { loadIndex } from "./data.js";
import { Icon } from "./Icon.js";
import { searchIcons, type IconIndex } from "./search.js";
import { columnsFor, rowWindow } from "./virtual.js";

/** The smallest a cell gets, and every row's height, in pixels. */
const CELL = 40;
/** The grid's tallest: enough rows to browse, short enough to leave the rest of a sheet. */
const VIEWPORT = 240;

const CELL_CLASSES =
  "icons-choice icons:flex icons:h-full icons:min-h-0! icons:min-w-0! icons:cursor-pointer icons:items-center icons:justify-center icons:rounded icons:border icons:border-transparent icons:bg-transparent icons:p-0 icons:text-text icons:hover:border-border icons:hover:bg-bg-subtle icons:focus-visible:outline-2 icons:focus-visible:outline-focus";

/**
 * A search box over every matching icon, in a grid that scrolls through all of them.
 *
 * Virtual: only the rows in view (and a few either side) are in the DOM, so six thousand
 * icons cost what forty do, and only the shards of the icons scrolled past are fetched.
 * Columns follow the grid's width.
 */
export function Picker({ value, onChange, color }: IconPickerProps): ReactElement {
  const [index, setIndex] = useState<IconIndex | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    loadIndex().then(
      (loaded) => {
        if (live) setIndex(loaded);
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // The grid's width sets the columns: measured now, and again whenever it changes.
  const hasGrid = index !== undefined;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasGrid]);

  // A new query starts from the top.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [query]);

  const hits = useMemo(() => (index ? searchIcons(index, query) : []), [index, query]);
  const columns = columnsFor(width, CELL);
  const rows = Math.ceil(hits.length / columns);
  // A short result list gets a short grid; a long one scrolls inside `VIEWPORT`.
  const height = Math.min(VIEWPORT, Math.max(1, rows) * CELL);
  const { first, end } = rowWindow(scrollTop, height, CELL, rows);

  return (
    <div className="icons-picker icons:flex icons:flex-col icons:gap-1.5">
      <div className="icons:flex icons:gap-1">
        <input
          type="search"
          className="icons-search icons:tap-h icons:min-w-0 icons:flex-1 icons:rounded icons:border icons:border-border-strong icons:bg-bg-raised icons:px-1.5 icons:font-sans icons:text-text"
          placeholder={index ? `Search ${index.icons.length.toLocaleString()} icons` : "Search icons"}
          aria-label="Search icons"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {value !== undefined && (
          <button
            type="button"
            className="icons-clear icons:tap-h icons:cursor-pointer icons:rounded icons:border icons:border-border-strong icons:bg-bg-raised icons:px-1.5 icons:font-sans icons:text-text"
            onClick={() => onChange(undefined)}
          >
            No icon
          </button>
        )}
      </div>

      {error !== undefined ? (
        <p className="icons:m-0 icons:text-[0.9em] icons:text-danger" role="alert">
          The icons could not be loaded: {error}
        </p>
      ) : index === undefined ? (
        <p className="icons:m-0 icons:text-[0.9em] icons:text-text-muted" role="status">
          Loading icons…
        </p>
      ) : (
        <>
          <div
            ref={scroller}
            className="icons-grid icons:relative icons:overflow-y-auto icons:overscroll-contain"
            style={{ height, ...(color !== undefined ? { color } : {}) }}
            role="listbox"
            aria-label="Icons"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div style={{ height: rows * CELL, position: "relative" }}>
              {Array.from({ length: end - first }, (_, offset) => {
                const row = first + offset;
                return (
                  <div
                    key={row}
                    className="icons:absolute icons:inset-x-0 icons:grid icons:gap-0.5"
                    style={{ top: row * CELL, height: CELL, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                  >
                    {hits.slice(row * columns, (row + 1) * columns).map((icon, column) => (
                      <button
                        key={icon.name}
                        type="button"
                        role="option"
                        aria-selected={icon.name === value}
                        aria-posinset={row * columns + column + 1}
                        aria-setsize={hits.length}
                        title={icon.name}
                        className={`${CELL_CLASSES}${icon.name === value ? " icons:border-accent! icons:bg-accent-subtle!" : ""}`}
                        onClick={() => onChange(icon.name)}
                      >
                        <Icon name={icon.name} size="1.4em" title={icon.name} />
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          <p className="icons:m-0 icons:text-[0.8em] icons:text-text-muted" role="status">
            {hits.length === 0
              ? `No icon matches “${query}”.`
              : query.trim() === ""
                ? `${hits.length.toLocaleString()} icons`
                : `${hits.length.toLocaleString()} matching`}
          </p>
        </>
      )}
    </div>
  );
}
