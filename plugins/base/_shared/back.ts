import { useCallback, useEffect, useRef } from "react";

const MARK = "dddOverlay";

let counter = 0;

const ownsTop = (token: string): boolean =>
  (history.state as Record<string, unknown> | null)?.[MARK] === token;

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
