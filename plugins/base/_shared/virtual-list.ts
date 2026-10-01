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
 * the screen and everything around it stays in view. `useScrollerHeight` is the plainer
 * one: how tall the visible part of the box's scrolling ancestor is, for a box that only
 * has to be no taller than the screen.
 *
 * **"The screen" is the visual viewport.** On a phone the layout viewport (`innerHeight`,
 * `100vh`) stays full height under the browser's toolbars and the on-screen keyboard;
 * only `visualViewport` shrinks. Every height read here from the window comes from
 * `visibleHeight`, and both hooks listen to `visualViewport` as well as the window.
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
  /**
   * `false` for a list that scrolls in a box of its own (a results table embedded in a
   * note): the rows in view are the box's, whether or not the page has scrolled the box
   * partly off screen. The list only hears its own box scroll, so clipping to the window
   * as well would leave it drawing the rows of a page position long since scrolled away.
   * Default `true`.
   */
  readonly clipToWindow?: boolean;
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

/** The parts of `window` the visible height is read from (a parameter, for the tests). */
export interface ViewportSource {
  readonly innerHeight: number;
  readonly visualViewport?: { readonly height: number; readonly offsetTop: number; readonly scale: number } | null;
}

/**
 * The window's visible band, in client (layout-viewport) pixels: `top` to `bottom`. The
 * visual viewport when there is one, so the on-screen keyboard and a phone browser's
 * toolbars are outside it; the layout viewport otherwise. Pinch-zoomed in (a scale above
 * 1), the visual viewport is the magnified region rather than the screen, so the layout
 * viewport stands, as `web/app/src/boot/viewport.ts` does for `--ddd-viewport-height`.
 */
export function visibleBand(source: ViewportSource): { readonly top: number; readonly bottom: number } {
  const visual = source.visualViewport;
  if (!visual || visual.scale > 1.01 || !(visual.height > 0)) return { top: 0, bottom: source.innerHeight };
  const top = Math.max(0, visual.offsetTop);
  return { top, bottom: Math.min(source.innerHeight, top + visual.height) };
}

/** How tall the visible part of the window is. */
export function visibleHeight(source: ViewportSource): number {
  const band = visibleBand(source);
  return band.bottom - band.top;
}

