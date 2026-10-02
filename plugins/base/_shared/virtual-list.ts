import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface RowSpan {
  readonly first: number;
  readonly end: number;
}

export function layoutRows(count: number, sizeOf: (index: number) => number): Float64Array {
  const starts = new Float64Array(Math.max(0, count) + 1);
  for (let index = 0; index < count; index += 1) {
    starts[index + 1] = (starts[index] as number) + Math.max(0, sizeOf(index));
  }
  return starts;
}

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

export function scrollDelta(start: number, end: number, top: number, bottom: number): number {
  if (start < top) return start - top;
  if (end > bottom) return Math.min(end - bottom, start - top);
  return 0;
}

export interface VirtualListOptions {
  readonly count: number;
  readonly keyOf: (index: number) => string;
  readonly estimate: number;
  readonly overscan?: number;
  readonly clipToWindow?: boolean;
}

export interface VirtualList {
  readonly first: number;
  readonly end: number;
  readonly before: number;
  readonly after: number;
  readonly listRef: (element: HTMLElement | null) => void;
  readonly scrollToIndex: (index: number) => void;
}

interface Viewport {
  readonly top: number;
  readonly bottom: number;
}

export interface ViewportSource {
  readonly innerHeight: number;
  readonly visualViewport?: { readonly height: number; readonly offsetTop: number; readonly scale: number } | null;
}

export function visibleBand(source: ViewportSource): { readonly top: number; readonly bottom: number } {
  const visual = source.visualViewport;
  if (!visual || visual.scale > 1.01 || !(visual.height > 0)) return { top: 0, bottom: source.innerHeight };
  const top = Math.max(0, visual.offsetTop);
  return { top, bottom: Math.min(source.innerHeight, top + visual.height) };
}

export function visibleHeight(source: ViewportSource): number {
  const band = visibleBand(source);
  return band.bottom - band.top;
}

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

function scrollParentOf(element: HTMLElement): HTMLElement | undefined {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return parent;
  }
  return undefined;
}

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

  const resolveScroller = useCallback((): HTMLElement | undefined => {
    if (!list) return scroller.current;
    const next = scrollParentOf(list);
    if (next !== scroller.current) {
      scroller.current = next;
      setRebind((value) => value + 1);
    }
    return next;
  }, [list]);

  const sizes = useRef(new Map<string, number>());
  const measured = useRef({ sum: 0, count: 0 });
  const [, setVersion] = useState(0);

  const mean = measured.current.count > 0 ? measured.current.sum / measured.current.count : estimate;
  const guess = mean > 0 ? mean : estimate;
  const starts = layoutRows(count, (index) => sizes.current.get(keyOf(index)) ?? guess);
  const latest = useRef({ starts, overscan });
  latest.current = { starts, overscan };

  const [span, setSpan] = useState<RowSpan>(() => ({
    first: 0,
    end: Math.min(count, Math.ceil((typeof window === "undefined" ? 800 : visibleHeight(window)) / estimate) + overscan),
  }));

  const update = useCallback(() => {
    if (!list) return;
    const view = viewportOf(list, resolveScroller(), clipToWindow);
    const next = rowSpan(latest.current.starts, view.top, view.bottom, latest.current.overscan);
    setSpan((current) => (current.first === next.first && current.end === next.end ? current : next));
  }, [list, clipToWindow, resolveScroller]);

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

  const pending = useRef<number | undefined>(undefined);

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

export function fitHeight(viewport: number, content: number, box: number, minimum: number): number {
  return Math.max(minimum, Math.floor(viewport - (content - box)));
}

export interface FitLevel {
  readonly margin: number;
  readonly others: readonly number[];
  readonly after: number;
}

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

function othersHeight(outer: HTMLElement, box: HTMLElement, page: boolean): number {
  const rect = outer.getBoundingClientRect();
  const top = page ? rect.top : rect.top + outer.clientTop - outer.scrollTop;
  const own = box.getBoundingClientRect();
  const levels: FitLevel[] = [];
  for (let child: HTMLElement = box; child !== outer && child.parentElement; child = child.parentElement) {
    const parent = child.parentElement;
    const others: number[] = [];
    for (const sibling of Array.from(parent.children)) {
      if (sibling === child) continue;
      const style = getComputedStyle(sibling);
      if (style.position === "fixed" || style.display === "none") continue;
      others.push(sibling.getBoundingClientRect().bottom + px(style.marginBottom));
    }
    const style = getComputedStyle(parent);
    levels.push({
      margin: px(getComputedStyle(child).marginBottom),
      others,
      after: px(style.paddingBottom) + (parent === outer ? 0 : px(style.borderBottomWidth)),
    });
  }
  return contentEnd(own.bottom, levels) - top - own.height;
}

function scrollerOf(box: HTMLElement): { readonly outer: HTMLElement; readonly page: boolean; readonly height: () => number } {
  const outer = scrollParentOf(box) ?? document.documentElement;
  const page = outer === document.documentElement;
  return { outer, page, height: () => (page ? visibleHeight(window) : outer.clientHeight) };
}

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
