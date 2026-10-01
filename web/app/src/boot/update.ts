/**
 * Service-worker registration and the **one** update flow (SPEC §8).
 *
 * One flow, not two: a new app bundle and a new plugin version both arrive as a new
 * service worker (the plugin list and the import map are part of what the worker
 * precaches and revalidates), so there is exactly one thing a user is ever asked to
 * do — reload. Auto-activating instead would swap the kernel under a running plugin
 * set, which is a different and much worse bug.
 *
 * **An open page asks for updates itself.** A browser only looks for a new `sw.js` when
 * it navigates, so a tab left open — the usual way this app is used — never heard of an
 * update until it was refreshed, and then the refresh was the one asking. The page
 * checks every {@link UPDATE_CHECK_MS}, and when it comes back into view or back online;
 * `main.tsx` also calls {@link UpdateFlow.check} when the sync socket reconnects, which
 * is what a server restarting on a new build looks like from here.
 *
 * **A refresh applies an update rather than announcing one.** A reload never activates a
 * waiting worker — the old one keeps serving the page — so a refresh used to *find* the
 * update and then ask for a second reload. An update found while the page is still
 * {@link settling} (just loaded, nothing touched yet) is applied at once: there is no
 * session to interrupt, and edits are in IndexedDB either way. Once only per
 * {@link AUTO_APPLY_GUARD_MS}, so a worker that never takes over cannot loop the page.
 */

import { Workbox } from "workbox-window";

/** How often an open page asks the server for a new worker. */
const UPDATE_CHECK_MS = 5 * 60_000;
/** How long after load, untouched, a found update is applied without asking. */
const SETTLE_MS = 20_000;
/** An automatic apply is not repeated within this window (see the module header). */
const AUTO_APPLY_GUARD_MS = 60_000;
const AUTO_APPLY_KEY = "ddd:sw-auto-applied-at";

export interface UpdateFlow {
  /** `undefined` when service workers are unavailable (private mode, http). */
  readonly workbox: Workbox | undefined;
  /** Ask the server for a new worker now. Harmless when there is none. */
  check(): void;
}

/** Load time, until the first key or pointer press: an update may be applied unasked. */
const loadedAt = Date.now();
let touched = false;
for (const type of ["pointerdown", "keydown"] as const) {
  window.addEventListener(type, () => (touched = true), { capture: true, once: true, passive: true });
}
function settling(): boolean {
  return !touched && Date.now() - loadedAt < SETTLE_MS;
}

/** Whether an automatic apply may happen now, recording it when it may. */
function claimAutoApply(): boolean {
  try {
    const last = Number(sessionStorage.getItem(AUTO_APPLY_KEY) ?? 0);
    if (Date.now() - last < AUTO_APPLY_GUARD_MS) return false;
    sessionStorage.setItem(AUTO_APPLY_KEY, String(Date.now()));
    return true;
  } catch {
    // No storage, no loop guard: ask instead.
    return false;
  }
}

export function registerServiceWorker(onUpdateAvailable: (apply: () => void) => void): UpdateFlow {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return { workbox: undefined, check: () => undefined };

  const workbox = new Workbox("/sw.js", { scope: "/" });

  const apply = (): void => {
    // Reload once the new worker has taken control, not before: reloading first
    // just re-runs the old bundle.
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

  // `register()` is allowed to fail, and the app is allowed not to care.
  //
  // `void promise` leaves a rejection unhandled, which surfaces as an uncaught error
  // during boot — and registration genuinely fails in ordinary situations: a private
  // window, a browser or enterprise policy that blocks workers, an automation context
  // that disables them, storage pressure. The offline app shell is a *progressive*
  // enhancement (SPEC §8): losing it costs the user offline boot and the reload
  // prompt, and must not look like the kernel crashed. Logged, not swallowed
  // silently, because "no update prompt ever appears" is otherwise unexplainable.
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

/**
 * Ask for a new worker now and then (see the module header). A failed check — offline,
 * the server restarting — is the normal case of a check, not an error: the next one
 * tries again.
 */
function watchForUpdates(update: () => void): void {
  let last = Date.now();
  const check = (): void => {
    last = Date.now();
    update();
  };
  setInterval(check, UPDATE_CHECK_MS);
  // Back in view after a while: a phone that slept through the interval checks at once.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - last > 30_000) check();
  });
  window.addEventListener("online", check);
}
