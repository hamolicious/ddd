import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { SessionUser } from "@kernel";

import { ApiError, authBootstrap, login, redeemReset, register, type AuthBootstrap } from "./api.js";

export function AuthGate({
  onSignedIn,
  bearer,
  resetToken,
  inviteToken,
}: {
  readonly onSignedIn: (user: SessionUser, token?: string) => void;
  readonly bearer?: boolean;
  readonly resetToken?: string;
  readonly inviteToken?: string;
}): ReactNode {
  const [state, setState] = useState<AuthBootstrap | undefined>();
  const [mode, setMode] = useState<"sign-in" | "register" | "reset">(
    resetToken ? "reset" : inviteToken ? "register" : "sign-in",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    authBootstrap()
      .then((bootstrap) => {
        setState(bootstrap);
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
        history.replaceState(null, "", location.pathname + location.search);
        setMode("sign-in");
        setNotice("Your password is changed. Sign in with it.");
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  };

  if (mode === "reset") {
    return (
      <div className="ddd-auth">
        <form className="ddd-auth-form" onSubmit={submitReset}>
          <h1>Set a new password</h1>
          <p className="ddd-auth-hint">
            This link works once. Choose a password of at least 10 characters, then sign
            in with it.
          </p>

          <label htmlFor="new-password">New password</label>
          <input id="new-password" name="new-password" type="password" autoComplete="new-password" required minLength={10} />

          <label htmlFor="confirm-password">New password again</label>
          <input id="confirm-password" name="confirm-password" type="password" autoComplete="new-password" required minLength={10} />

          {error ? (
            <p className="ddd-auth-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" disabled={busy}>
            {busy ? "Working…" : "Set password"}
          </button>
          <button
            type="button"
            className="ddd-auth-switch"
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
      .then((signed) => {
        if (inviteToken) history.replaceState(null, "", location.pathname + location.search);
        onSignedIn(signed.user, signed.token);
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="ddd-auth">
      <form className="ddd-auth-form" onSubmit={submit}>
        <h1>ddd</h1>
        {notice ? (
          <p className="ddd-auth-hint" role="status">
            {notice}
          </p>
        ) : null}
        {state?.needs_first_user ? (
          <p className="ddd-auth-hint">
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
            <input id="invite" name="invite" type="text" required defaultValue={inviteToken} />
          </>
        ) : null}

        {error ? (
          <p className="ddd-auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "register" ? "Create account" : "Sign in"}
        </button>

        {state?.needs_first_user ? null : (
          <button
            type="button"
            className="ddd-auth-switch"
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
    return cause.status === 429
      ? `Too many attempts. ${cause.message}`
      : cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
