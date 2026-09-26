/**
 * The end of a page: a "Load N more" button that also presses itself.
 *
 * **A real button, always.** Keyboard and screen-reader users press it; nothing is
 * reachable only by scrolling. **It loads ahead by itself** when it comes within a
 * screen of the viewport, so scrolling a long list never stops at it — but only once
 * per page (`busy` until the next page lands), so a short page that leaves the button
 * in view does not load the whole workspace in a loop.
 */

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

export function LoadMore({
  count,
  busy,
  onMore,
}: {
  /** How many the next page brings. */
  readonly count: number;
  /** A page is on its way. */
  readonly busy: boolean;
  readonly onMore: () => void;
}): ReactElement {
  const button = useRef<HTMLButtonElement | null>(null);
  const latest = useRef({ busy, onMore });
  latest.current = { busy, onMore };

  useEffect(() => {
    const element = button.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (!latest.current.busy) latest.current.onMore();
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
    // Re-observed after each page lands: an element that stays in view fires no new
    // entry, so a page too short to push the button away would otherwise stall here.
  }, [busy]);

  return (
    <button
      ref={button}
      type="button"
      className="doclist-load-more doclist:self-center"
      disabled={busy}
      onClick={onMore}
    >
      {busy ? "Loading…" : `Load ${count.toLocaleString()} more`}
    </button>
  );
}
