/**
 * A virtual list: only the rows on screen, and a few either side, are in the DOM. The
 * rest of the list is padding on the element that holds the rows, so the scrollbar,
 * `scrollIntoView` and anything laid out after the list see its real height.
 *
 * **It scrolls whatever already scrolls.** The list does not get a scroller of its own:
 * the nearest scrolling ancestor (the sidebar, the main view, or the window) is the
 * viewport, so a virtual list drops into a layout without changing it.
 *
 * **Rows may be any height.** Each drawn row is measured (`ResizeObserver`) and the size
 * kept by key, so a row that grows (a search snippet, a wrapped title, the compact
 * layout's tap targets) moves the rows after it. A row not measured yet is guessed at the
 * average of those that were, or `estimate` before any were. When a guess above the
 * viewport turns out wrong, the browser's scroll anchoring keeps what is on screen still.
 *
 * The contract for the caller:
 * - the element given to `listRef` holds the rows as its **direct children**, each with
 *   `data-virtual-index={index}`, and a React key equal to `keyOf(index)`;
 * - rows have no vertical margin, and the list no `gap` (both are invisible to the
 *   measurement);
 * - `style={{ paddingTop: before, paddingBottom: after }}` goes on the list element.
 *
 * `useFitToScreen` is its companion for a list that scrolls in a box of its own: it sizes
 * the box to the room its scrolling ancestor has left, so the box ends at the bottom of
 * the screen and everything around it stays in view.
 *
 * The arithmetic is pure and exported, so it is tested without a browser.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The rows to draw: `first` up to, not including, `end`. */
export interface RowSpan {
  readonly first: number;
  readonly end: number;
}

/** Where each row starts: `starts[i]` for row `i`, and `starts[count]` is the total height. */
export function layoutRows(count: number, sizeOf: (index: number) => number): Float64Array {
  const starts = new Float64Array(Math.max(0, count) + 1);
  for (let index = 0; index < count; index += 1) {
    starts[index + 1] = (starts[index] as number) + Math.max(0, sizeOf(index));
  }
  return starts;
}

/** The row whose box holds `y`, clamped to the list. */
export function rowAt(starts: Float64Array, y: number): number {
  const count = starts.length - 1;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= y) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/**
 * The rows overlapping `top`..`bottom` (in the list's own pixels, `0` at its first row),
 * plus `overscan` rows either side so a fast scroll does not show blank space before
 * React catches up. Empty when the list is nowhere near the viewport.
 */
export function rowSpan(starts: Float64Array, top: number, bottom: number, overscan: number): RowSpan {
  const count = starts.length - 1;
  const total = starts[count] as number;
  const from = Math.max(0, top);
  const to = Math.min(total, bottom);
  if (count <= 0 || to <= from) {
    const at = count > 0 && from >= total ? count : 0;
    return { first: at, end: at };
  }
  const first = Math.max(0, rowAt(starts, from) - overscan);
  const end = Math.min(count, rowAt(starts, to - 0.5) + 1 + overscan);
  return { first, end };
}

/**
 * How far to scroll so a row from `start` to `end` is in the viewport `top`..`bottom`,
 * moving as little as possible; `0` when it already is. A row taller than the viewport
 * lines its top up with the viewport's.
 */
export function scrollDelta(start: number, end: number, top: number, bottom: number): number {
  if (start < top) return start - top;
  if (end > bottom) return Math.min(end - bottom, start - top);
  return 0;
}

export interface VirtualListOptions {
  /** How many rows the list has. */
  readonly count: number;
  /** A stable identity for row `index`: its measured height is kept under it. */
  readonly keyOf: (index: number) => string;
  /** A row's height, in pixels, before any row has been measured. */
  readonly estimate: number;
  /** Rows drawn beyond each edge of the viewport; 6 by default. */
  readonly overscan?: number;
}

