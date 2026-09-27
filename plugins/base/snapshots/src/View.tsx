/**
 * One snapshot, read only: `#/doc/<id>/snapshot/<snapshot>`. A "detached head": the
 * document as it was then, under a banner that says so, with the way back to the
 * current version and the way to make this one current (Restore).
 *
 * Rendered by `markdown` **without a document id**, which is what makes it read-only:
 * task checkboxes and embed toggles only write when they know which document to write
 * to, and this text is not any document's current text.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import type { ConfirmRequest } from "../../_shared/context-menu-api.js";

import {
  describeReason,
  formatWhen,
  type SnapshotContent,
  type SnapshotsClient,
} from "./api.js";

/** The `markdown` plugin's API, structurally — plugins never import each other. */
export interface MarkdownApi {
  render(text: string, options?: { readonly documentId?: string }): ReactNode;
  bodyOf(text: string): string;
}

const READER_CLASSES =
  "snap:mx-auto snap:w-full snap:min-w-0 snap:max-w-[72ch] snap:break-words snap:px-4 snap:py-6 snap:text-base snap:leading-[1.65] snap:compact:py-4 snap:compact:leading-[1.7] snap:[&>:first-child]:mt-0 snap:[&_h1]:mb-2 snap:[&_h1]:mt-6 snap:[&_h1]:text-2xl snap:[&_h1]:leading-tight snap:compact:[&_h1]:text-xl snap:[&_h2]:mb-2 snap:[&_h2]:mt-6 snap:[&_h2]:text-xl snap:[&_h2]:leading-tight snap:compact:[&_h2]:text-lg snap:[&_h3]:mb-2 snap:[&_h3]:mt-6 snap:[&_h3]:text-lg snap:[&_h3]:leading-tight snap:compact:[&_h3]:text-base snap:[&_h4]:mb-2 snap:[&_h4]:mt-6 snap:[&_h4]:leading-tight snap:[&_p]:mb-3 snap:[&_p]:mt-0 snap:[&_ul]:mb-3 snap:[&_ol]:mb-3 snap:[&_blockquote]:mb-3 snap:[&_blockquote]:border-l-[3px] snap:[&_blockquote]:border-border-strong snap:[&_blockquote]:pl-3 snap:[&_blockquote]:text-text-muted snap:[&_pre]:mb-3 snap:[&_pre]:max-w-full snap:[&_pre]:overflow-x-auto snap:[&_pre]:rounded snap:[&_pre]:border snap:[&_pre]:border-border snap:[&_pre]:bg-bg-subtle snap:[&_pre]:p-2 snap:[&_table]:mb-3 snap:[&_table]:block snap:[&_table]:max-w-full snap:[&_table]:overflow-x-auto snap:[&_table]:border-collapse snap:[&_a]:break-words snap:[&_a]:text-link snap:[&_code]:break-words snap:[&_code]:rounded-[3px] snap:[&_code]:bg-bg-subtle snap:[&_code]:px-[0.3em] snap:[&_code]:py-[0.1em] snap:[&_code]:font-mono snap:[&_code]:text-[0.9em] snap:[&_pre_code]:bg-transparent snap:[&_pre_code]:p-0 snap:[&_img]:h-auto snap:[&_img]:max-w-full snap:[&_img]:rounded snap:[&_th]:border snap:[&_th]:border-border snap:[&_th]:px-2 snap:[&_th]:py-1 snap:[&_th]:text-left snap:[&_td]:border snap:[&_td]:border-border snap:[&_td]:px-2 snap:[&_td]:py-1 snap:[&_td]:text-left snap:[&_hr]:border-0 snap:[&_hr]:border-t snap:[&_hr]:border-border";

const LINK =
  "snap:tap-h snap:inline-flex snap:cursor-pointer snap:items-center snap:gap-1.5 snap:rounded snap:border snap:border-border snap:bg-bg snap:px-3 snap:text-text snap:no-underline snap:hover:border-border-strong";

export function SnapshotView({
  documentId,
  snapshotId,
  client,
  markdown,
  confirm,
  navigate,
}: {
  readonly documentId: string;
  readonly snapshotId: string;
  readonly client: SnapshotsClient;
  readonly markdown: MarkdownApi;
  readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
  readonly navigate: (path: string) => void;
}): ReactElement {
  const [snapshot, setSnapshot] = useState<SnapshotContent | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setSnapshot(undefined);
    setError(undefined);
    client
      .get(documentId, snapshotId)
      .then((loaded) => {
        if (live) setSnapshot(loaded);
      })
      .catch((cause: unknown) => {
        if (live)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [client, documentId, snapshotId]);

  const current = `/doc/${encodeURIComponent(documentId)}`;
  const when = snapshot ? formatWhen(snapshot.created_at) : "";

  return (
    <div className="snapshot-view snap:flex snap:min-h-full snap:flex-col snap:font-sans snap:text-text">
      <div
        className="snap:sticky snap:top-0 snap:z-[1] snap:flex snap:flex-wrap snap:items-center snap:gap-2 snap:border-b snap:border-warning snap:bg-bg-raised snap:px-4 snap:py-2"
        role="region"
        aria-label="Snapshot"
      >
        <span aria-hidden="true" className="snap:text-warning">
          <svg
            viewBox="0 0 24 24"
            width="1.25em"
            height="1.25em"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </span>
        <div className="snap:flex snap:min-w-[12rem] snap:flex-1 snap:flex-col">
          <strong>{snapshot ? `Snapshot from ${when}` : "Snapshot"}</strong>
          <span className="snap:text-sm snap:text-text-muted">
            Read only
            {snapshot
              ? ` · ${describeReason(snapshot.reason)} · “${snapshot.title}”`
              : ""}
          </span>
        </div>
        {/* Its own row on a phone, so the heading keeps the width. */}
        <div className="snap:flex snap:gap-2 snap:compact:basis-full snap:compact:[&>*]:flex-1 snap:compact:[&>*]:justify-center">
          <a className={LINK} href={`#${current}`}>
            Current version
          </a>
          <button
            type="button"
            className={`${LINK} snap:border-danger! snap:text-danger!`}
            disabled={!snapshot || busy}
            onClick={(event) => {
              void confirm({
                title: `Restore the snapshot from ${when}?`,
                description:
                  "The whole text, frontmatter included, goes back to how it was then, for everyone. The current text is snapshotted first.",
                confirmLabel: "Restore",
                danger: true,
                anchor: event.currentTarget,
              }).then((ok) => {
                if (!ok) return;
                setBusy(true);
                client
                  .restore(documentId, snapshotId)
                  .then(() => navigate(current))
                  .catch((cause: unknown) =>
                    setError(
                      cause instanceof Error ? cause.message : String(cause),
                    ),
                  )
                  .finally(() => setBusy(false));
              });
            }}
          >
            Restore this
          </button>
        </div>
      </div>

      {error !== undefined && (
        <p
          className="snap:mx-4 snap:mt-4 snap:rounded snap:border snap:border-danger snap:p-2"
          role="alert"
        >
          {error}
        </p>
      )}
      {snapshot === undefined && error === undefined && (
        <p className="snap:px-4 snap:py-6 snap:text-text-muted" role="status">
          Loading the snapshot…
        </p>
      )}
      {snapshot !== undefined && (
        <article className={READER_CLASSES}>
          {markdown.render(markdown.bodyOf(snapshot.content))}
        </article>
      )}
    </div>
  );
}
