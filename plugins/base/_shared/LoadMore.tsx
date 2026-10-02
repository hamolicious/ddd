import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

export function LoadMore({
  busy,
  onMore,
  root,
}: {
  readonly busy: boolean;
  readonly onMore: () => void;
  readonly root?: Element | null;
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
      { root: root ?? null, rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [busy, root]);

  return <div ref={marker} style={{ height: 1 }} aria-hidden="true" />;
}
