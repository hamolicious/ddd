/**
 * Boot and failure screens — the app before (or instead of) plugins.
 *
 * These are plain React with inline token-based styling and no dependency on any
 * plugin, because the moments they cover are exactly the ones where plugins are not
 * available: cold start, a bootstrap pass over 5 000 documents (SPEC §4.1 wants a
 * progress screen for it), and a boot that failed outright.
 */

import type { ReactNode } from "react";

import { safeModeUrl } from "../boot/safe-mode.js";

export function BootScreen({
  message,
  progress,
}: {
  readonly message: string;
  readonly progress?: { readonly done: number; readonly total?: number };
}): ReactNode {
  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : undefined;
  return (
    <div className="lm-boot" role="status" aria-live="polite">
      <div className="lm-boot-inner">
        <p className="lm-boot-message">{message}</p>
        {progress ? (
          <>
            <progress {...(percent !== undefined ? { value: percent, max: 100 } : {})} />
            <p className="lm-boot-detail">
              {progress.done}
              {progress.total ? ` / ${progress.total}` : ""} documents
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A boot that could not finish.
 *
 * `offline` distinguishes the one failure that is not a fault: the server is
 * unreachable *and* this device has never completed a boot, so there is no remembered
 * session to open the local workspace as (see `boot/cache.ts`). Saying "could not
 * start" to someone whose only problem is a tunnel, without saying that reconnecting
 * fixes it, is how a working app looks broken.
 */
export function BootFailure({
  error,
  offline,
}: {
  readonly error: Error;
  readonly offline?: boolean;
}): ReactNode {
  return (
    <div className="lm-boot" role="alert">
      <div className="lm-boot-inner">
        <h1>{offline ? "Life Manager is offline" : "Life Manager could not start"}</h1>
        {offline ? (
          <p>
            The server cannot be reached, and this device has not signed in yet — so
            there is no local copy of your workspace to open. Connect once, and after
            that it opens offline.
          </p>
        ) : null}
        <pre className="lm-boot-error">{error.message}</pre>
        <p>
          <button type="button" onClick={() => location.reload()}>
            Reload
          </button>{" "}
          <a href={safeModeUrl("bare")}>Start without plugins</a>
        </p>
      </div>
    </div>
  );
}

/**
 * The browser floor of SPEC §8: import maps (Chrome 89+, Safari 16.4+). Below it,
 * "a readable failure message" — this one — rather than a stack trace from a module
 * specifier the browser cannot resolve.
 */
export function UnsupportedBrowser(): ReactNode {
  return (
    <div className="lm-boot" role="alert">
      <div className="lm-boot-inner">
        <h1>This browser is too old</h1>
        <p>
          Life Manager needs a browser with import-map support — Chrome or Edge 89+,
          Safari 16.4+, Firefox 108+. Everything else about your data is fine; this
          browser simply cannot load the app.
        </p>
      </div>
    </div>
  );
}

/** Feature detection for that floor. Cheap, and done before anything else. */
export function supportsImportMaps(): boolean {
  return (
    typeof HTMLScriptElement !== "undefined" &&
    typeof HTMLScriptElement.supports === "function" &&
    HTMLScriptElement.supports("importmap")
  );
}
