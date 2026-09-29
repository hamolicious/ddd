/**
 * The end of a page: an invisible marker that loads the next page as it scrolls near.
 *
 * **Just scrolling.** No button and no "Loading…": the next page loads when the marker
 * comes within a screen of the viewport, before the rows run out. **Once per page**
 * (`busy` until the next page lands), so a short page that leaves the marker in view
 * does not load the whole workspace in a loop.
 */

import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

export function LoadMore({
  busy,
  onMore,
}: {
  /** A page is on its way. */
  readonly busy: boolean;
  readonly onMore: () => void;
}): ReactElement {
  const marker = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ busy, onMore });
  latest.current = { busy, onMore };

  useEffect(() => {
    const element = marker.current;
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
    // entry, so a page too short to push the marker away would otherwise stall here.
  }, [busy]);

  return <div ref={marker} className="doclist-load-more doclist:h-px" aria-hidden="true" />;
}
