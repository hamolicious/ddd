/**
 * The altbar panel: one document's snapshots, newest first, with Take and Refresh above
 * the list and Restore on each row. A narrow column, so each snapshot is a two-line row
 * rather than a table.
 */

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";

import type { ConfirmRequest } from "../../_shared/context-menu-api.js";

import { describeReason, formatBytes, formatWhen, type SnapshotView, type SnapshotsClient } from "./api.js";

const ICON = {
  "aria-hidden": true,
  viewBox: "0 0 24 24",
  width: "1.15em",
  height: "1.15em",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const BUTTON =
  "snap:tap snap:inline-flex snap:shrink-0 snap:cursor-pointer snap:items-center snap:justify-center snap:rounded snap:border snap:border-border snap:bg-bg snap:p-0 snap:text-text snap:hover:border-border-strong snap:disabled:cursor-default snap:disabled:opacity-55";

export function SnapshotsPanel({
  documentId,
  client,
  confirm,
}: {
  readonly documentId: string;
  readonly client: SnapshotsClient;
  readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
}): ReactElement {
  const [rows, setRows] = useState<readonly SnapshotView[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    let live = true;
    client
      .list(documentId)
      .then((list) => {
        if (!live) return;
        setRows(list);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });
    return () => {
      live = false;
    };
  }, [client, documentId]);

  useEffect(load, [load]);

  const run = (key: string, action: () => Promise<void>, done: string): void => {
    setBusy(key);
    setError(undefined);
    setStatus(undefined);
    action()
      .then(() => {
        setStatus(done);
        load();
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(undefined));
  };

  return (
    <div className="snapshots snap:flex snap:flex-col snap:gap-2 snap:font-sans snap:text-text">
      <div className="snap:flex snap:items-center snap:gap-1">
        <button
          type="button"
          className={BUTTON}
          aria-label="Take a snapshot now"
          title="Take a snapshot now"
          disabled={busy !== undefined}
          onClick={() => run("take", () => client.take(documentId), "Snapshot taken.")}
        >
          <svg {...ICON}>
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
            <circle cx="12" cy="13" r="3.5" />
          </svg>
        </button>
        <button
          type="button"
          className={BUTTON}
          aria-label="Refresh"
          title="Refresh"
          onClick={() => {
            setStatus(undefined);
            load();
          }}
        >
          <svg {...ICON}>
            <path d="M20 11a8 8 0 0 0-14.6-4.5M4 13a8 8 0 0 0 14.6 4.5" />
            <path d="M5 3v4h4M19 21v-4h-4" />
          </svg>
        </button>
        <p className="snap:m-0 snap:min-w-0 snap:flex-1 snap:text-xs snap:text-text-muted" role="status">
          {status}
        </p>
      </div>

      {error === undefined ? null : (
        <p className="snap:m-0 snap:rounded snap:border snap:border-danger snap:p-2 snap:text-sm" role="alert">
          {error}
        </p>
      )}

      {rows === undefined ? (
        error === undefined ? (
          <p className="snap:m-0 snap:text-sm snap:text-text-muted" role="status">
            Loading snapshots…
          </p>
        ) : null
      ) : rows.length === 0 ? (
        <p className="snap:m-0 snap:text-sm snap:text-text-muted">No snapshots yet.</p>
      ) : (
        <ol className="snap:m-0 snap:flex snap:list-none snap:flex-col snap:p-0" aria-label="Snapshots, newest first">
          {rows.map((snapshot) => (
            <li
              key={snapshot.id}
              className="snap:flex snap:items-center snap:gap-2 snap:border-b snap:border-border snap:py-1.5 snap:last:border-b-0"
            >
              <div className="snap:flex snap:min-w-0 snap:flex-1 snap:flex-col">
                <span className="snap:text-sm">{formatWhen(snapshot.created_at)}</span>
                <Quiet>
                  {describeReason(snapshot.reason)} · {formatBytes(snapshot.size)}
                </Quiet>
                <Quiet title={snapshot.title}>“{snapshot.title}”</Quiet>
              </div>
              <button
                type="button"
                className={`${BUTTON} snap:border-danger! snap:text-danger!`}
                aria-label={`Restore the snapshot from ${formatWhen(snapshot.created_at)}`}
                title="Restore"
                disabled={busy !== undefined}
                onClick={(event) => {
                  void confirm({
                    title: `Restore the snapshot from ${formatWhen(snapshot.created_at)}?`,
                    description:
                      "The whole text, frontmatter included, goes back to how it was then, for everyone. The current text is snapshotted first.",
                    confirmLabel: "Restore",
                    danger: true,
                    anchor: event.currentTarget,
                  }).then((ok) => {
                    if (ok) run(snapshot.id, () => client.restore(documentId, snapshot.id), "Restored.");
                  });
                }}
              >
                <svg {...ICON}>
                  <path d="M4 12a8 8 0 1 0 2.3-5.6" />
                  <path d="M4 4v4h4" />
                  <path d="M12 8v4l3 2" />
                </svg>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Quiet({ children, title }: { readonly children: ReactNode; readonly title?: string }): ReactElement {
  return (
    <span className="snap:truncate snap:text-xs snap:text-text-muted" title={title}>
      {children}
    </span>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
