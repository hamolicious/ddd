/**
 * The audit log.
 *
 * This screen is the reason the shared-workspace decision is defensible (SPEC §5.4): any
 * user can delete any document, so "who deleted this, and when" is the entire
 * accountability story. It is therefore filterable by action, actor and target, and it
 * shows the `detail` document verbatim — a summarized audit log is a log you cannot answer
 * a question with.
 *
 * Paging is `_id`-cursor based (default 50, max 200) and **append-only in one direction**:
 * the server hands back `next_cursor`, so this page accumulates rather than pretending to
 * be random-access.
 */

import { useState } from "react";
import type { ReactElement } from "react";

import { describeActor, formatWhen, type AdminClient, type AuditPage } from "./api.js";
import { useAsync, useMutation } from "./hooks.js";

const PAGE_SIZE = 50;

export function AuditSection({ client }: { readonly client: AdminClient }): ReactElement {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [targetId, setTargetId] = useState("");
  // Pages accumulate; the *last* page's cursor is the only one that says whether there is
  // more. Keeping one `cursor` string would fall back to the first page's cursor once the
  // last page returned none, and "Load more" would loop on the same rows forever.
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
    <section className="admin-section" aria-labelledby="admin-audit-heading">
      <h3 id="admin-audit-heading">Audit log</h3>

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
        <p className="admin-empty">
          Nothing recorded for this filter. Destructive and administrative actions —
          document deletes and restores, user, invite and plugin operations — land here.
        </p>
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
    </section>
  );
}

function hasDetail(detail: unknown): boolean {
  return typeof detail === "object" && detail !== null && Object.keys(detail).length > 0;
}
