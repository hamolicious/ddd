/**
 * Orphan attachments, the snapshot browser, and the workspace export.
 *
 * **Orphans are flagged, never auto-deleted** (SPEC §3.6). The scan reads *materialized
 * text*, which is why it covers plugin-held references inside `%%%` sections for free, and
 * why a tombstoned document still counts as referencing its file: restoring a document must
 * not find its attachment already collected. Deletion is one explicit click per file, and
 * the confirmation says the bytes go away.
 *
 * **Restoring a snapshot replaces the whole text in one CRDT transaction**, under whoever
 * has the document open. The server takes a `pre_restore` snapshot first, publishes the
 * resulting diff to every open editor, and logs a warning when other users were subscribed
 * — it does not return that count, so this UI warns unconditionally instead of pretending
 * to know. (Surfacing the real number would need the subscriber count on the response; it
 * is listed as an integration note.)
 *
 * **The export is the no-Mongo recovery path**: a zip of every document as plain markdown.
 * It is fetched through the authenticated `fetch` rather than linked, because a bearer
 * session (the Flutter shell, SPEC §5.2) has no cookie for the browser to attach.
 */

import { useState } from "react";
import type { ReactElement } from "react";

import type { DocumentsApi } from "@kernel";

import { AdminSectionFrame } from "./AdminView.js";
import { formatBytes, formatWhen, type AdminClient } from "./api.js";
import { useAsync, useConfirm, useMutation } from "./hooks.js";

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

      <div className="admin-inline-form">
        <button
          type="button"
          disabled={mutation.busy === "scan"}
          onClick={() => mutation.run("scan", () => client.scanOrphans())}
        >
          Run the scan now
        </button>
        <button type="button" onClick={() => orphans.reload()}>
          Refresh
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
                      {attachment.name}
                      <span className="admin-hint">{attachment.id}</span>
                    </th>
                    <td data-label="Type">{attachment.mime}</td>
                    <td data-label="Size">{formatBytes(attachment.size)}</td>
                    <td data-label="Uploaded">{formatWhen(attachment.created_at)}</td>
                    <td data-label="Flagged">{formatWhen(flagged_at)}</td>
                    <td className="admin-actions">
                      <button
                        type="button"
                        className="admin-danger"
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
                        Delete
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

export interface SnapshotsSectionProps {
  readonly client: AdminClient;
  readonly documents: DocumentsApi;
  readonly embedded?: boolean;
}

export function SnapshotsSection({
  client,
  documents,
  embedded,
}: SnapshotsSectionProps): ReactElement {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ readonly id: string; readonly title: string } | undefined>();

  // A local query, like every other read in the app (SPEC §4.1) — the picker works offline
  // even though the snapshots themselves are a server resource.
  const candidates = useAsync(
    () =>
      documents.query({
        ...(search.trim() === ""
          ? {}
          : { filter: { text: { field: "title", mode: "contains", value: search.trim() } } }),
        sort: [{ field: "updated_at", direction: "desc" }],
        limit: 25,
      }),
    [search],
  );

  const snapshots = useAsync(
    () => (selected ? client.snapshots(selected.id) : Promise.resolve([])),
    [selected?.id ?? ""],
  );
  const mutation = useMutation(() => snapshots.reload());
  const confirm = useConfirm();

  return (
    <AdminSectionFrame id="snapshots" title="Snapshots" embedded={embedded}>
      <p className="admin-note">
        Every document keeps its last 20 snapshots plus one per day for 30 days.
        Restoring replaces the whole text, frontmatter included.
      </p>

      <label className="admin-field">
        <span>Find a document</span>
        <input
          type="search"
          value={search}
          placeholder="title contains…"
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      {candidates.error && (
        <p className="admin-error" role="alert">
          {candidates.error}
        </p>
      )}

      <ul className="admin-picker">
        {(candidates.data?.rows ?? []).map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={`admin-link ${selected?.id === row.id ? " admin-link-active" : ""}`}
              aria-current={selected?.id === row.id ? "true" : undefined}
              onClick={() => setSelected({ id: row.id, title: row.title })}
            >
              {row.title}
            </button>
          </li>
        ))}
      </ul>

      {selected === undefined ? (
        <p className="admin-empty">Pick a document to see its snapshots.</p>
      ) : (
        <>
          <h4>
            {selected.title} <span className="admin-hint">{selected.id}</span>
          </h4>

          {(snapshots.error ?? mutation.error) && (
            <p className="admin-error" role="alert">
              {snapshots.error ?? mutation.error}
            </p>
          )}

          <div className="admin-inline-form">
            <button
              type="button"
              disabled={mutation.busy === "create"}
              onClick={() => mutation.run("create", () => client.createSnapshot(selected.id))}
            >
              Take a snapshot now
            </button>
          </div>

          {snapshots.loading ? (
            <p role="status">Loading snapshots…</p>
          ) : (snapshots.data ?? []).length === 0 ? (
            <p className="admin-empty">No snapshots yet.</p>
          ) : (
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Taken</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Title then</th>
                    <th scope="col">Size</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshots.data ?? []).map((snapshot) => (
                    <tr key={snapshot.id}>
                      <th scope="row">{formatWhen(snapshot.created_at)}</th>
                      <td data-label="Reason">{snapshot.reason}</td>
                      <td data-label="Title then">{snapshot.title}</td>
                      <td data-label="Size">{formatBytes(snapshot.size)}</td>
                      <td className="admin-actions">
                        <button
                          type="button"
                          className="admin-danger"
                          disabled={mutation.busy === snapshot.id}
                          onClick={(event) => {
                            void confirm({
                              title: `Replace “${selected.title}” with this snapshot?`,
                              description: "Everyone sees the change. The current text is snapshotted first.",
                              confirmLabel: "Restore",
                              danger: true,
                              anchor: event.currentTarget,
                            }).then((ok) => {
                              if (ok) {
                                mutation.run(snapshot.id, () => client.restoreSnapshot(selected.id, snapshot.id));
                              }
                            });
                          }}
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
            <dt>Oversized documents</dt>
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
