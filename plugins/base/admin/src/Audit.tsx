import { useState } from "react";
import type { ReactElement } from "react";

import { AdminSectionFrame } from "./AdminView.js";
import { describeActor, formatWhen, type AdminClient, type AuditPage } from "./api.js";
import { useAsync, useMutation } from "./hooks.js";

const PAGE_SIZE = 50;

export function AuditSection({
  client,
  embedded,
}: {
  readonly client: AdminClient;
  readonly embedded?: boolean;
}): ReactElement {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [targetId, setTargetId] = useState("");
  const [pages, setPages] = useState<readonly AuditPage[]>([]);

  const users = useAsync(() => client.users(), []);
  const first = useAsync(
    () => client.audit({ action, actor, target_id: targetId, limit: PAGE_SIZE }),
    [action, actor, targetId],
  );
  const more = useMutation();

  const entries = [...(first.data?.entries ?? []), ...pages.flatMap((page) => page.entries)];
  const nextCursor =
    pages.length === 0 ? first.data?.next_cursor : pages[pages.length - 1]?.next_cursor;

  const applyFilters = (next: { action?: string; actor?: string; targetId?: string }): void => {
    setPages([]);
    if (next.action !== undefined) setAction(next.action);
    if (next.actor !== undefined) setActor(next.actor);
    if (next.targetId !== undefined) setTargetId(next.targetId);
  };

  return (
    <AdminSectionFrame id="audit" title="Audit log" embedded={embedded}>
      <form
        className="admin-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters({});
        }}
      >
        <label className="admin-field">
          <span>Action</span>
          <input
            value={action}
            placeholder="document.delete"
            onChange={(event) => applyFilters({ action: event.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Actor (user id)</span>
          <input value={actor} onChange={(event) => applyFilters({ actor: event.target.value })} />
        </label>
        <label className="admin-field">
          <span>Target id</span>
          <input value={targetId} onChange={(event) => applyFilters({ targetId: event.target.value })} />
        </label>
        {(action || actor || targetId) && (
          <button type="button" onClick={() => applyFilters({ action: "", actor: "", targetId: "" })}>
            Clear
          </button>
        )}
      </form>

      {(first.error ?? more.error) && (
        <p className="admin-error" role="alert">
          {first.error ?? more.error}
        </p>
      )}

      {first.loading ? (
        <p role="status">Loading the audit log…</p>
      ) : entries.length === 0 ? (
        <p className="admin-empty">Nothing matches this filter.</p>
      ) : (
        <ol className="admin-audit">
          {entries.map((entry) => (
            <li key={entry.id}>
              <p className="admin-audit-head">
                <code className="admin-audit-action">{entry.action}</code>
                <span>{formatWhen(entry.created_at)}</span>
                <span>{describeActor(entry.actor, users.data ?? [])}</span>
                {entry.ip && <span className="admin-hint">{entry.ip}</span>}
              </p>
              <p className="admin-audit-target">
                {entry.target_kind}
                {entry.target_id && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="admin-link"
                      onClick={() => applyFilters({ targetId: entry.target_id ?? "" })}
                    >
                      {entry.target_id}
                    </button>
                  </>
                )}
              </p>
              {hasDetail(entry.detail) && (
                <details>
                  <summary>Detail</summary>
                  <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}

      {nextCursor !== undefined && (
        <button
          type="button"
          disabled={more.busy === "more"}
          onClick={() =>
            more.run("more", async () => {
              const page = await client.audit({
                action,
                actor,
                target_id: targetId,
                cursor: nextCursor,
                limit: PAGE_SIZE,
              });
              setPages((current) => [...current, page]);
            })
          }
        >
          Load {PAGE_SIZE} more
        </button>
      )}
    </AdminSectionFrame>
  );
}

function hasDetail(detail: unknown): boolean {
  return typeof detail === "object" && detail !== null && Object.keys(detail).length > 0;
}
