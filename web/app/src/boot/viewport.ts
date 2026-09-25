/**
 * `--lm-viewport-height`: how tall the screen actually is, right now.
 *
 * On Android the **layout** viewport does not shrink when the soft keyboard opens —
 * only the **visual** viewport does — so a frame sized `height: 100%` keeps its full
 * height and the keyboard is simply painted over the bottom of it. The submit button
 * under a focused password field is then off-screen with no way to scroll to it,
 * because `position: fixed` is anchored to the layout viewport too.
 *
 * So the one number every full-height surface is sized from is published as a token and
 * kept current from `window.visualViewport`. Nothing else about the layout changes: the
 * default value is `100vh`, which is what those surfaces were already using.
 *
 * Two details that are easy to get wrong:
 *
 * - **Pinch-zoom shrinks the visual viewport too.** Sizing the app from it while zoomed
 *   would collapse the frame to the magnified region. A scale above 1 therefore falls
 *   back to `innerHeight`.
 * - **The keyboard also scrolls the visual viewport** (`offsetTop`), which fires
 *   `scroll`, not `resize`. Both are listened to.
 */

/** The property every full-height surface in the app and the base shell reads. */
export const VIEWPORT_HEIGHT_TOKEN = "--lm-viewport-height";

/**
 * Start tracking, and return the unsubscribe. Safe to call where there is no
 * `visualViewport` (older WebViews, jsdom): it then does nothing at all and the CSS
 * default stands.
 */
export function trackViewportHeight(root: HTMLElement = document.documentElement): () => void {
  const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
  if (!viewport) return () => {};

  const update = (): void => {
    // Zoomed in: the visual viewport is the magnified region, not the screen.
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
