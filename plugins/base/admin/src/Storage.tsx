/**
 * Orphan attachments and the workspace export.
 *
 * **Orphans are flagged, never auto-deleted** (SPEC §3.6). The scan reads *materialized
 * text*, which is why it covers plugin-held references inside `%%%` sections for free, and
 * why a tombstoned document still counts as referencing its file: restoring a document must
 * not find its attachment already collected. Deletion is one explicit click per file, and
 * the confirmation says the bytes go away.
 *
 * **The export is the no-Mongo recovery path**: a zip of every document as plain markdown.
 * It is fetched through the authenticated `fetch` rather than linked, because a bearer
 * session (the Flutter shell, SPEC §5.2) has no cookie for the browser to attach.
 */

import type { ReactElement } from "react";

import { AdminSectionFrame } from "./AdminView.js";
import { formatBytes, formatWhen, type AdminClient } from "./api.js";
import { useAsync, useConfirm, useMutation } from "./hooks.js";
import { RefreshIcon, ScanIcon, TrashIcon } from "./icons.js";
import { Info } from "./Info.js";

export function OrphansSection({
  client,
  embedded,
}: {
  readonly client: AdminClient;
  readonly embedded?: boolean;
}): ReactElement {
  const orphans = useAsync(() => client.orphans(), []);
  const mutation = useMutation(() => orphans.reload());
  const confirm = useConfirm();
  const rows = orphans.data ?? [];
  const total = rows.reduce((sum, row) => sum + row.attachment.size, 0);

  return (
    <AdminSectionFrame id="orphans" title="Orphan files" embedded={embedded}>
      <p className="admin-note">
        Files no document references. Nothing is deleted automatically; a file used only
        by a trashed document is not an orphan.
      </p>

      {(orphans.error ?? mutation.error) && (
        <p className="admin-error" role="alert">
          {orphans.error ?? mutation.error}
        </p>
      )}

      <div className="admin-actions">
        <button
          type="button"
          className="admin-icon-button"
          aria-label="Run the scan now"
          title="Run the scan now"
          disabled={mutation.busy === "scan"}
          onClick={() => mutation.run("scan", () => client.scanOrphans())}
        >
          <ScanIcon />
        </button>
        <button
          type="button"
          className="admin-icon-button"
          aria-label="Refresh"
          title="Refresh"
          onClick={() => orphans.reload()}
        >
          <RefreshIcon />
        </button>
      </div>

      {orphans.loading ? (
        <p role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-empty">No orphan files. Every stored file is referenced.</p>
      ) : (
        <>
          <p className="admin-note">
            {rows.length} file{rows.length === 1 ? "" : "s"}, {formatBytes(total)} total.
          </p>
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Size</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col">Flagged</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ attachment, flagged_at }) => (
                  <tr key={attachment.id}>
                    <th scope="row">
                      {/* The viewer's file page: look before deleting. */}
                      <a className="admin-link" href={`#/file/${encodeURIComponent(attachment.id)}`}>
                        {attachment.name}
                      </a>
                      <span className="admin-hint">{attachment.id}</span>
                    </th>
                    <td data-label="Type">{attachment.mime}</td>
                    <td data-label="Size">{formatBytes(attachment.size)}</td>
                    <td data-label="Uploaded">{formatWhen(attachment.created_at)}</td>
                    <td data-label="Flagged">{formatWhen(flagged_at)}</td>
                    <td className="admin-actions">
                      <button
                        type="button"
                        className="admin-danger admin-icon-button"
                        aria-label={`Delete ${attachment.name}`}
                        title="Delete"
                        disabled={mutation.busy === attachment.id}
                        onClick={(event) => {
                          void confirm({
                            title: `Delete ${attachment.name} permanently?`,
                            description: "The file cannot be recovered.",
                            danger: true,
                            anchor: event.currentTarget,
                          }).then((ok) => {
                            if (ok) mutation.run(attachment.id, () => client.deleteAttachment(attachment.id));
                          });
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AdminSectionFrame>
  );
}

export function ExportSection({
  client,
  embedded,
}: {
  readonly client: AdminClient;
  readonly embedded?: boolean;
}): ReactElement {
  const mutation = useMutation();
  const stats = useAsync(() => client.stats(), []);

  return (
    <AdminSectionFrame id="workspace" title="Workspace" embedded={embedded}>
      {stats.error && (
        <p className="admin-error" role="alert">
          {stats.error}
        </p>
      )}

      {stats.data && (
        <dl className="admin-stats">
          <div>
            <dt>Documents</dt>
            <dd>{stats.data.documents}</dd>
          </div>
          <div>
            <dt>In Trash</dt>
            <dd>{stats.data.trashed_documents}</dd>
          </div>
          <div>
            <dt>Permanently deleted ids</dt>
            <dd>{stats.data.graveyard_entries}</dd>
          </div>
          <div>
            <dt>Attachments</dt>
            <dd>
              {stats.data.attachments} ({formatBytes(stats.data.attachment_bytes)})
            </dd>
          </div>
          <div>
            <dt>Users</dt>
            <dd>{stats.data.users}</dd>
          </div>
          <div>
            <dt>Schema version</dt>
            <dd>{stats.data.schema_version}</dd>
          </div>
          <div>
            <dt>
              Large edit history
              <Info title="Large edit history">
                <p className="admin:m-0">
                  Documents whose saved edit history (what syncing between devices uses) is
                  over {formatBytes(stats.data.large_history_bytes ?? 4 * 1024 * 1024)}. The
                  text itself is capped at 1 MB; this is the history behind it.
                </p>
                <p className="admin:m-0">
                  Large histories open and sync more slowly. The server logs a warning above{" "}
                  {formatBytes(stats.data.history_alert_bytes ?? 8 * 1024 * 1024)}.
                </p>
                <p className="admin:m-0 admin:text-text-muted">
                  Counted since the server started. Set with{" "}
                  <code>CRDT_COMPACT_THRESHOLD_BYTES</code> and{" "}
                  <code>CRDT_ALERT_THRESHOLD_BYTES</code>.
                </p>
              </Info>
            </dt>
            <dd>{stats.data.oversized_documents}</dd>
          </div>
        </dl>
      )}

      <p className="admin-note">
        A zip of every document as markdown. It does not include history, snapshots or
        attachments — back up the database too.
      </p>

      {mutation.error && (
        <p className="admin-error" role="alert">
          {mutation.error}
        </p>
      )}

      <button
        type="button"
        disabled={mutation.busy === "export"}
        onClick={() =>
          mutation.run("export", async () => {
            // Fetched, not linked: a bearer session has no cookie for the browser to attach.
            const blob = await client.exportWorkspace();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `life-manager-export-${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            // Revoked on the next tick: revoking synchronously can race the download start.
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
          })
        }
      >
        {mutation.busy === "export" ? "Preparing…" : "Export every document as markdown"}
      </button>
    </AdminSectionFrame>
  );
}
