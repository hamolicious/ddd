/**
 * The auth gate: the only screen that exists before the kernel.
 *
 * It is part of the app rather than a plugin because plugins are served *to
 * authenticated clients* — a login screen that needed a plugin to render could not
 * be reached by anyone who is not already logged in.
 *
 * Registration is invite-only past the first user (SPEC §5.1), and the first user
 * becomes admin; `/api/auth/bootstrap` says which case this is, so the form can ask
 * for an invite token only when one is actually required.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { SessionUser } from "@kernel";

import { ApiError, authBootstrap, login, redeemReset, register, type AuthBootstrap } from "./api.js";

export function AuthGate({
  onSignedIn,
  bearer,
  resetToken,
}: {
  readonly onSignedIn: (user: SessionUser, token?: string) => void;
  /** Shells authenticate with a bearer token (SPEC §5.2); browsers use the cookie. */
  readonly bearer?: boolean;
  /** Opened from a reset link (`#/reset/<token>`): ask for a new password first. */
  readonly resetToken?: string;
}): ReactNode {
  const [state, setState] = useState<AuthBootstrap | undefined>();
  const [mode, setMode] = useState<"sign-in" | "register" | "reset">(resetToken ? "reset" : "sign-in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    authBootstrap()
      .then((bootstrap) => {
        setState(bootstrap);
        // A workspace with no users at all can only be registered into.
        if (bootstrap.needs_first_user && !resetToken) setMode("register");
      })
      .catch((cause: unknown) => setError(describe(cause)));
  }, []);

  const submitReset = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("new-password") ?? "");
    if (password !== String(form.get("confirm-password") ?? "")) {
      setError("The two passwords are not the same.");
      return;
    }
    setBusy(true);
    setError(undefined);
    redeemReset(resetToken ?? "", password)
      .then(() => {
        // The link is spent: take it out of the address so a reload does not ask again.
        history.replaceState(null, "", location.pathname + location.search);
        setMode("sign-in");
        setNotice("Your password is changed. Sign in with it.");
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  };

  if (mode === "reset") {
    return (
      <div className="lm-auth">
        <form className="lm-auth-form" onSubmit={submitReset}>
          <h1>Set a new password</h1>
          <p className="lm-auth-hint">
            This link works once. Choose a password of at least 10 characters, then sign
            in with it.
          </p>

          <label htmlFor="new-password">New password</label>
          <input id="new-password" name="new-password" type="password" autoComplete="new-password" required minLength={10} />

          <label htmlFor="confirm-password">New password again</label>
          <input id="confirm-password" name="confirm-password" type="password" autoComplete="new-password" required minLength={10} />

          {error ? (
            <p className="lm-auth-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" disabled={busy}>
            {busy ? "Working…" : "Set password"}
          </button>
          <button
            type="button"
            className="lm-auth-switch"
            onClick={() => {
              setMode("sign-in");
              setError(undefined);
            }}
          >
            Back to sign in
          </button>
        </form>
      </div>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const invite = String(form.get("invite") ?? "");
    setBusy(true);
    setError(undefined);
    const attempt =
      mode === "register"
        ? register(email, password, invite || undefined, bearer ?? false)
        : login(email, password, bearer ?? false);
    attempt
      .then((signed) => onSignedIn(signed.user, signed.token))
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="lm-auth">
      <form className="lm-auth-form" onSubmit={submit}>
        <h1>Life Manager</h1>
        {notice ? (
          <p className="lm-auth-hint" role="status">
            {notice}
          </p>
        ) : null}
        {state?.needs_first_user ? (
          <p className="lm-auth-hint">
            This workspace has no users yet. The account you create becomes the
            administrator.
          </p>
        ) : null}

        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          required
          minLength={mode === "register" ? 10 : undefined}
        />

        {mode === "register" && state?.invite_required ? (
          <>
            <label htmlFor="invite">Invite token</label>
            <input id="invite" name="invite" type="text" required />
          </>
        ) : null}

        {error ? (
          <p className="lm-auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "register" ? "Create account" : "Sign in"}
        </button>

        {state?.needs_first_user ? null : (
          <button
            type="button"
            className="lm-auth-switch"
            onClick={() => {
              setMode(mode === "sign-in" ? "register" : "sign-in");
              setError(undefined);
            }}
          >
            {mode === "sign-in" ? "I have an invite" : "Back to sign in"}
          </button>
        )}
      </form>
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    // 429 carries the backoff of SPEC §5.2; saying so beats "request failed".
    return cause.status === 429
      ? `Too many attempts. ${cause.message}`
      : cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
