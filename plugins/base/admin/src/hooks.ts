import { createContext, useCallback, useContext, useEffect, useState } from "react";

import type { ConfirmRequest, ModalRequest, ModalResult, SheetRequest } from "plugin:context-menu";

export interface AsyncState<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly reload: () => void;
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [token, setToken] = useState(0);
  const key = JSON.stringify(deps);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    void load()
      .then((value) => {
        if (live) setData(value);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [key, token]);

  const reload = useCallback(() => setToken((value) => value + 1), []);
  return { data, loading, error, reload };
}

export interface Mutation {
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly run: (key: string, body: () => Promise<unknown>) => void;
  readonly clearError: () => void;
}

export function useMutation(onDone?: () => void): Mutation {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = useCallback(
    (key: string, body: () => Promise<unknown>) => {
      setBusy(key);
      setError(undefined);
      void body()
        .then(() => onDone?.())
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setBusy(undefined));
    },
    [onDone],
  );

  return { busy, error, run, clearError: () => setError(undefined) };
}

export interface Dialogs {
  confirm(request: ConfirmRequest): Promise<boolean>;
  modal(request: ModalRequest): Promise<ModalResult | undefined>;
  openSheet(request: SheetRequest): void;
}

export const DialogsContext = createContext<Dialogs>({
  confirm: (request) => Promise.resolve(window.confirm(request.title)),
  modal: (request) => {
    const button = request.buttons?.find((candidate) => !candidate.dismiss)?.id ?? "ok";
    return Promise.resolve(window.confirm(request.title) ? { button, values: {} } : undefined);
  },
  openSheet: () => {},
});

export const useConfirm = (): Dialogs["confirm"] => useContext(DialogsContext).confirm;
export const useModal = (): Dialogs["modal"] => useContext(DialogsContext).modal;
export const useSheet = (): Dialogs["openSheet"] => useContext(DialogsContext).openSheet;
