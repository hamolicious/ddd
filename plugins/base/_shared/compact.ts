/**
 * The one definition of "this is a phone" the base plugins share, and the two hooks
 * that read it.
 *
 * **Why it is here and not in a kernel token.** `web/kernel-api/src/ui.ts` is frozen and
 * its tokens are CSS custom properties; a media query cannot read a custom property, so
 * a breakpoint cannot be a token however much one would like it to be. The literal
 * therefore has to appear in each `style.css` — what this file removes is the *second*
 * copy, the one in TypeScript, and it is the file to change when the threshold moves.
 * Keep {@link COMPACT_MEDIA_QUERY} and the `@media` line at the foot of each plugin's
 * stylesheet spelled the same.
 *
 * **Why the query has two arms.** Width alone gives a phone in landscape (844 × 390 on a
 * Pixel 7) the desktop layout: full-height dialogs it has no room for, hover-gated row
 * actions on a device with no hover. `(max-height: 480px) and (pointer: coarse)` is that
 * device and nothing else — a short *desktop* window has a fine pointer and keeps the
 * wide layout.
 */

import { useEffect, useState } from "react";

/** Phone portrait, or phone landscape. Mirrored in every base plugin's `style.css`. */
export const COMPACT_MEDIA_QUERY = "(max-width: 640px), (max-height: 480px) and (pointer: coarse)";

/** `true` while the viewport is a phone's. Re-renders when that changes. */
export function useCompact(): boolean {
  const [compact, setCompact] = useState(matchesCompact);
  useEffect(() => {
    const media = globalThis.matchMedia?.(COMPACT_MEDIA_QUERY);
    if (!media) return undefined;
    const listener = (): void => setCompact(media.matches);
    listener();
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return compact;
}

/** The initial value, read synchronously so the first render is already right. */
function matchesCompact(): boolean {
  return globalThis.matchMedia?.(COMPACT_MEDIA_QUERY).matches ?? false;
}

/**
 * No hover, therefore **no HTML5 drag and drop** — the two travel together, and this is
 * the honest test for "does the gesture this UI is about to describe exist here".
 * Viewport width is not: a phone in landscape is 844 px wide and still cannot drag.
 */
export function useTouchOnly(): boolean {
  const [touch, setTouch] = useState(() => globalThis.matchMedia?.("(hover: none)").matches ?? false);
  useEffect(() => {
    const media = globalThis.matchMedia?.("(hover: none)");
    if (!media) return undefined;
    const listener = (): void => setTouch(media.matches);
    listener();
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return touch;
}
