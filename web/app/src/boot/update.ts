/**
 * Service-worker registration and the **one** update flow (SPEC §8).
 *
 * One flow, not two: a new app bundle and a new plugin version both arrive as a new
 * service worker (the plugin list and the import map are part of what the worker
 * precaches and revalidates), so there is exactly one thing a user is ever asked to
 * do — reload. Auto-activating instead would swap the kernel under a running plugin
 * set, which is a different and much worse bug.
 */

import { Workbox } from "workbox-window";

export interface UpdateFlow {
  /** `undefined` when service workers are unavailable (private mode, http). */
  readonly workbox: Workbox | undefined;
}

export function registerServiceWorker(onUpdateAvailable: (apply: () => void) => void): UpdateFlow {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return { workbox: undefined };

  const workbox = new Workbox("/sw.js", { scope: "/" });

  workbox.addEventListener("waiting", () => {
    onUpdateAvailable(() => {
      // Reload once the new worker has taken control, not before: reloading first
      // just re-runs the old bundle.
      workbox.addEventListener("controlling", () => location.reload());
      void workbox.messageSkipWaiting();
    });
  });

  // `register()` is allowed to fail, and the app is allowed not to care.
  //
  // `void promise` leaves a rejection unhandled, which surfaces as an uncaught error
  // during boot — and registration genuinely fails in ordinary situations: a private
  // window, a browser or enterprise policy that blocks workers, an automation context
  // that disables them, storage pressure. The offline app shell is a *progressive*
  // enhancement (SPEC §8): losing it costs the user offline boot and the reload
  // prompt, and must not look like the kernel crashed. Logged, not swallowed
  // silently, because "no update prompt ever appears" is otherwise unexplainable.
  workbox.register().catch((cause: unknown) => {
    console.warn("[app] service worker registration failed; offline boot is unavailable", cause);
  });
  return { workbox };
}