export interface VirtualList {
  /** The rows to draw, `first` up to (not including) `end`. */
  readonly first: number;
  readonly end: number;
  /** The height of the rows not drawn above and below: the list's padding. */
  readonly before: number;
  readonly after: number;
  /** The element that holds the rows. */
  readonly listRef: (element: HTMLElement | null) => void;
  /** Bring row `index` into view, scrolling as little as possible. */
  readonly scrollToIndex: (index: number) => void;
}

interface Viewport {
  readonly top: number;
  readonly bottom: number;
}

/** The nearest ancestor that scrolls vertically; `undefined` means the window does. */
function scrollParentOf(element: HTMLElement): HTMLElement | undefined {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return parent;
  }
  return undefined;
}

/** The part of the screen `list` can be seen through, in the list's own pixels. */
function viewportOf(list: HTMLElement, scroller: HTMLElement | undefined): Viewport {
  const listTop = list.getBoundingClientRect().top;
  let top = 0;
  let bottom = window.innerHeight;
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    top = Math.max(top, box.top + scroller.clientTop);
    bottom = Math.min(bottom, box.top + scroller.clientTop + scroller.clientHeight);
  }
  return { top: top - listTop, bottom: bottom - listTop };
}

function scrollBy(scroller: HTMLElement | undefined, delta: number): void {
  if (delta === 0) return;
  if (scroller) scroller.scrollTop += delta;
  else window.scrollBy(0, delta);
}

export function useVirtualList({ count, keyOf, estimate, overscan = 6 }: VirtualListOptions): VirtualList {
  const [list, setList] = useState<HTMLElement | null>(null);
  const scroller = useRef<HTMLElement | undefined>(undefined);

  // Measured heights, by key, and their running mean for the rows not measured yet.
  const sizes = useRef(new Map<string, number>());
  const measured = useRef({ sum: 0, count: 0 });
  const [, setVersion] = useState(0);

  const guess = measured.current.count > 0 ? measured.current.sum / measured.current.count : estimate;
  const starts = layoutRows(count, (index) => sizes.current.get(keyOf(index)) ?? guess);
  const latest = useRef({ starts, overscan });
  latest.current = { starts, overscan };

  // Before the first layout there is no viewport to read: a screenful from the top.
  const [span, setSpan] = useState<RowSpan>(() => ({
    first: 0,
    end: Math.min(count, Math.ceil((typeof window === "undefined" ? 800 : window.innerHeight) / estimate) + overscan),
  }));

  /** Re-read the viewport and redraw, only if the rows to draw changed. */
  const update = useCallback(() => {
    if (!list) return;
    const view = viewportOf(list, scroller.current);
    const next = rowSpan(latest.current.starts, view.top, view.bottom, latest.current.overscan);
    setSpan((current) => (current.first === next.first && current.end === next.end ? current : next));
  }, [list]);

  // Scrolling and resizing move the viewport.
  useEffect(() => {
    if (!list) return undefined;
    scroller.current = scrollParentOf(list);
    const target: HTMLElement | Window = scroller.current ?? window;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (scroller.current) resized?.observe(scroller.current);
    update();
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      resized?.disconnect();
    };
  }, [list, update]);

  // Every drawn row is measured; a row whose height changed moves the ones after it.
  const keys = useRef(new WeakMap<Element, string>());
  const observed = useRef(new Set<Element>());
  const rows = useRef<ResizeObserver | undefined>(undefined);
  useEffect(() => {
    if (!list || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = keys.current.get(entry.target);
        if (key === undefined || !entry.target.isConnected) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
        const previous = sizes.current.get(key);
        if (previous !== undefined && Math.abs(previous - height) < 0.5) continue;
        sizes.current.set(key, height);
        measured.current.sum += height - (previous ?? 0);
        if (previous === undefined) measured.current.count += 1;
        changed = true;
      }
      if (changed) setVersion((version) => version + 1);
    });
    rows.current = observer;
    return () => {
      observer.disconnect();
      observed.current.clear();
      rows.current = undefined;
    };
  }, [list]);

  // Scrolls asked for before the row was drawn finish once it is.
  const pending = useRef<number | undefined>(undefined);

  // After every render: observe the rows that arrived, let go of the ones that left, and
  // re-read the viewport (the list may have moved: a banner above it, a filter opening).
  useLayoutEffect(() => {
    if (!list) return;
    const observer = rows.current;
    if (observer) {
      const present = new Set<Element>();
      for (const child of Array.from(list.children)) {
        const index = (child as HTMLElement).dataset?.["virtualIndex"];
        if (index === undefined) continue;
        present.add(child);
        if (!observed.current.has(child)) {
          keys.current.set(child, keyOf(Number(index)));
          observer.observe(child);
          observed.current.add(child);
        }
      }
      for (const child of observed.current) {
        if (present.has(child)) continue;
        observer.unobserve(child);
        observed.current.delete(child);
      }
    }
    update();
    if (pending.current !== undefined) {
      const row = list.querySelector<HTMLElement>(`:scope > [data-virtual-index="${pending.current}"]`);
      if (row) {
        pending.current = undefined;
        const view = viewportOf(list, scroller.current);
        const box = row.getBoundingClientRect();
        const top = box.top - list.getBoundingClientRect().top;
        scrollBy(scroller.current, scrollDelta(top, top + box.height, view.top, view.bottom));
      }
    }
  });

  const scrollToIndex = useCallback(
    (index: number) => {
      const { starts: current } = latest.current;
      if (!list || index < 0 || index >= current.length - 1) return;
      const view = viewportOf(list, scroller.current);
      scrollBy(scroller.current, scrollDelta(current[index] as number, current[index + 1] as number, view.top, view.bottom));
      // Where it lands was a guess if the row was never drawn: correct it once it is.
      pending.current = index;
      update();
    },
    [list, update],
  );

  const first = Math.min(span.first, count);
  const end = Math.min(Math.max(span.end, first), count);
  return {
    first,
    end,
    before: starts[first] as number,
    after: (starts[count] as number) - (starts[end] as number),
    listRef: setList,
    scrollToIndex,
  };
}

