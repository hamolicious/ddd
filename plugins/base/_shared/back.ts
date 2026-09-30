/**
 * Back closes an overlay, the way it does in every other phone app.
 *
 * In the Android shell, back is `history.back()` in the webview (`webview_host.dart`), so
 * an overlay that adds no history entry of its own is invisible to it: back navigates the
 * page *behind* the overlay, or leaves the app, and the overlay stays up.
 *
 * So an open overlay pushes one entry, for the same URL (the router sees no navigation),
 * marked as its own. Back pops it and the overlay closes. Closing any other way takes
 * the entry back off first — and only *then* runs what follows, because a command that
 * navigates would push its entry before the asynchronous `history.back()` landed, and
 * that back would then undo the navigation instead.
 */

import { useCallback, useEffect, useRef } from "react";

const MARK = "lmOverlay";

let counter = 0;

const ownsTop = (token: string): boolean =>
  (history.state as Record<string, unknown> | null)?.[MARK] === token;

/**
 * Call from an overlay's component, which is mounted only while it is open. `onBack`
 * runs when back closes it. Returns `leave(then)`: the overlay's other ways out go
 * through it, and `then` (the close, the command) runs once the entry is gone.
 */
export function useBackToClose(onBack: () => void): (then: () => void) => void {
  const token = useRef("");
  const leaving = useRef<(() => void) | undefined>(undefined);
  const latest = useRef(onBack);
  latest.current = onBack;

  useEffect(() => {
    const own = `${String(Date.now())}-${String((counter += 1))}`;
    token.current = own;
    try {
      history.pushState({ ...(history.state as object | null), [MARK]: own }, "", location.href);
    } catch {
      // Refused (an opaque origin): back does what it did before, nothing worse.
      token.current = "";
      return undefined;
    }
    const onPop = (): void => {
      if (ownsTop(own)) return;
      token.current = "";
      const then = leaving.current;
      leaving.current = undefined;
      if (then) then();
      else latest.current();
    };
    addEventListener("popstate", onPop);
    return () => {
      removeEventListener("popstate", onPop);
      // Closed from outside (another plugin called close): unmark the entry rather than
      // go back, which could race a navigation the caller is about to make.
      if (token.current !== "" && ownsTop(own)) {
        const { [MARK]: _mark, ...rest } = history.state as Record<string, unknown>;
        history.replaceState(Object.keys(rest).length > 0 ? rest : null, "", location.href);
      }
    };
  }, []);

  return useCallback((then: () => void) => {
    if (token.current === "" || !ownsTop(token.current)) {
      then();
      return;
    }
    leaving.current = then;
    history.back();
  }, []);
}
