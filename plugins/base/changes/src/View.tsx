/**
 * One snapshot, read only: `#/doc/<id>/snapshot/<snapshot>`. A "detached head": the
 * document as it was then, under a banner that says so, with the way back to the
 * current version and the way to make this one current (Restore).
 *
 * Rendered by `markdown` **without a document id**, which is what makes it read-only:
 * task checkboxes and embed toggles only write when they know which document to write
 * to, and this text is not any document's current text.
 */

import { OfflineCopyNote } from "../../_shared/offline-copy.js";
import { changesOfflineCopy } from "./offline.js";
import { useEffect, useState, type ReactElement } from "react";

import type { ConfirmRequest } from "@protocols/lm/context-menu";
import type { MarkdownRenderer } from "@protocols/lm/markdown-renderer";

import {
  describeReason,
  formatWhen,
  type SnapshotContent,
  type SnapshotsClient,
} from "./api.js";
import { DetachedBanner } from "./Banner.js";

/** What these pages read through the `markdown` port: the manifest's `needs`. */
export type MarkdownApi = Pick<MarkdownRenderer, "render" | "bodyOf">;

export const READER_CLASSES =
  "chg:mx-auto chg:w-full chg:min-w-0 chg:max-w-[72ch] chg:break-words chg:px-4 chg:py-6 chg:text-base chg:leading-[1.65] chg:compact:py-4 chg:compact:leading-[1.7] chg:[&>:first-child]:mt-0 chg:[&_h1]:mb-2 chg:[&_h1]:mt-6 chg:[&_h1]:text-2xl chg:[&_h1]:leading-tight chg:compact:[&_h1]:text-xl chg:[&_h2]:mb-2 chg:[&_h2]:mt-6 chg:[&_h2]:text-xl chg:[&_h2]:leading-tight chg:compact:[&_h2]:text-lg chg:[&_h3]:mb-2 chg:[&_h3]:mt-6 chg:[&_h3]:text-lg chg:[&_h3]:leading-tight chg:compact:[&_h3]:text-base chg:[&_h4]:mb-2 chg:[&_h4]:mt-6 chg:[&_h4]:leading-tight chg:[&_p]:mb-3 chg:[&_p]:mt-0 chg:[&_ul]:mb-3 chg:[&_ol]:mb-3 chg:[&_blockquote]:mb-3 chg:[&_blockquote]:border-l-[3px] chg:[&_blockquote]:border-border-strong chg:[&_blockquote]:pl-3 chg:[&_blockquote]:text-text-muted chg:[&_pre]:mb-3 chg:[&_pre]:max-w-full chg:[&_pre]:overflow-x-auto chg:[&_pre]:rounded chg:[&_pre]:border chg:[&_pre]:border-border chg:[&_pre]:bg-bg-subtle chg:[&_pre]:p-2 chg:[&_table]:mb-3 chg:[&_table]:block chg:[&_table]:max-w-full chg:[&_table]:overflow-x-auto chg:[&_table]:border-collapse chg:[&_a]:break-words chg:[&_a]:text-link chg:[&_code]:break-words chg:[&_code]:rounded-[3px] chg:[&_code]:bg-bg-subtle chg:[&_code]:px-[0.3em] chg:[&_code]:py-[0.1em] chg:[&_code]:font-mono chg:[&_code]:text-[0.9em] chg:[&_pre_code]:bg-transparent chg:[&_pre_code]:p-0 chg:[&_img]:h-auto chg:[&_img]:max-w-full chg:[&_img]:rounded chg:[&_th]:border chg:[&_th]:border-border chg:[&_th]:px-2 chg:[&_th]:py-1 chg:[&_th]:text-left chg:[&_td]:border chg:[&_td]:border-border chg:[&_td]:px-2 chg:[&_td]:py-1 chg:[&_td]:text-left chg:[&_hr]:border-0 chg:[&_hr]:border-t chg:[&_hr]:border-border";

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
    <div className="snapshot-view chg:flex chg:min-h-full chg:flex-col chg:font-sans chg:text-text">
      <OfflineCopyNote
        state={changesOfflineCopy}
        className="chg:m-0 chg:rounded chg:border chg:border-warning chg:px-2 chg:py-1 chg:text-sm chg:text-text-muted"
      />
      <DetachedBanner
        label="Snapshot"
        title={snapshot ? `Snapshot from ${when}` : "Snapshot"}
        detail={`Read only${snapshot ? ` · ${describeReason(snapshot.reason)} · “${snapshot.title}”` : ""}`}
        currentHref={current}
        action={{
          label: "Restore this",
          disabled: !snapshot || busy,
          onClick: (anchor) => {
            void confirm({
              title: `Restore the snapshot from ${when}?`,
              description:
                "The whole text, frontmatter included, goes back to how it was then, for everyone. The current text is snapshotted first.",
              confirmLabel: "Restore",
              danger: true,
              anchor,
            }).then((ok) => {
              if (!ok) return;
              setBusy(true);
              client
                .restore(documentId, snapshotId)
                .then(() => navigate(current))
                .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setBusy(false));
            });
          },
        }}
      />

      {error !== undefined && (
        <p
          className="chg:mx-4 chg:mt-4 chg:rounded chg:border chg:border-danger chg:p-2"
          role="alert"
        >
          {error}
        </p>
      )}
      {snapshot === undefined && error === undefined && (
        <p className="chg:px-4 chg:py-6 chg:text-text-muted" role="status">
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
