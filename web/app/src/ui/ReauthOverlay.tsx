import { useState, type FormEvent, type ReactNode } from "react";

import type { SessionUser } from "@kernel";

import { ApiError, login } from "../boot/api.js";

export interface ReauthOverlayProps {
  readonly user: SessionUser;
  readonly bearer?: boolean;
  readonly onSignedIn: (user: SessionUser, token?: string) => void;
  readonly exportUnsent?: () => Promise<{ readonly count: number; readonly text: string }>;
}

export function ReauthOverlay({ user, bearer, onSignedIn, exportUnsent }: ReauthOverlayProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();

  const save = (): void => {
    if (!exportUnsent) return;
    exportUnsent()
      .then(({ count, text }) => {
        if (count === 0 && !text.includes("also not sent")) {
          setSaved("There are no unsent changes on this device.");
          return;
        }
        const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `unsent-changes-${new Date().toISOString().slice(0, 10)}.md`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setSaved(count === 1 ? "Saved 1 note to a file." : `Saved ${count} notes to a file.`);
      })
      .catch((cause: unknown) => setSaved(`Could not save: ${cause instanceof Error ? cause.message : String(cause)}`));
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setBusy(true);
    setError(undefined);
    login(user.email, password, bearer ?? false)
      .then((signed) => onSignedIn(signed.user, signed.token))
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError && cause.status === 429
            ? `Too many attempts. ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : String(cause),
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="ddd-reauth" role="dialog" aria-modal="true" aria-labelledby="ddd-reauth-title">
      <form className="ddd-auth-form" onSubmit={submit}>
        <h1 id="ddd-reauth-title">Your session expired</h1>
        <p className="ddd-auth-hint">
          Sign in again to keep syncing. <strong>Nothing local has been cleared</strong> — your
          workspace copy and any unsynced edits are still here, and will sync once you are back.
        </p>

        <label htmlFor="ddd-reauth-email">Email</label>
        <input id="ddd-reauth-email" type="email" value={user.email} readOnly autoComplete="username" />

        <label htmlFor="ddd-reauth-password">Password</label>
        <input
          id="ddd-reauth-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          // eslint-disable-next-line jsx-a11y/no-autofocus -- a modal that steals
          autoFocus
        />

        {error ? (
          <p className="ddd-auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {exportUnsent ? (
          <>
            <p className="ddd-auth-hint">Can’t sign in? Keep a copy of what has not synced.</p>
            <button type="button" className="ddd-auth-secondary" onClick={save}>
              Save my unsent changes to a file
            </button>
            {saved ? (
              <p className="ddd-auth-hint" role="status">
                {saved}
              </p>
            ) : null}
          </>
        ) : null}
      </form>
    </div>
  );
}
