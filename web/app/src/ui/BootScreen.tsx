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
    <div className="ddd-boot" role="status" aria-live="polite">
      <div className="ddd-boot-inner">
        <p className="ddd-boot-message">{message}</p>
        {progress ? (
          <>
            <progress {...(percent !== undefined ? { value: percent, max: 100 } : {})} />
            <p className="ddd-boot-detail">
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
    <div className="ddd-boot" role="alert">
      <div className="ddd-boot-inner">
        <h1>{offline ? "ddd is offline" : "ddd could not start"}</h1>
        {offline ? (
          <p>
            The server is unreachable and this device has never signed in, so there is
            nothing stored locally to open. Connect once and it will open offline after
            that.
          </p>
        ) : null}
        <pre className="ddd-boot-error">{error.message}</pre>
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
    <div className="ddd-boot" role="alert">
      <div className="ddd-boot-inner">
        <h1>This browser is too old</h1>
        <p>
          ddd needs Chrome 89+, Edge 89+, Safari 16.4+ or Firefox 108+. Your
          data is unaffected.
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
