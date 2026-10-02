import type { ReactElement } from "react";

import { AdminSectionFrame } from "./AdminView.js";
import { formatBytes, type AdminClient } from "./api.js";
import { useAsync, useMutation } from "./hooks.js";
import { Info } from "./Info.js";

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
            const blob = await client.exportWorkspace();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `ddd-export-${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
          })
        }
      >
        {mutation.busy === "export" ? "Preparing…" : "Export every document as markdown"}
      </button>
    </AdminSectionFrame>
  );
}
