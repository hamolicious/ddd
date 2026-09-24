/**
 * The typed client over `/api/admin/*` and the two admin-facing corners of the document
 * and attachment APIs.
 *
 * **The server authorizes; this file only asks.** Every route here returns 403 to a
 * non-admin, so nothing in this plugin is a security control — hiding a button is a
 * courtesy to the user, and the client is written so that a 403 surfaces as an error
 * message rather than as an empty table that looks like "no users".
 *
 * Shapes mirror the Rust response types (`crates/server/src/routes/admin.rs`,
 * `attachments.rs`, `documents.rs`) and are **snake_case**, because that is what the wire
 * carries everywhere except `/api/plugins` — which is `InstalledPlugin` from
 * `kernel-api/src/manifest.ts` and camelCase, since a plugin manifest is written by hand
 * (`backend/CONTRACTS.md`, area server-static). That inconsistency is deliberate upstream,
 * so it is named here rather than smoothed over.
 *
 * Timestamps are RFC 3339 strings, never extended JSON: the server has a test that scans
 * whole response bodies for `$date`/`$oid`, so anything arriving here is a plain string.
 */

import type { InstalledPlugin, ManifestProblem } from "@kernel";

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly is_admin: boolean;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly last_login_at?: string;
}

export interface InviteView {
  readonly id: string;
  readonly email: string | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly expires_at: string;
  readonly used_at: string | null;
  readonly used_by: string | null;
  readonly revoked_at: string | null;
  /** `pending` | `used` | `revoked` | `expired`, derived by the server. */
  readonly status: string;
}

export interface CreatedInvite {
  readonly invite: InviteView;
  /** Returned exactly once, at creation. */
  readonly token: string;
}

export interface PasswordResetIssued {
  readonly user_id: string;
  readonly token: string;
  readonly expires_at: string;
}

export interface AuditView {
  readonly id: string;
  readonly action: string;
  readonly actor: string | null;
  readonly target_kind: string;
  readonly target_id: string | null;
  readonly detail: unknown;
  readonly ip: string | null;
  readonly created_at: string;
}

export interface AuditPage {
  readonly entries: readonly AuditView[];
  readonly next_cursor?: string;
}

export interface AttachmentView {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly revision: number;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly updated_at: string;
  readonly updated_by: string | null;
}

export interface OrphanView {
  readonly attachment: AttachmentView;
  readonly flagged_at: string;
}

export interface SnapshotView {
  readonly id: string;
  readonly document_id: string;
  readonly title: string;
  readonly reason: string;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly size: number;
}

export interface AdminStats {
  readonly documents: number;
  readonly trashed_documents: number;
  readonly graveyard_entries: number;
  readonly attachments: number;
  readonly attachment_bytes: number;
  readonly users: number;
  readonly schema_version: number;
  readonly oversized_documents: number;
}

export interface InstalledPluginsResponse {
  readonly plugins: readonly InstalledPlugin[];
  readonly problems: readonly { readonly path: string; readonly message: string }[];
  readonly disabled: boolean;
}

export interface AuditQuery {
  readonly action?: string;
  readonly actor?: string;
  readonly target_id?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AdminClient {
  stats(): Promise<AdminStats>;

  users(): Promise<readonly UserView[]>;
  updateUser(id: string, changes: { readonly is_admin?: boolean; readonly name?: string }): Promise<UserView>;
  deleteUser(id: string): Promise<void>;
  issueReset(id: string): Promise<PasswordResetIssued>;

  invites(): Promise<readonly InviteView[]>;
  createInvite(email?: string): Promise<CreatedInvite>;
  revokeInvite(id: string): Promise<void>;

  audit(query?: AuditQuery): Promise<AuditPage>;

  orphans(): Promise<readonly OrphanView[]>;
  scanOrphans(): Promise<readonly OrphanView[]>;
  deleteAttachment(id: string): Promise<void>;

  snapshots(documentId: string): Promise<readonly SnapshotView[]>;
  createSnapshot(documentId: string): Promise<void>;
  restoreSnapshot(documentId: string, snapshotId: string): Promise<void>;

  plugins(): Promise<InstalledPluginsResponse>;
  /** The zip of every document as plain markdown — the no-Mongo recovery path. */
  exportWorkspace(): Promise<Blob>;
}

export function createAdminClient(fetchApi: ApiFetch): AdminClient {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchApi(path, init);
    return (await response.json()) as T;
  };
  const send = async (path: string, init: RequestInit): Promise<void> => {
    await fetchApi(path, init);
  };
  const postJson = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const id = (value: string): string => encodeURIComponent(value);