/** Call `listener` whenever the visible part of the window moves or changes size. */
function onViewportChange(listener: () => void): () => void {
  const visual = window.visualViewport;
  window.addEventListener("resize", listener);
  visual?.addEventListener("resize", listener);
  visual?.addEventListener("scroll", listener);
  return () => {
    window.removeEventListener("resize", listener);
    visual?.removeEventListener("resize", listener);
    visual?.removeEventListener("scroll", listener);
  };
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
function viewportOf(list: HTMLElement, scroller: HTMLElement | undefined, clipToWindow = true): Viewport {
  const listTop = list.getBoundingClientRect().top;
  const window_ = scroller && !clipToWindow ? undefined : window;
  const band = window_ ? visibleBand(window_) : { top: -Infinity, bottom: Infinity };
  let top = band.top;
  let bottom = band.bottom;
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

export function useVirtualList({
  count,
  keyOf,
  estimate,
  overscan = 6,
  clipToWindow = true,
}: VirtualListOptions): VirtualList {
  const [list, setList] = useState<HTMLElement | null>(null);
  const scroller = useRef<HTMLElement | undefined>(undefined);
  const [rebind, setRebind] = useState(0);

  /**
   * The nearest scrolling ancestor, read each time it is used rather than once at mount: a
   * plugin's stylesheet can arrive after its list mounts, and until it does the box meant
   * to scroll does not, so the first answer would be an outer one (the sidebar) for good.
   */
  const resolveScroller = useCallback((): HTMLElement | undefined => {
    if (!list) return scroller.current;
    const next = scrollParentOf(list);
    if (next !== scroller.current) {
      scroller.current = next;
      setRebind((value) => value + 1);
    }
    return next;
  }, [list]);

  // Measured heights, by key, and their running mean for the rows not measured yet.
  const sizes = useRef(new Map<string, number>());
  const measured = useRef({ sum: 0, count: 0 });
  const [, setVersion] = useState(0);

  // Never 0: a guess of nothing would draw nothing, and a row never drawn is never measured.
  const mean = measured.current.count > 0 ? measured.current.sum / measured.current.count : estimate;
  const guess = mean > 0 ? mean : estimate;
  const starts = layoutRows(count, (index) => sizes.current.get(keyOf(index)) ?? guess);
  const latest = useRef({ starts, overscan });
  latest.current = { starts, overscan };

  // Before the first layout there is no viewport to read: a screenful from the top.
  const [span, setSpan] = useState<RowSpan>(() => ({
    first: 0,
    end: Math.min(count, Math.ceil((typeof window === "undefined" ? 800 : visibleHeight(window)) / estimate) + overscan),
  }));

  /** Re-read the viewport and redraw, only if the rows to draw changed. */
  const update = useCallback(() => {
    if (!list) return;
    const view = viewportOf(list, resolveScroller(), clipToWindow);
    const next = rowSpan(latest.current.starts, view.top, view.bottom, latest.current.overscan);
    setSpan((current) => (current.first === next.first && current.end === next.end ? current : next));
  }, [list, clipToWindow, resolveScroller]);

  // Scrolling and resizing move the viewport. Bound again when the scroll parent changes.
  useEffect(() => {
    if (!list) return undefined;
    const target: HTMLElement | Window = resolveScroller() ?? window;
    target.addEventListener("scroll", update, { passive: true });
    const unlisten = onViewportChange(update);
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (target !== window) resized?.observe(target as HTMLElement);
    update();
    return () => {
      target.removeEventListener("scroll", update);
      unlisten();
      resized?.disconnect();
    };
  }, [list, update, resolveScroller, rebind]);

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
        // A row not rendered (kanban hides the card being carried) is reported at 0: no
        // row's real height, and not to be learnt from. Kept at 0, it would stand in the
        // mean, and a list whose only rows had all been carried out would guess 0 for the
        // next row — a total height of 0, so nothing drawn, so nothing measured, for good.
        if (!(height > 0)) continue;
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
        const outer = resolveScroller();
        const view = viewportOf(list, outer, clipToWindow);
        const box = row.getBoundingClientRect();
        const top = box.top - list.getBoundingClientRect().top;
        scrollBy(outer, scrollDelta(top, top + box.height, view.top, view.bottom));
      }
    }
  });

  const scrollToIndex = useCallback(
    (index: number) => {
      const { starts: current } = latest.current;
      if (!list || index < 0 || index >= current.length - 1) return;
      const outer = resolveScroller();
      const view = viewportOf(list, outer, clipToWindow);
      scrollBy(outer, scrollDelta(current[index] as number, current[index + 1] as number, view.top, view.bottom));
      // Where it lands was a guess if the row was never drawn: correct it once it is.
      pending.current = index;
      update();
    },
    [list, update, clipToWindow, resolveScroller],
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
 * One ancestor between the box and its scrolling ancestor (the scrolling ancestor last),
 * for `contentEnd`: `margin` is the bottom margin of its child on the way up from the box,
 * `others` where each of its other children ends (bottom margin included), and `after`
 * its own bottom padding and border.
 */
export interface FitLevel {
  readonly margin: number;
  readonly others: readonly number[];
  readonly after: number;
}

/**
 * Where the content of the scrolling ancestor ends, starting from where the box ends and
 * climbing one ancestor at a time: an ancestor's content ends after whichever of its
 * children ends last, plus its own padding.
 *
 * Climbing, rather than reading where the ancestors' boxes end, is the point. A flex item
 * may be shrunk below its content (a column item with `min-height: 100%` overrides the
 * `min-height: auto` that would have stopped it), its content then overflowing it in
 * plain sight. Its box then says the content is shorter than it is, and the box measured
 * against it would be fitted to a screen taller than the real one: exactly what
 * `search`'s phone layout (`compact:min-h-full`) did to the kanban board. The opposite,
 * a box stretched taller than its content, would make the fit stop growing back.
 */
export function contentEnd(boxEnd: number, levels: readonly FitLevel[]): number {
  let end = boxEnd;
  for (const level of levels) {
    end = Math.max(end + level.margin, ...level.others) + level.after;
  }
  return end;
}

function px(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * How tall everything in `outer` is besides `box`, padding included, measured from the
 * box up (`contentEnd`). Not `scrollHeight`: that is never less than the viewport, so
 * content that fits would read as filling it exactly.
 */
function othersHeight(outer: HTMLElement, box: HTMLElement, page: boolean): number {
  const rect = outer.getBoundingClientRect();
  // The top of the scrolled content, wherever it is scrolled to.
  const top = page ? rect.top : rect.top + outer.clientTop - outer.scrollTop;
  const own = box.getBoundingClientRect();
  const levels: FitLevel[] = [];
  for (let child: HTMLElement = box; child !== outer && child.parentElement; child = child.parentElement) {
    const parent = child.parentElement;
    const others: number[] = [];
    for (const sibling of Array.from(parent.children)) {
      if (sibling === child) continue;
      const style = getComputedStyle(sibling);
      // Out of the flow, and out of the scrolled content: a dragged card, a menu.
      if (style.position === "fixed" || style.display === "none") continue;
      others.push(sibling.getBoundingClientRect().bottom + px(style.marginBottom));
    }
    const style = getComputedStyle(parent);
    levels.push({
      margin: px(getComputedStyle(child).marginBottom),
      others,
      // The scrolling ancestor's border is outside its content; anyone else's is inside.
      after: px(style.paddingBottom) + (parent === outer ? 0 : px(style.borderBottomWidth)),
    });
  }
  return contentEnd(own.bottom, levels) - top - own.height;
}

/** The scrolling ancestor of `box` and how tall its visible part is. */
function scrollerOf(box: HTMLElement): { readonly outer: HTMLElement; readonly page: boolean; readonly height: () => number } {
  const outer = scrollParentOf(box) ?? document.documentElement;
  const page = outer === document.documentElement;
  return { outer, page, height: () => (page ? visibleHeight(window) : outer.clientHeight) };
}

/**
 * Run `measure` now and whenever the window or the visual viewport changes size, or
 * `outer` or anything on the way down to `box` (every ancestor's children: a panel
 * opening beside the box) does. An ancestor shrunk below its content does not change
 * size when that content does, so watching `outer`'s children alone would miss it.
 */
function watchSizes(outer: HTMLElement, box: HTMLElement, measure: () => void): () => void {
  const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
  resized?.observe(outer);
  resized?.observe(box);
  for (let child: HTMLElement = box; child !== outer && child.parentElement; child = child.parentElement) {
    for (const sibling of Array.from(child.parentElement.children)) resized?.observe(sibling);
  }
  const unlisten = onViewportChange(measure);
  measure();
  return () => {
    resized?.disconnect();
    unlisten();
  };
}

/**
 * A `maxHeight` for `box` that makes it end at the bottom of its scrolling ancestor (or
 * of the visible window, when nothing else scrolls). Re-measured when the window, the
 * visual viewport (the on-screen keyboard), the ancestor or anything in it changes size
 * (a panel above opening or closing).
 */
export function useFitToScreen(box: HTMLElement | null, minimum: number): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!box) return undefined;
    const scroller = scrollerOf(box);
    return watchSizes(scroller.outer, box, () => {
      const others = othersHeight(scroller.outer, box, scroller.page);
      const own = box.getBoundingClientRect().height;
      setHeight(fitHeight(scroller.height(), others + own, own, minimum));
    });
  }, [box, minimum]);
  return height;
}

/**
 * How tall the visible part of `box`'s scrolling ancestor is (the visible window when
 * nothing else scrolls): a `maxHeight` for a box that must never be taller than the
 * screen but, unlike `useFitToScreen`, need not end at its bottom, such as a table
 * embedded in a long note.
 */
export function useScrollerHeight(box: HTMLElement | null): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!box) return undefined;
    const scroller = scrollerOf(box);
    return watchSizes(scroller.outer, box, () => {
      const next = Math.floor(scroller.height());
      setHeight((current) => (current === next ? current : next));
    });
  }, [box]);
  return height;
}
