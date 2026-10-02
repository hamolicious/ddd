import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { Kernel } from "@kernel";

export function AccountSection({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const user = kernel.session.user;
  return (
    <div className="settings:grid settings:gap-6">
      <dl className="settings:m-0 settings:grid settings:grid-cols-[max-content_1fr] settings:gap-x-4 settings:gap-y-1 settings:[&_dd]:m-0 settings:[&_dt]:text-text-muted">
        <dt>Signed in as</dt>
        <dd>
          {user.email}
          {user.isAdmin ? <span className="settings:ml-1.5 settings:rounded settings:border settings:border-accent settings:bg-accent-subtle settings:px-1 settings:text-xs settings:uppercase">admin</span> : null}
        </dd>
        <dt>Name</dt>
        <dd>{user.name ?? <span className="settings:text-text-muted">not set</span>}</dd>
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form settings:m-0 settings:grid settings:max-w-96 settings:gap-2 settings:compact:max-w-none settings:[&_button]:tap-h settings:[&_button]:cursor-pointer settings:[&_button]:rounded settings:[&_button]:border settings:[&_button]:border-border-strong settings:[&_button]:bg-bg-raised settings:[&_button]:px-3 settings:[&_button]:text-inherit settings:[&_button[type=submit]]:justify-self-start settings:[&_button[type=submit]]:border-accent settings:[&_button[type=submit]]:bg-accent settings:[&_button[type=submit]]:text-accent-text settings:[&_h3]:m-0 settings:[&_label]:grid settings:[&_label]:gap-0.5 settings:[&_input]:box-border settings:[&_input]:tap-h settings:[&_input]:w-full settings:[&_input]:rounded settings:[&_input]:border settings:[&_input]:border-border settings:[&_input]:bg-bg settings:[&_input]:px-2.5 settings:[&_input]:text-inherit" onSubmit={(event) => void submit(event)}>
      <h3>Change password</h3>
      <p className="settings:text-text-muted">
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
        <p className="settings:m-0 settings:text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="settings:m-0 settings:text-success" role="status">
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
    <section className="settings:grid settings:max-w-[34rem] settings:gap-2 settings:compact:max-w-none settings:[&_h3]:m-0">
      <h3>Sign out</h3>
      <p className="settings:text-text-muted">
        Signing out clears this device's local copy of the workspace. Anything already
        synced stays on the server.
      </p>
      {pending > 0 ? (
        <p className="settings:m-0 settings:rounded settings:border-l-[3px] settings:border-warning settings:bg-bg-subtle settings:p-2" role="status">
          {pending} local edit{pending === 1 ? "" : "s"} {pending === 1 ? "has" : "have"} not
          reached the server yet. Wait for the sync indicator to settle, or sign out
          discarding them. Discarded edits cannot be recovered.
        </p>
      ) : null}
      {error ? (
        <p className="settings:m-0 settings:text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings:flex settings:flex-wrap settings:gap-2 settings:[&_button]:tap-h settings:[&_button]:cursor-pointer settings:[&_button]:rounded settings:[&_button]:border settings:[&_button]:border-border-strong settings:[&_button]:bg-bg-raised settings:[&_button]:px-3 settings:[&_button]:text-inherit">
        <button type="button" disabled={busy} onClick={() => void signOut(false)}>
          Sign out
        </button>
        {pending > 0 ? (
          <button
            type="button"
            className="settings:border-danger! settings:bg-danger! settings:text-danger-text!"
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

function usePending(kernel: Kernel): number {
  const [pending, setPending] = useState(() => kernel.sync.state.pending);
  useEffect(() => kernel.sync.subscribe((state) => setPending(state.pending)), [kernel]);
  return pending;
}
