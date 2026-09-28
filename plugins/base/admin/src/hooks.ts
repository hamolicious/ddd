/**
 * One hook, used by every admin section.
 *
 * Admin screens are all the same shape — load over REST, show a table, run a mutation,
 * reload — and the interesting part of that shape is the failure: these routes return 403
 * to a non-admin and 401 when a session expired, and both must render as a *message*.
 * An admin table that silently shows nothing on 403 is how someone concludes a workspace
 * lost its users.
 *
 * So `useAsync` has three states and no fourth, and a reload is an explicit token bump
 * rather than a dependency-array trick.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";

import type { ConfirmRequest, ModalRequest, ModalResult, SheetRequest } from "@protocols/lm/context-menu";

export interface AsyncState<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  /** Re-run the loader. */
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
    // `load` is a fresh closure every render; `key` and `token` are the real inputs.
  }, [key, token]);

  const reload = useCallback(() => setToken((value) => value + 1), []);
  return { data, loading, error, reload };
}

/** A mutation with its own in-flight and error state, so one failed row is one message. */
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
  /** A popover beside `anchor` (a bottom sheet on a phone) whose body the caller draws. */
  openSheet(request: SheetRequest): void;
}

/**
 * "Are you sure?" and other questions before a destructive action: `context-menu`'s
 * `confirm` and `modal`, provided by `index.tsx`. The default is the browser's own
 * dialog, for a section rendered without the provider (a test).
 */
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

/**
 * The way to the graph editor (`#/wiring`), which belongs to the `wiring` plugin: this
 * plugin only asks the router whether the route exists and navigates to it. Asked at
 * render time, because the editor can be plugged in or out while this screen is open.
 */
export interface WiringEditorLink {
  available(): boolean;
  open(): void;
}

export const WiringEditorContext = createContext<WiringEditorLink>({
  available: () => false,
  open: () => {},
});

export const useWiringEditor = (): WiringEditorLink => useContext(WiringEditorContext);
