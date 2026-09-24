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

import { useCallback, useEffect, useState } from "react";

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
