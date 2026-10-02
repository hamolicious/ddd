import { useCallback, useLayoutEffect, useRef } from "react";

const EASE = "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)";

export interface Flip {
  readonly remember: (id: string, box: DOMRect) => void;
}

interface Place {
  readonly x: number;
  readonly y: number;
}

export function useFlip(root: HTMLElement | null, signature: string): Flip {
  const places = useRef(new Map<string, Place>());
  const pending = useRef(new Map<string, DOMRect>());
  const last = useRef<string | undefined>(undefined);

  const toBoard = useCallback(
    (x: number, y: number, list: HTMLElement | null): Place => {
      if (!root) return { x, y };
      const origin = root.getBoundingClientRect();
      return { x: x - origin.left + root.scrollLeft, y: y - origin.top + (list?.scrollTop ?? 0) };
    },
    [root],
  );

  const placeOf = useCallback(
    (element: HTMLElement): Place => {
      const box = element.getBoundingClientRect();
      return toBoard(box.left, box.top, element.closest<HTMLElement>("[data-kanban-list]"));
    },
    [toBoard],
  );

  useLayoutEffect(() => {
    if (!root) return;
    const elements = [...root.querySelectorAll<HTMLElement>("[data-flip-id]")];
    const changed = last.current !== undefined && last.current !== signature;
    last.current = signature;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    if (changed && !still) {
      for (const element of elements) {
        element.style.transition = "none";
        element.style.transform = "";
      }
      const targets = elements.map((element) => [element, placeOf(element)] as const);
      for (const [element, after] of targets) {
        const id = element.dataset["flipId"] as string;
        const by = pending.current.get(id);
        const before = by ? toBoard(by.left, by.top, element.closest<HTMLElement>("[data-kanban-list]")) : places.current.get(id);
        if (!before) continue;
        const dx = before.x - after.x;
        const dy = before.y - after.y;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        element.style.transform = `translate(${String(dx)}px, ${String(dy)}px)`;
        void element.offsetWidth;
        element.style.transition = EASE;
        element.style.transform = "";
      }
      pending.current.clear();
      places.current = new Map(targets.map(([element, after]) => [element.dataset["flipId"] as string, after]));
      return;
    }
    places.current = new Map(elements.map((element) => [element.dataset["flipId"] as string, placeOf(element)]));
  });

  return {
    remember: (id, box) => {
      pending.current.set(id, box);
    },
  };
}
