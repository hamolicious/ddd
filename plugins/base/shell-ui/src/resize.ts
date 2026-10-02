export const SIDEBAR_MIN = 192;
export const SIDEBAR_DEFAULT = 288;
export const KEYBOARD_STEP = 16;

const STORAGE_KEY = "ddd.shell.sidebar-width";
export const ALTBAR_WIDTH_KEY = "ddd.shell.altbar-width";

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
  }
}
