import { useEffect, useState } from "react";

export function contentOverflows(scrollHeight: number, clientHeight: number, spacerHeight: number): boolean {
  return scrollHeight - spacerHeight > clientHeight + 1;
}

export function usePaneScrolls(element: HTMLElement | null, spacer: HTMLElement | null): boolean {
  const [scrolls, setScrolls] = useState(false);

  useEffect(() => {
    if (!element) return undefined;

    const update = (): void => {
      const spacerHeight = spacer?.offsetHeight ?? 0;
      setScrolls(contentOverflows(element.scrollHeight, element.clientHeight, spacerHeight));
    };
    const sizes = new ResizeObserver(update);
    const watch = (): void => {
      sizes.disconnect();
      sizes.observe(element);
      for (const child of element.children) sizes.observe(child);
      update();
    };
    const children = new MutationObserver(watch);

    watch();
    children.observe(element, { childList: true });
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
  }, [element, spacer]);

  return scrolls;
}
