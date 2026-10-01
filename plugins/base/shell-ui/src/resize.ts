/**
 * Sidebar and altbar resizing: the pure width rules, the same for both columns, kept out of the component so they can be
 * tested without a DOM.
 *
 * The width is a **per-device** preference — it answers "how wide on this screen",
 * so it lives in `localStorage` rather than kernel settings, which would sync a
 * phone's number onto a desktop. Every read and write is guarded: storage being
 * unavailable (private windows, webview quirks) costs the memory, never the feature.
 */

export const SIDEBAR_MIN = 192;
export const SIDEBAR_DEFAULT = 288; // matches the stylesheet's `min(18rem, 32vw)` at 16px
export const KEYBOARD_STEP = 16;

const STORAGE_KEY = "ddd.shell.sidebar-width";
/** The altbar's width, remembered apart from the sidebar's. */
export const ALTBAR_WIDTH_KEY = "ddd.shell.altbar-width";

/** The widest the sidebar may be: never squeezes `main` below half the viewport. */
export function sidebarMax(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.floor(viewportWidth / 2));
}

export function clampSidebarWidth(px: number, viewportWidth: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.min(Math.max(Math.round(px), SIDEBAR_MIN), sidebarMax(viewportWidth));
}

export function storedSidebarWidth(key: string = STORAGE_KEY): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function rememberSidebarWidth(px: number | undefined, key: string = STORAGE_KEY): void {
  try {
    if (px === undefined) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, String(px));
  } catch {
    // Storage refused: the width still applies for this page's lifetime.
  }
}
