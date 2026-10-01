/**
 * One group of changes, read only: `#/doc/<id>/change/<from>/<to>`. Two ways to look:
 *
 * - **Changes**: what it did, as a diff. Each changed run of lines with a little unchanged
 *   text around it, removed lines struck in red, inserted lines in green.
 * - **Document then**: the whole note as it was right after it, rendered read only (from
 *   the server's nearest checkpoint, `dev-docs/resolved/HISTORY.md`).
 *
 * The banner offers the way back and Revert.
 */

import { OfflineCopyNote } from "../../_shared/offline-copy.js";
import { changesOfflineCopy } from "./offline.js";
import { useEffect, useState, type ReactElement } from "react";

import type { ConfirmRequest } from "plugin:context-menu";

import { formatRange, type ChangeDetail, type SnapshotsClient } from "./api.js";
import { DetachedBanner } from "./Banner.js";
import { READER_CLASSES, type MarkdownApi } from "./View.js";

export function ChangeView({
  documentId,
  from,
  to,
  client,
  markdown,
  confirm,
  navigate,
}: {
  readonly documentId: string;
  readonly from: number;
  readonly to: number;
  readonly client: SnapshotsClient;
  readonly markdown: MarkdownApi;
  readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
  readonly navigate: (path: string) => void;
}): ReactElement {
  const [detail, setDetail] = useState<ChangeDetail | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"diff" | "document">("diff");
  const [then, setThen] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (mode !== "document" || then !== undefined) return;
    let live = true;
    client
      .textAt(documentId, to)
      .then((text) => {
        if (live) setThen(text);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });
    return () => {
      live = false;
    };
  }, [client, documentId, to, mode, then]);

  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError(undefined);
    client
      .change(documentId, from, to)
      .then((loaded) => {
        if (live) setDetail(loaded);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });
    return () => {
      live = false;
    };
  }, [client, documentId, from, to]);

  const current = `/doc/${encodeURIComponent(documentId)}`;
  const when = detail ? formatRange(detail.started_at, detail.ended_at) : "";

  return (
    <div className="change-view chg:flex chg:min-h-full chg:flex-col chg:font-sans chg:text-text">
      <OfflineCopyNote
        state={changesOfflineCopy}
        className="chg:m-0 chg:rounded chg:border chg:border-warning chg:px-2 chg:py-1 chg:text-sm chg:text-text-muted"
      />
      <DetachedBanner
        label="Change"
        title={detail ? `Change by ${detail.by_label}, ${when}` : "Change"}
        detail={`Read only${detail ? ` · ${detail.changes} edit${detail.changes === 1 ? "" : "s"}` : ""}`}
        currentHref={current}
        action={{
          label: "Revert this",
          disabled: !detail || busy,
          onClick: (anchor) => {
            if (!detail) return;
            void confirm(revertRequest(detail.by_label, when, anchor)).then((ok) => {
              if (!ok) return;
              setBusy(true);
              setError(undefined);
              client
                .revert(documentId, from, to)
                .then(() => navigate(current))
                .catch((cause: unknown) => setError(describe(cause)))
                .finally(() => setBusy(false));
            });
          },
        }}
      />

      {error !== undefined && (
        <p className="chg:mx-4 chg:mt-4 chg:rounded chg:border chg:border-danger chg:p-2" role="alert">
          {error}
        </p>
      )}
      {detail === undefined && error === undefined && (
        <p className="chg:px-4 chg:py-6 chg:text-text-muted" role="status">
          Loading the change…
        </p>
      )}
      <div
        className="chg:mx-auto chg:mt-3 chg:flex chg:w-full chg:max-w-[80ch] chg:gap-1 chg:px-4"
        role="tablist"
        aria-label="Show"
      >
        {(
          [
            ["diff", "Changes"],
            ["document", "Document then"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={`chg:tap-h chg:cursor-pointer chg:rounded chg:border chg:px-3 chg:text-sm ${mode === value ? "chg:border-accent chg:bg-accent-subtle chg:text-text" : "chg:border-border chg:bg-bg chg:text-text-muted"}`}
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "document" && then === undefined && error === undefined && (
        <p className="chg:px-4 chg:py-6 chg:text-text-muted" role="status">
          Loading the document as it was…
        </p>
      )}
      {mode === "document" && then !== undefined && (
        <article className={READER_CLASSES}>{markdown.render(markdown.bodyOf(then))}</article>
      )}

      {mode === "diff" && detail !== undefined && (
        <div className="chg:mx-auto chg:flex chg:w-full chg:max-w-[80ch] chg:flex-col chg:gap-3 chg:px-4 chg:py-4">
          {detail.hunks.length === 0 ? (
            <p className="chg:m-0 chg:text-text-muted">This change left the text as it was.</p>
          ) : (
            detail.hunks.map((hunk, index) => (
              <pre
                key={index}
                className="chg:m-0 chg:overflow-x-auto chg:rounded chg:border chg:border-border chg:bg-bg chg:py-1 chg:font-mono chg:text-sm chg:leading-[1.5]"
                aria-label={`Changed lines, part ${index + 1}`}
              >
                <Lines text={hunk.before} kind="same" />
                <Lines text={hunk.removed} kind="removed" />
                <Lines text={hunk.inserted} kind="inserted" />
                <Lines text={hunk.after} kind="same" />
              </pre>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** The confirmation Revert asks for, here and in the panel. */
export function revertRequest(by: string, when: string, anchor: HTMLElement): ConfirmRequest {
  return {
    title: `Revert ${by}'s change from ${when}?`,
    description:
      "It is undone as a new change; everything after it stays. If someone has changed the same text since, nothing is changed and you are told why.",
    confirmLabel: "Revert",
    danger: true,
    anchor,
  };
}

const KIND = {
  same: { mark: " ", className: "chg:text-text-muted" },
  removed: { mark: "−", className: "chg:bg-[color-mix(in_srgb,var(--ddd-danger)_14%,transparent)] chg:text-text chg:line-through chg:decoration-danger/60" },
  inserted: { mark: "+", className: "chg:bg-[color-mix(in_srgb,var(--ddd-success,#1a7f37)_16%,transparent)] chg:text-text" },
} as const;

function Lines({ text, kind }: { readonly text: string; readonly kind: keyof typeof KIND }): ReactElement | null {
  if (text === "") return null;
  const lines = text.replace(/\n$/, "").split("\n");
  const { mark, className } = KIND[kind];
  return (
    <>
      {lines.map((line, index) => (
        <span key={index} className={`chg:block chg:whitespace-pre-wrap chg:px-2 ${className}`} data-kind={kind}>
          <span aria-hidden="true" className="chg:mr-2 chg:inline-block chg:w-3 chg:select-none chg:no-underline chg:text-text-muted">
            {mark}
          </span>
          {kind === "same" ? line : <span>{line === "" ? " " : line}</span>}
        </span>
      ))}
    </>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
