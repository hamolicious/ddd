/**
 * FLIP: cards glide to where a change puts them instead of jumping. Every element marked
 * `data-flip-id` inside `root` has its place remembered; when `signature` changes (a card
 * moved column, a gap opened), each one whose place changed is drawn at its old place and
 * transitioned to the new. Nothing moves for `prefers-reduced-motion`.
 *
 * **Places are the board's, not the window's.** A place is measured from the board's own
 * corner, with the board's sideways scroll and the card's column scroll added back — so
 * the page scrolling, an embed resizing, or a line of text appearing above the board moves
 * nothing, and only a card that changed place on the board glides. (Measured against the
 * window, every such shift read as every card having moved, and the whole board hopped.)
 *
 * **A card mid-glide is measured where it is going.** Its transform is cleared before the
 * new place is read, then the glide starts from where it was last seen — so a change during
 * a glide carries on from there instead of jumping.
 *
 * {@link Flip.remember} sets a place by hand, in window coordinates: a dropped card glides
 * from where the pointer let go of it.
 */

import { useCallback, useLayoutEffect, useRef } from "react";

const EASE = "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)";

export interface Flip {
  /** Pretend `id` was last seen at `box` (window coordinates). */
  readonly remember: (id: string, box: DOMRect) => void;
}

interface Place {
  readonly x: number;
  readonly y: number;
}

export function useFlip(root: HTMLElement | null, signature: string): Flip {
  const places = useRef(new Map<string, Place>());
  /** Places set by hand, in window coordinates until the card is drawn in its column. */
  const pending = useRef(new Map<string, DOMRect>());
  const last = useRef<string | undefined>(undefined);

  /** A window point as a place on the board, given the column list it scrolls in. */
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
      // Where each is going: in-flight glides cleared first, all read before any is moved.
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
        // Read once so the start is committed before the transition begins.
        void element.offsetWidth;
        element.style.transition = EASE;
        element.style.transform = "";
      }
      pending.current.clear();
      // Where each is going becomes where it is: the next change starts from there.
      places.current = new Map(targets.map(([element, after]) => [element.dataset["flipId"] as string, after]));
      return;
    }
    // Nothing moved on the board: keep the places current (cards added, text reflowed).
    places.current = new Map(elements.map((element) => [element.dataset["flipId"] as string, placeOf(element)]));
  });

  return {
    remember: (id, box) => {
      pending.current.set(id, box);
    },
  };
}
