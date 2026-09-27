/**
 * Re-authentication, mid-session (SPEC §5.3; PROTOCOL.md §8, close code 4401).
 *
 * The rule this screen exists to keep: **a 401 never clears local data.** The
 * session expired, or an admin revoked it, or the server restarted with a rotated
 * `SESSION_SECRET` — none of which says anything about the workspace copy in
 * IndexedDB, and one of which (revocation while a document has unsynced edits) is
 * exactly when discarding it would be unforgivable. So this is an *overlay*: the app
 * stays mounted and readable underneath, nothing is cleared, and signing in again
 * resumes the same session state.
 *
 * It is rendered by the frame rather than by `shell-ui`, for the same reason the
 * notice strip is: it has to work when the shell is the thing that is broken.
 */

import { useState, type FormEvent, type ReactNode } from "react";

import type { SessionUser } from "@kernel";

import { ApiError, login } from "../boot/api.js";

export interface ReauthOverlayProps {
  /** The user whose session lapsed — the email is prefilled, never editable here. */
  readonly user: SessionUser;
  /** Shell sessions get a new bearer token back (SPEC §5.2). */
  readonly bearer?: boolean;
  /**
   * Called on success. A cookie session can simply resume (`reconnectNow`); a shell
   * session hands back a *new* token, and the caller decides what to do with it.
   */
  readonly onSignedIn: (user: SessionUser, token?: string) => void;
  /**
   * Everything the server has not got, as a Markdown file: the way out for someone who
   * cannot sign in again (password reset, account removed).
   */
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
    <div className="lm-reauth" role="dialog" aria-modal="true" aria-labelledby="lm-reauth-title">
      <form className="lm-auth-form" onSubmit={submit}>
        <h1 id="lm-reauth-title">Your session expired</h1>
        <p className="lm-auth-hint">
          Sign in again to keep syncing. <strong>Nothing local has been cleared</strong> — your
          workspace copy and any unsynced edits are still here, and will sync once you are back.
        </p>

        <label htmlFor="lm-reauth-email">Email</label>
        <input id="lm-reauth-email" type="email" value={user.email} readOnly autoComplete="username" />

        <label htmlFor="lm-reauth-password">Password</label>
        <input
          id="lm-reauth-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          // eslint-disable-next-line jsx-a11y/no-autofocus -- a modal that steals
          // focus is correct here: it is the only thing the user can act on.
          autoFocus
        />

        {error ? (
          <p className="lm-auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {exportUnsent ? (
          <>
            <p className="lm-auth-hint">Can’t sign in? Keep a copy of what has not synced.</p>
            <button type="button" className="lm-auth-secondary" onClick={save}>
              Save my unsent changes to a file
            </button>
            {saved ? (
              <p className="lm-auth-hint" role="status">
                {saved}
              </p>
            ) : null}
          </>
        ) : null}
      </form>
    </div>
  );
}