  return {
    stats: () => json<AdminStats>("/admin/stats"),

    users: () => json<readonly UserView[]>("/admin/users"),
    updateUser: (userId, changes) =>
      json<UserView>(`/admin/users/${id(userId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      }),
    deleteUser: (userId) => send(`/admin/users/${id(userId)}`, { method: "DELETE" }),
    issueReset: (userId) => json<PasswordResetIssued>(`/admin/users/${id(userId)}/reset`, postJson({})),

    invites: () => json<readonly InviteView[]>("/admin/invites"),
    createInvite: (email) =>
      json<CreatedInvite>("/admin/invites", postJson(email ? { email } : {})),
    revokeInvite: (inviteId) => send(`/admin/invites/${id(inviteId)}`, { method: "DELETE" }),

    audit: (query = {}) => json<AuditPage>(`/admin/audit${auditParams(query)}`),

    orphans: () => json<readonly OrphanView[]>("/attachments/orphans"),
    scanOrphans: () => json<readonly OrphanView[]>("/attachments/orphans/scan", { method: "POST" }),
    deleteAttachment: (attachmentId) => send(`/attachments/${id(attachmentId)}`, { method: "DELETE" }),

    snapshots: (documentId) => json<readonly SnapshotView[]>(`/documents/${id(documentId)}/snapshots`),
    createSnapshot: (documentId) =>
      send(`/documents/${id(documentId)}/snapshots`, postJson({ reason: "manual" })),
    restoreSnapshot: (documentId, snapshotId) =>
      send(`/documents/${id(documentId)}/snapshots/${id(snapshotId)}/restore`, { method: "POST" }),

    plugins: () => json<InstalledPluginsResponse>("/plugins"),
    exportWorkspace: async () => (await fetchApi("/admin/export")).blob(),
  };
}

/** Only the parameters that are set; an empty `action=` would filter on the empty string. */
export function auditParams(query: AuditQuery): string {
  const params = new URLSearchParams();
  if (query.action?.trim()) params.set("action", query.action.trim());
  if (query.actor?.trim()) params.set("actor", query.actor.trim());
  if (query.target_id?.trim()) params.set("target_id", query.target_id.trim());
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

/** Human-readable bytes. Binary units, because that is what the storage numbers mean. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** A timestamp for display. Never for ordering — that is `seq` and the CRDT. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * Attribution that a deleted account keeps.
 *
 * Deleting a user soft-deletes the row and keeps the attribution id (SPEC §5.1), so an
 * id that no longer resolves to an active account renders as "deleted user" rather than a
 * raw ULID — and `plugin:<id>` and `system` actors are labelled as what they are.
 */
export function describeActor(actor: string | null | undefined, users: readonly UserView[]): string {
  if (!actor) return "—";
  if (actor === "system") return "system";
  if (actor.startsWith("plugin:")) return `plugin ${actor.slice("plugin:".length)}`;
  const user = users.find((candidate) => candidate.id === actor);
  if (!user) return `deleted user (${actor})`;
  return user.is_active ? user.email : `${user.email} (deleted)`;
}

/** Problems the loader found in a manifest, for the read-only plugin list. */
export type PluginManifestProblem = ManifestProblem;
