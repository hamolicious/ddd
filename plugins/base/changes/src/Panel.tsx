import { OfflineCopyNote } from "../../_shared/offline-copy.js";
import { changesOfflineCopy } from "./offline.js";
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import type { DocumentsApi, SyncApi } from "@kernel";
import type { ConfirmRequest } from "plugin:context-menu";

import {
  describeReason,
  formatBytes,
  formatRange,
  formatWhen,
  type ChangeGroup,
  type SnapshotView,
  type SnapshotsClient,
} from "./api.js";
import { revertRequest } from "./ChangeView.js";

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
  "chg:tap chg:inline-flex chg:shrink-0 chg:cursor-pointer chg:items-center chg:justify-center chg:rounded chg:border chg:border-border chg:bg-bg chg:p-0 chg:text-text chg:hover:border-border-strong chg:disabled:cursor-default chg:disabled:opacity-55";
const DANGER = `${BUTTON} chg:border-danger! chg:text-danger!`;

const RELOAD_DELAY_MS = 400;
const POLL_MS = 30_000;

export type Viewing =
  | { readonly kind: "snapshot"; readonly id: string }
  | { readonly kind: "change"; readonly from: number; readonly to: number };

type Entry =
  | { readonly kind: "change"; readonly at: number; readonly group: ChangeGroup }
  | { readonly kind: "snapshot"; readonly at: number; readonly snapshot: SnapshotView };

