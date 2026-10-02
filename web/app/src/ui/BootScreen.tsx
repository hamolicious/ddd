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

export function supportsImportMaps(): boolean {
  return (
    typeof HTMLScriptElement !== "undefined" &&
    typeof HTMLScriptElement.supports === "function" &&
    HTMLScriptElement.supports("importmap")
  );
}
