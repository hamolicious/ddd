import { useCallback, useEffect, useState } from "react";

export interface AsyncState<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly reload: () => void;
}

export function useAsync<T>(load: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [token, setToken] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    void load()
      .then((value) => {
        if (live) setData(value);
      })
      .catch((cause: unknown) => {
        if (live) setError(message(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [token]);

  const reload = useCallback(() => setToken((value) => value + 1), []);
  return { data, loading, error, reload };
}

export interface Mutation {
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly run: (key: string, body: () => Promise<unknown>) => void;
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
        .catch((cause: unknown) => setError(message(cause)))
        .finally(() => setBusy(undefined));
    },
    [onDone],
  );
  return { busy, error, run };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
