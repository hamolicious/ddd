import { Workbox } from "workbox-window";

const UPDATE_CHECK_MS = 5 * 60_000;
const SETTLE_MS = 20_000;
const AUTO_APPLY_GUARD_MS = 60_000;
const AUTO_APPLY_KEY = "ddd:sw-auto-applied-at";

export interface UpdateFlow {
  readonly workbox: Workbox | undefined;
  check(): void;
}

const loadedAt = Date.now();
let touched = false;
for (const type of ["pointerdown", "keydown"] as const) {
  window.addEventListener(type, () => (touched = true), { capture: true, once: true, passive: true });
}
function settling(): boolean {
  return !touched && Date.now() - loadedAt < SETTLE_MS;
}

function claimAutoApply(): boolean {
  try {
    const last = Number(sessionStorage.getItem(AUTO_APPLY_KEY) ?? 0);
    if (Date.now() - last < AUTO_APPLY_GUARD_MS) return false;
    sessionStorage.setItem(AUTO_APPLY_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

export function registerServiceWorker(onUpdateAvailable: (apply: () => void) => void): UpdateFlow {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return { workbox: undefined, check: () => undefined };

  const workbox = new Workbox("/sw.js", { scope: "/" });

  const apply = (): void => {
    workbox.addEventListener("controlling", () => location.reload());
    void workbox.messageSkipWaiting();
  };
  workbox.addEventListener("waiting", () => {
    if (settling() && claimAutoApply()) apply();
    else onUpdateAvailable(apply);
  });

  let registered = false;
  const check = (): void => {
    if (registered) workbox.update().catch(() => undefined);
  };

  workbox
    .register()
    .then((registration) => {
      if (!registration) return;
      registered = true;
      watchForUpdates(check);
    })
    .catch((cause: unknown) => {
      console.warn("[app] service worker registration failed; offline boot is unavailable", cause);
    });
  return { workbox, check };
}

function watchForUpdates(update: () => void): void {
  let last = Date.now();
  const check = (): void => {
    last = Date.now();
    update();
  };
  setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - last > 30_000) check();
  });
  window.addEventListener("online", check);
}