export function ChangesPanel({
  documentId,
  viewing,
  client,
  documents,
  sync,
  confirm,
  navigate,
  isAdmin,
}: {
  readonly documentId: string;
  readonly viewing: Viewing | undefined;
  readonly isAdmin: boolean;
  readonly client: SnapshotsClient;
  readonly documents: DocumentsApi;
  readonly sync: SyncApi;
  readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
  readonly navigate: (path: string) => void;
}): ReactElement {
  const [groups, setGroups] = useState<readonly ChangeGroup[] | undefined>(undefined);
  const [snapshots, setSnapshots] = useState<readonly SnapshotView[]>([]);
  const [nextBefore, setNextBefore] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);

  const doc = `/doc/${encodeURIComponent(documentId)}`;

  const load = useCallback(() => {
    let live = true;
    Promise.all([client.changes(documentId), client.list(documentId)])
      .then(([page, list]) => {
        if (!live) return;
        setGroups(page.groups);
        setNextBefore(page.next_before);
        setSnapshots(list);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });
    return () => {
      live = false;
    };
  }, [client, documentId]);

  const viewingKey = viewing === undefined ? "" : viewing.kind === "snapshot" ? viewing.id : `${viewing.from}-${viewing.to}`;
  useEffect(load, [load, viewingKey]);

  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let live = true;
    let close: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (live) latest.current();
      }, RELOAD_DELAY_MS);
    };
    void documents
      .subscribe({ filter: { cmp: { field: "id", op: "eq", value: { str: documentId } } }, includeDeleted: true, limit: 1 })
      .then((subscription) => {
        if (!live) {
          subscription.close();
          return;
        }
        const off = subscription.onChange(soon);
        close = () => {
          off();
          subscription.close();
        };
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      close?.();
    };
  }, [documents, documentId]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const off = sync.subscribe((state) => {
      const connected = state.status === "synced" || state.status === "syncing";
      if (connected) stop();
      else if (timer === undefined) timer = setInterval(() => latest.current(), POLL_MS);
    });
    return () => {
      off();
      stop();
    };
  }, [sync]);

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

  const older = (): void => {
    if (nextBefore === undefined) return;
    setBusy("older");
    client
      .changes(documentId, nextBefore)
      .then((page) => {
        setGroups((current) => [...(current ?? []), ...page.groups]);
        setNextBefore(page.next_before);
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(undefined));
  };

  const oldestLoaded = groups?.at(-1);
  const floor = nextBefore !== undefined && oldestLoaded ? Date.parse(oldestLoaded.started_at) : -Infinity;
  const entries: Entry[] = [
    ...(groups ?? []).map((group): Entry => ({ kind: "change", at: Date.parse(group.ended_at), group })),
    ...snapshots
      .filter((snapshot) => Date.parse(snapshot.created_at) >= floor)
      .map((snapshot): Entry => ({ kind: "snapshot", at: Date.parse(snapshot.created_at), snapshot })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="changes chg:flex chg:flex-col chg:gap-2 chg:font-sans chg:text-text">
      <OfflineCopyNote
        state={changesOfflineCopy}
        className="chg:m-0 chg:rounded chg:border chg:border-warning chg:px-2 chg:py-1 chg:text-sm chg:text-text-muted"
      />
      {status !== undefined && (
        <p className="chg:m-0 chg:min-w-0 chg:text-xs chg:text-text-muted" role="status">
          {status}
        </p>
      )}

      {error === undefined ? null : (
        <p className="chg:m-0 chg:rounded chg:border chg:border-danger chg:p-2 chg:text-sm" role="alert">
          {error}
        </p>
      )}

      {groups === undefined ? (
        error === undefined ? (
          <p className="chg:m-0 chg:text-sm chg:text-text-muted" role="status">
            Loading history…
          </p>
        ) : null
      ) : entries.length === 0 ? (
        <p className="chg:m-0 chg:text-sm chg:text-text-muted">No changes or snapshots yet.</p>
      ) : (
        <ol className="chg:m-0 chg:flex chg:list-none chg:flex-col chg:p-0" aria-label="History, newest first">
          {entries.map((entry) =>
            entry.kind === "change" ? (
              <ChangeRow
                key={`c${entry.group.from_seq}`}
                group={entry.group}
                current={viewing?.kind === "change" && viewing.from === entry.group.from_seq && viewing.to === entry.group.to_seq}
                busy={busy !== undefined}
                onView={(on) =>
                  navigate(on ? `${doc}/change/${entry.group.from_seq}/${entry.group.to_seq}` : doc)
                }
                onRevert={(anchor) => {
                  const { group } = entry;
                  void confirm(revertRequest(group.by_label, formatRange(group.started_at, group.ended_at), anchor)).then(
                    (ok) => {
                      if (!ok) return;
                      run(`c${group.from_seq}`, () => client.revert(documentId, group.from_seq, group.to_seq), "Reverted.");
                      if (viewing?.kind === "change") navigate(doc);
                    },
                  );
                }}
              />
            ) : (
              <SnapshotRow
                key={`s${entry.snapshot.id}`}
                snapshot={entry.snapshot}
                current={viewing?.kind === "snapshot" && viewing.id === entry.snapshot.id}
                busy={busy !== undefined}
                onView={(on) =>
                  navigate(on ? `${doc}/snapshot/${encodeURIComponent(entry.snapshot.id)}` : doc)
                }
                onRestore={(anchor) => {
                  const { snapshot } = entry;
                  void confirm({
                    title: `Restore the snapshot from ${formatWhen(snapshot.created_at)}?`,
                    description:
                      "The whole text, frontmatter included, goes back to how it was then, for everyone. The current text is snapshotted first.",
                    confirmLabel: "Restore",
                    danger: true,
                    anchor,
                  }).then((ok) => {
                    if (!ok) return;
                    run(snapshot.id, () => client.restore(documentId, snapshot.id), "Restored.");
                    if (viewing?.kind === "snapshot") navigate(doc);
                  });
                }}
              />
            ),
          )}
        </ol>
      )}

      {nextBefore !== undefined && (
        <button
          type="button"
          className="chg:tap-h chg:cursor-pointer chg:rounded chg:border chg:border-border chg:bg-bg chg:px-3 chg:text-sm chg:text-text chg:hover:border-border-strong"
          disabled={busy === "older"}
          onClick={older}
        >
          {busy === "older" ? "Loading…" : "Show older"}
        </button>
      )}

      {isAdmin && groups !== undefined && (
        <button
          type="button"
          className="chg:tap-h chg:mt-2 chg:cursor-pointer chg:self-start chg:rounded chg:border-0 chg:bg-transparent chg:px-0 chg:text-xs chg:text-danger chg:underline"
          disabled={busy !== undefined}
          onClick={(event) => {
            void confirm({
              title: "Forget this note's history?",
              description:
                "Every change and snapshot of this note is deleted for good; the note itself stays as it is. Use it when something was typed that should not be kept.",
              confirmLabel: "Forget history",
              danger: true,
              anchor: event.currentTarget,
            }).then((ok) => {
              if (!ok) return;
              run("forget", () => client.forget(documentId), "History forgotten.");
              if (viewing !== undefined) navigate(doc);
            });
          }}
        >
          Forget this note's history
        </button>
      )}
    </div>
  );
}

function ChangeRow({
  group,
  current,
  busy,
  onView,
  onRevert,
}: {
  readonly group: ChangeGroup;
  readonly current: boolean;
  readonly busy: boolean;
  readonly onView: (on: boolean) => void;
  readonly onRevert: (anchor: HTMLElement) => void;
}): ReactElement {
  const when = formatRange(group.started_at, group.ended_at);
  const edits = `${group.changes} edit${group.changes === 1 ? "" : "s"}`;
  return (
    <Row current={current} icon={<PencilIcon />}>
      <div className="chg:flex chg:min-w-0 chg:flex-1 chg:flex-col">
        <span className="chg:truncate chg:text-sm">
          <strong className="chg:font-semibold">{group.by_label}</strong> · {when}
        </span>
        <Quiet>
          {group.reverts ? "Reverted an earlier change · " : ""}
          {group.squashed ? "merged · " : ""}
          {group.offline ? "offline · " : ""}
          <span className="chg:text-success">+{group.inserted_chars}</span>{" "}
          <span className="chg:text-danger">−{group.removed_chars}</span> · {edits}
        </Quiet>
        {group.inserted_excerpt !== "" && (
          <Quiet title={group.inserted_excerpt}>
            <span className="chg:text-success">+ </span>
            {group.inserted_excerpt}
          </Quiet>
        )}
        {group.removed_excerpt !== "" && (
          <Quiet title={group.removed_excerpt}>
            <span className="chg:text-danger">− </span>
            <span className="chg:line-through">{group.removed_excerpt}</span>
          </Quiet>
        )}
      </div>
      <ViewButton label={`View the change by ${group.by_label}, ${when}`} current={current} onView={onView} />
      <button
        type="button"
        className={DANGER}
        aria-label={`Revert the change by ${group.by_label}, ${when}`}
        title="Revert"
        disabled={busy}
        onClick={(event) => onRevert(event.currentTarget)}
      >
        <svg {...ICON}>
          <path d="M9 14L4 9l5-5" />
          <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
        </svg>
      </button>
    </Row>
  );
}

function SnapshotRow({
  snapshot,
  current,
  busy,
  onView,
  onRestore,
}: {
  readonly snapshot: SnapshotView;
  readonly current: boolean;
  readonly busy: boolean;
  readonly onView: (on: boolean) => void;
  readonly onRestore: (anchor: HTMLElement) => void;
}): ReactElement {
  const when = formatRange(snapshot.created_at, snapshot.created_at);
  return (
    <Row current={current} icon={<CameraIcon />}>
      <div className="chg:flex chg:min-w-0 chg:flex-1 chg:flex-col">
        <span className="chg:truncate chg:text-sm">
          <strong className="chg:font-semibold">Snapshot</strong> · {when}
        </span>
        <Quiet>
          {describeReason(snapshot.reason)} · {formatBytes(snapshot.size)}
        </Quiet>
        <Quiet title={snapshot.title}>“{snapshot.title}”</Quiet>
      </div>
      <ViewButton label={`View the snapshot from ${when}`} current={current} onView={onView} />
      <button
        type="button"
        className={DANGER}
        aria-label={`Restore the snapshot from ${when}`}
        title="Restore"
        disabled={busy}
        onClick={(event) => onRestore(event.currentTarget)}
      >
        <svg {...ICON}>
          <path d="M4 12a8 8 0 1 0 2.3-5.6" />
          <path d="M4 4v4h4" />
          <path d="M12 8v4l3 2" />
        </svg>
      </button>
    </Row>
  );
}

function Row({
  current,
  icon,
  children,
}: {
  readonly current: boolean;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <li
      aria-current={current ? "true" : undefined}
      className={`chg:flex chg:items-start chg:gap-2 chg:border-b chg:border-border chg:py-1.5 chg:last:border-b-0 ${current ? "chg:-mx-1 chg:rounded chg:bg-accent-subtle chg:px-1" : ""}`}
    >
      <span className="chg:mt-0.5 chg:shrink-0 chg:text-text-muted">{icon}</span>
      {children}
    </li>
  );
}

function ViewButton({
  label,
  current,
  onView,
}: {
  readonly label: string;
  readonly current: boolean;
  readonly onView: (on: boolean) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={BUTTON}
      aria-label={label}
      aria-pressed={current}
      title={current ? "Back to the current version" : "View, read only"}
      onClick={() => onView(!current)}
    >
      <svg {...ICON}>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

function CameraIcon(): ReactElement {
  return (
    <svg {...ICON}>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function PencilIcon(): ReactElement {
  return (
    <svg {...ICON}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M14 6l4 4" />
    </svg>
  );
}

function Quiet({ children, title }: { readonly children: ReactNode; readonly title?: string }): ReactElement {
  return (
    <span className="chg:truncate chg:text-xs chg:text-text-muted" title={title}>
      {children}
    </span>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
