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

import { describeActor, formatWhen, type AdminClient, type CreatedInvite } from "./api.js";
import { useAsync, useMutation } from "./hooks.js";

export interface UsersSectionProps {
  readonly client: AdminClient;
  /** The signed-in user's id, so "you" is marked and self-demotion is obvious. */
  readonly selfId: string;
}

export function UsersSection({ client, selfId }: UsersSectionProps): ReactElement {
  const users = useAsync(() => client.users(), []);
  const mutation = useMutation(() => users.reload());
  const [issued, setIssued] = useState<{ readonly email: string; readonly token: string } | undefined>();

  const rows = users.data ?? [];
  const activeAdmins = rows.filter((user) => user.is_admin && user.is_active).length;

  return (
    <section className="admin-section" aria-labelledby="admin-users-heading">
      <h3 id="admin-users-heading">Users</h3>

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
            One-time password reset link for <strong>{issued.email}</strong>. It is shown
            once — copy it now.
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
                    <td>{user.name || "—"}</td>
                    <td>
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
                    <td>{formatWhen(user.created_at)}</td>
                    <td>{formatWhen(user.last_login_at)}</td>
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
                              `Delete ${user.email}? Their sessions end immediately. Everything they wrote stays, attributed to a deleted user.`,
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
        This is a shared workspace: every signed-in user can read, edit and delete every
        document. The audit log is the accountability here, not permissions.
      </p>
    </section>
  );
}

export function InvitesSection({ client }: { readonly client: AdminClient }): ReactElement {
  const invites = useAsync(() => client.invites(), []);
  const mutation = useMutation(() => invites.reload());
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<CreatedInvite | undefined>(undefined);
  const users = useAsync(() => client.users(), []);

  const rows = invites.data ?? [];

  return (
    <section className="admin-section" aria-labelledby="admin-invites-heading">
      <h3 id="admin-invites-heading">Invites</h3>

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
          <span>Email (optional — pins the invite to one address)</span>
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
            Invite token — <strong>shown once</strong>. It is single-use and expires{" "}
            {formatWhen(created.invite.expires_at)}.
          </p>
          <code>{created.token}</code>
          <CopyButton value={created.token} />
          <button type="button" onClick={() => setCreated(undefined)}>
            Done
          </button>
        </div>
      )}

      {invites.loading ? (
        <p role="status">Loading invites…</p>
      ) : rows.length === 0 ? (
        <p className="admin-empty">
          No invites. After the first user, registration needs one — so this is also the
          answer to “why can nobody sign up”.
        </p>
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
                  <td>{invite.email ?? "any"}</td>
                  <td>
                    {formatWhen(invite.created_at)}
                    <span className="admin-hint">
                      by {describeActor(invite.created_by, users.data ?? [])}
                    </span>
                  </td>
                  <td>{formatWhen(invite.expires_at)}</td>
                  <td>
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
        The listing stores only a hash of each token, so a lost token cannot be recovered —
        revoke it and create another.
      </p>
    </section>
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