/**
 * The height for a scrolling box that fills what its scrolling ancestor (or the window)
 * has left once everything else in it is laid out: `viewport` is the ancestor's visible
 * height, `content` its whole scroll height, `box` the box's own current height.
 * Never below `minimum`, so a crowded ancestor scrolls rather than squeezing the box shut.
 */
export function fitHeight(viewport: number, content: number, box: number, minimum: number): number {
  return Math.max(minimum, Math.floor(viewport - (content - box)));
}

/**
 * How tall everything in `outer` is, padding included. Not `scrollHeight`: that is never
 * less than the viewport, so content that fits would read as filling it exactly.
 */
function contentHeight(outer: HTMLElement, page: boolean): number {
  const last = outer.lastElementChild;
  const box = outer.getBoundingClientRect();
  // The top of the scrolled content, wherever it is scrolled to.
  const top = page ? box.top : box.top + outer.clientTop - outer.scrollTop;
  if (!last) return 0;
  const style = getComputedStyle(outer);
  const bottom = last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom || "0");
  return bottom - top + parseFloat(style.paddingBottom || "0");
}

/**
 * A `maxHeight` for `box` that makes it end at the bottom of its scrolling ancestor.
 * Re-measured when the window, the ancestor or anything in it changes size (a panel above
 * opening or closing).
 */
export function useFitToScreen(box: HTMLElement | null, minimum: number): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!box) return undefined;
    const outer = scrollParentOf(box) ?? document.documentElement;
    const page = outer === document.documentElement;
    const fit = (): void => {
      setHeight(fitHeight(page ? window.innerHeight : outer.clientHeight, contentHeight(outer, page), box.getBoundingClientRect().height, minimum));
    };
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    resized?.observe(outer);
    for (const child of Array.from(outer.children)) resized?.observe(child);
    resized?.observe(box);
    window.addEventListener("resize", fit);
    fit();
    return () => {
      resized?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [box, minimum]);
  return height;
}
