/**
 * Users and invites.
 *
 * The guard rails are the **server's**, and this UI must not pretend otherwise (SPEC §5.1):
 *
 * - **The last admin cannot be demoted or deleted.** The button is disabled when this
 *   client can tell — it counts active admins — but the server refuses regardless, and a
 *   refusal renders as its message. Disabling a control is a hint; the 422 is the rule.
 * - **Deleting a user is a soft delete.** Sessions, tokens and reset links die; the
 *   attribution ids stay, and every screen that shows an actor renders a vanished account
 *   as "deleted user" (`api.ts`). Nothing that user wrote is removed — this is a shared
 *   workspace (SPEC §5.4).
 * - **Invites are single-use and expire in 7 days**, and the **token is returned exactly
 *   once**. It is therefore shown with a copy button and a warning, and never fetched
 *   again — the listing only has its hash.
 * - **A reset link is issued once too**, and it is the recovery path when someone cannot
 *   sign in. The CLI (`life-manager reset-password`) is the break-glass below it.
 */

import { useState } from "react";
import type { ReactElement } from "react";

import { AdminSectionFrame } from "./AdminView.js";
import { describeActor, formatWhen, type AdminClient, type CreatedInvite } from "./api.js";
import { useAsync, useMutation } from "./hooks.js";

export interface UsersSectionProps {
  readonly client: AdminClient;
  /** The signed-in user's id, so "you" is marked and self-demotion is obvious. */
  readonly selfId: string;
  /** Rendered inside settings, which has already drawn the heading. */
  readonly embedded?: boolean;
}

