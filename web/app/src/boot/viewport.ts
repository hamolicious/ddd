export const VIEWPORT_HEIGHT_TOKEN = "--ddd-viewport-height";

export function trackViewportHeight(root: HTMLElement = document.documentElement): () => void {
  const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
  if (!viewport) return () => {};

  const update = (): void => {
    const height = viewport.scale > 1.01 ? window.innerHeight : Math.round(viewport.height);
    if (height > 0) root.style.setProperty(VIEWPORT_HEIGHT_TOKEN, `${String(height)}px`);
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
  };
}
