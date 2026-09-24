/**
 * The account section: who is signed in, changing the password, and signing out.
 *
 * **Sign-out is the one destructive local path** (SPEC §5.3): it clears the projection,
 * the hydrated replicas and the search index, which is what deletes the only copy of an
 * edit that never reached the server. So the button reads `kernel.sync.state.pending`
 * live, refuses while it is non-zero, and offers discarding only as a second, explicitly
 * labelled action. The kernel enforces the same rule — this UI exists so the user finds
 * out *before* clicking, not from an error afterwards.
 *
 * Changing the password signs every other device out (the server revokes the other
 * sessions), so the form says so before it is submitted rather than after.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { Kernel } from "@kernel";

export function AccountSection({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const user = kernel.session.user;
  return (
    <div className="settings-account">
      <dl className="settings-facts">
        <dt>Signed in as</dt>
        <dd>
          {user.email}
          {user.isAdmin ? <span className="settings-badge">admin</span> : null}
        </dd>
        <dt>Name</dt>
        <dd>{user.name ?? <span className="settings-muted">not set</span>}</dd>
        <dt>Session</dt>
        <dd>{kernel.session.via === "bearer" ? "bearer token (app shell)" : "browser cookie"}</dd>
      </dl>

      <PasswordForm kernel={kernel} />
      <SignOut kernel={kernel} />
    </div>
  );
}

function PasswordForm({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    setDone(false);
    if (newPassword !== confirmation) {
      setError("The new password and its confirmation do not match.");
      return;
    }
    setBusy(true);
    try {
      await kernel.session.fetch("/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setDone(true);
    } catch (cause) {
      // A wrong current password is a 422 here, deliberately not a 401 — so it must
      // read as "that password is wrong", never as "you have been signed out".
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={(event) => void submit(event)}>
      <h3>Change password</h3>
      <p className="settings-muted">
        Changing your password signs out every other device. This one stays signed in.
      </p>
      <label>
        Current password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </label>
      <label>
        New password
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </label>
      <label>
        Repeat the new password
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="settings-ok" role="status">
          Password changed. Other devices have been signed out.
        </p>
      ) : null}
      <button type="submit" disabled={busy}>
        {busy ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}

function SignOut({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const pending = usePending(kernel);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const signOut = async (discardUnsynced: boolean): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      await kernel.session.logout(discardUnsynced ? { discardUnsynced: true } : {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-signout">
      <h3>Sign out</h3>
      <p className="settings-muted">
        Signing out clears this device's local copy of the workspace — the offline
        projection, the documents you have opened and the search index. Anything already
        synced stays on the server.
      </p>
      {pending > 0 ? (
        <p className="settings-warning" role="status">
          {pending} local edit{pending === 1 ? "" : "s"} {pending === 1 ? "has" : "have"} not
          reached the server yet. Wait for the sync indicator to settle, or sign out
          discarding them — that cannot be undone.
        </p>
      ) : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => void signOut(false)}>
          Sign out
        </button>
        {pending > 0 ? (
          <button
            type="button"
            className="settings-danger"
            disabled={busy}
            onClick={() => void signOut(true)}
          >
            Sign out and discard {pending} edit{pending === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** Unsynced local edits, live. `kernel.sync.subscribe` fires immediately. */
function usePending(kernel: Kernel): number {
  const [pending, setPending] = useState(() => kernel.sync.state.pending);
  useEffect(() => kernel.sync.subscribe((state) => setPending(state.pending)), [kernel]);
  return pending;
}