export function UsersSection({ client, selfId, embedded }: UsersSectionProps): ReactElement {
  const users = useAsync(() => client.users(), []);
  const mutation = useMutation(() => users.reload());
  const [issued, setIssued] = useState<{ readonly email: string; readonly token: string } | undefined>();

  const rows = users.data ?? [];
  const activeAdmins = rows.filter((user) => user.is_admin && user.is_active).length;

  return (
    <AdminSectionFrame id="users" title="Users" embedded={embedded}>
      {users.error && (
        <p className="admin-error" role="alert">
          {users.error}
        </p>
      )}
      {mutation.error && (
        <p className="admin-error" role="alert">
          {mutation.error}
        </p>
      )}

      {issued && (
        <div className="admin-secret" role="status">
          <p>
            Reset link for <strong>{issued.email}</strong>. Copy it now; it is shown once.
          </p>
          <code>{issued.token}</code>
          <CopyButton value={issued.token} />
          <button type="button" onClick={() => setIssued(undefined)}>
            Done
          </button>
        </div>
      )}

      {users.loading ? (
        <p role="status">Loading users…</p>
      ) : rows.length === 0 ? (
        <p className="admin-empty">No users returned. If you are not an administrator this list is empty by design.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Name</th>
                <th scope="col">Admin</th>
                <th scope="col">Created</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => {
                const lastAdmin = user.is_admin && user.is_active && activeAdmins <= 1;
                const busy = mutation.busy === user.id;
                return (
                  <tr key={user.id} className={user.is_active ? undefined : "admin-row-inactive"}>
                    <th scope="row">
                      {user.email}
                      {user.id === selfId && <span className="admin-badge">you</span>}
                      {!user.is_active && <span className="admin-badge">deleted</span>}
                    </th>
                    <td data-label="Name">{user.name || "—"}</td>
                    <td data-label="Admin">
                      <label className="admin-checkbox">
                        <input
                          type="checkbox"
                          checked={user.is_admin}
                          disabled={busy || !user.is_active || lastAdmin}
                          onChange={(event) =>
                            mutation.run(user.id, () =>
                              client.updateUser(user.id, { is_admin: event.target.checked }),
                            )
                          }
                        />
                        <span className="admin-visually-hidden">Administrator</span>
                      </label>
                      {lastAdmin && <span className="admin-hint">last admin</span>}
                    </td>
                    <td data-label="Created">{formatWhen(user.created_at)}</td>
                    <td data-label="Last sign-in">{formatWhen(user.last_login_at)}</td>
                    <td className="admin-actions">
                      <button
                        type="button"
                        disabled={busy || !user.is_active}
                        onClick={() =>
                          mutation.run(user.id, async () => {
                            const reset = await client.issueReset(user.id);
                            setIssued({ email: user.email, token: reset.token });
                          })
                        }
                      >
                        Reset link
                      </button>
                      <button
                        type="button"
                        className="admin-danger"
                        disabled={busy || !user.is_active || lastAdmin}
                        onClick={() => {
                          if (
                            !confirm(
                              `Delete ${user.email}? Their sessions end now; what they wrote stays, attributed to a deleted user.`,
                            )
                          ) {
                            return;
                          }
                          mutation.run(user.id, () => client.deleteUser(user.id));
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* The spec reference belonged to whoever built this screen, not to the
          administrator reading it. The sentence says the same thing without it. */}
      <p className="admin-note">
        Everyone signed in can read, edit and delete every document. The audit log
        records who did what.
      </p>
    </AdminSectionFrame>
  );
}

export function InvitesSection({
  client,
  embedded,
}: {
  readonly client: AdminClient;
  readonly embedded?: boolean;
}): ReactElement {
  const invites = useAsync(() => client.invites(), []);
  const mutation = useMutation(() => invites.reload());
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<CreatedInvite | undefined>(undefined);
  const users = useAsync(() => client.users(), []);

  const rows = invites.data ?? [];

  return (
    <AdminSectionFrame id="invites" title="Invites" embedded={embedded}>
      {(invites.error ?? mutation.error) && (
        <p className="admin-error" role="alert">
          {invites.error ?? mutation.error}
        </p>
      )}

      <form
        className="admin-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.run("create", async () => {
            const result = await client.createInvite(email.trim() || undefined);
            setCreated(result);
            setEmail("");
          });
        }}
      >
        <label className="admin-field">
          <span>Email (optional). Pins the invite to one address.</span>
          <input
            type="email"
            value={email}
            placeholder="someone@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button type="submit" disabled={mutation.busy === "create"}>
          Create invite
        </button>
      </form>

      {created && (
        <div className="admin-secret" role="status">
          <p>
            Invite token, <strong>shown once</strong>. Single-use; expires{" "}
            {formatWhen(created.invite.expires_at)}.
          </p>
          <code>{created.token}</code>
          <CopyButton value={created.token} />
          <button type="button" onClick={() => setCreated(undefined)}>
            Done
          </button>
        </div>
      )}

      {invites.loading && invites.data === undefined ? (
        <p role="status">Loading invites…</p>
      ) : rows.length === 0 ? (
        <p className="admin-empty">No invites. People need one to register.</p>
      ) : (
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Email</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col">Used</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invite) => (
                <tr key={invite.id}>
                  <th scope="row">
                    <span className={`admin-status admin-status-${invite.status}`}>{invite.status}</span>
                  </th>
                  <td data-label="Email">{invite.email ?? "any"}</td>
                  <td data-label="Created">
                    {formatWhen(invite.created_at)}
                    <span className="admin-hint">
                      by {describeActor(invite.created_by, users.data ?? [])}
                    </span>
                  </td>
                  <td data-label="Expires">{formatWhen(invite.expires_at)}</td>
                  <td data-label="Used">
                    {invite.used_at
                      ? `${formatWhen(invite.used_at)} — ${describeActor(invite.used_by, users.data ?? [])}`
                      : "—"}
                  </td>
                  <td className="admin-actions">
                    <button
                      type="button"
                      disabled={mutation.busy === invite.id || invite.status !== "pending"}
                      onClick={() => mutation.run(invite.id, () => client.revokeInvite(invite.id))}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="admin-note">
        A lost token cannot be recovered. Revoke it and create another.
      </p>
    </AdminSectionFrame>
  );
}

/**
 * Copy to clipboard, with the fallback that matters: `navigator.clipboard` needs a secure
 * context, and a token the user cannot copy is a token they have to retype from a
 * screenshot.
 */
export function CopyButton({ value }: { readonly value: string }): ReactElement {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setState("copied"))
          .catch(() => setState("failed"));
        if (!navigator.clipboard) setState("failed");
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select it above and copy" : "Copy"}
    </button>
  );
}
