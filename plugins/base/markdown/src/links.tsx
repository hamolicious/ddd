import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { MenuItem } from "plugin:context-menu";
import type { NoteLook } from "plugin:folders";

import { target } from "../../_shared/target.js";

import { useMenuItems } from "./menu.js";

import { isInlineImage, type AttachmentMeta, type EmbedSite, type MarkdownRuntime } from "./runtime.js";

function useResolved<T>(key: string, load: (key: string) => Promise<T>): { value: T | undefined; done: boolean } {
  const [state, setState] = useState<{ key: string; value: T | undefined; done: boolean }>({
    key,
    value: undefined,
    done: false,
  });

  useEffect(() => {
    let live = true;
    setState((previous) => (previous.key === key ? previous : { key, value: undefined, done: false }));
    void load(key).then(
      (value) => {
        if (live) setState({ key, value, done: true });
      },
      () => {
        if (live) setState({ key, value: undefined, done: true });
      },
    );
    return () => {
      live = false;
    };
  }, [key, load]);

  return state.key === key ? { value: state.value, done: state.done } : { value: undefined, done: false };
}

export interface DocLinkProps {
  readonly id: string;
  readonly label?: ReactNode;
  readonly fragment?: string | null;
  readonly runtime: MarkdownRuntime;
}

export function DocLink({ id, label, fragment, runtime }: DocLinkProps): ReactNode {
  const load = useCallback((key: string) => runtime.titleOf(key), [runtime]);
  const { value: title, done } = useResolved(id, load);
  const look = useLook(id, runtime);
  const hasLabel = label !== undefined && label !== null && label !== "";

  if (done && title === undefined && !hasLabel) {
    return (
      <span className="markdown:tap-h markdown:inline-flex markdown:items-center markdown:gap-1 markdown:rounded-lg markdown:border markdown:border-warning markdown:bg-bg-subtle markdown:px-2 markdown:py-1 markdown:text-warning" title={`doc://${id}`}>
        <span aria-hidden="true">⚠</span> missing document
      </span>
    );
  }

  const text = hasLabel ? label : (title ?? id);
  const dressed = look !== undefined;
  return (
    <a
      className={
        dressed
          ? `markdown:inline-flex markdown:max-w-full markdown:items-baseline markdown:gap-1 markdown:align-baseline markdown:no-underline markdown:hover:underline ${look.background ? "markdown:rounded-full markdown:px-1.5" : ""}`
          : "markdown:decoration-dotted"
      }
      style={dressed ? { ...(look.color ? { color: look.color } : {}), ...(look.background ? { background: look.background } : {}) } : undefined}
      href={`doc://${id}${fragment ? `#${fragment}` : ""}`}
      title={title ?? id}
      onClick={(event) => {
        event.preventDefault();
        runtime.openDocument(id, fragment);
      }}
    >
      {look?.icon !== undefined && (
        <span aria-hidden="true" className="markdown:inline-flex markdown:self-center markdown:[&_svg]:size-[1em]">
          {look.icon}
        </span>
      )}
      {dressed ? <span className="markdown:min-w-0 markdown:truncate">{text}</span> : text}
    </a>
  );
}

function useLook(id: string, runtime: MarkdownRuntime): NoteLook | undefined {
  const [, setRevision] = useState(0);
  useEffect(() => runtime.onLookChange(() => setRevision((value) => value + 1)), [runtime]);
  const look = runtime.lookOf(id);
  return look && (look.background || look.color || look.icon !== undefined) ? look : undefined;
}

export interface EmbedToggle {
  readonly preview: boolean;
  readonly toggle: () => void;
  readonly site: EmbedSite;
}

interface AttachmentActionsProps {
  readonly id: string;
  readonly runtime: MarkdownRuntime;
  readonly embed?: EmbedToggle;
  readonly children: (open: (from: HTMLElement) => void) => ReactNode;
}

export function AttachmentActions({ id, runtime, embed, children }: AttachmentActionsProps): ReactNode {
  const menuRef = useMenuItems<HTMLSpanElement>((): readonly MenuItem[] => [
    ...(embed
      ? [
          {
            id: "toggle-preview",
            label: embed.preview ? "Show as link" : "Show as preview",
            icon: embed.preview ? "🔗" : "🖼",
            run: embed.toggle,
          },
        ]
      : []),
    {
      id: "open",
      label: "Download file",
      icon: "⤓",
      run: () => void runtime.downloadAttachment(id),
    },
    {
      id: "promote",
      label: "Promote to document",
      icon: "⧉",
      run: () => {
        void runtime.promoteEmbed(id, embed?.site).then(
          (documentId) => runtime.openDocument(documentId),
          (error: unknown) => {
            runtime.kernel.log.error("promote to document failed", { id, error });
            runtime.kernel.ui.notify({
              id: `markdown.promote.${id}`,
              level: "error",
              message: "Could not create a document for that file.",
            });
          },
        );
      },
    },
  ]);

  return (
    <span
      ref={menuRef}
      {...target("markdown/attachment", id, { label: "File actions" })}
      className="markdown:relative markdown:inline-block markdown:max-w-full"
      onContextMenu={() => runtime.focusAttachment(id, embed?.site)}
      onFocus={() => runtime.focusAttachment(id, embed?.site)}
      onPointerDown={() => runtime.focusAttachment(id, embed?.site)}
    >
      {children((from) => {
        runtime.focusAttachment(id, embed?.site);
        runtime.openMenu(from);
      })}
    </span>
  );
}

export interface AttachmentProps {
  readonly id: string;
  readonly alt?: string;
  readonly runtime: MarkdownRuntime;
  readonly embed?: EmbedToggle;
}

export function AttachmentImage({ id, alt, runtime, embed }: AttachmentProps): ReactNode {
  const load = useCallback((key: string) => runtime.attachmentBlob(key), [runtime]);
  const { value: blob, done } = useResolved(id, load);

  if (!done) {
    return (
      <span className="markdown:italic markdown:text-text-muted" aria-busy="true" title={`attachment://${id}`}>
        loading file…
      </span>
    );
  }
  if (!blob) return <AttachmentChip id={id} alt={alt} runtime={runtime} unavailable />;
  if (!isInlineImage(blob.mime)) return <AttachmentChip id={id} alt={alt} runtime={runtime} embed={embed} />;

  return (
    <AttachmentActions id={id} runtime={runtime} embed={embed}>
      {(open) => (
        <img
          className="markdown:max-w-full markdown:rounded"
          src={blob.objectUrl}
          alt={alt ?? ""}
          loading="lazy"
          onDoubleClick={(event) => open(event.currentTarget)}
        />
      )}
    </AttachmentActions>
  );
}

export interface AttachmentChipProps extends AttachmentProps {
  readonly unavailable?: boolean;
}

export function AttachmentChip({ id, alt, runtime, unavailable, embed }: AttachmentChipProps): ReactNode {
  const load = useCallback((key: string) => runtime.attachmentMeta(key), [runtime]);
  const { value: meta } = useResolved<AttachmentMeta | null>(id, load);
  const name = alt && alt.length > 0 ? alt : (meta?.name ?? id);

  if (unavailable) {
    return (
      <span className="markdown:tap-h markdown:inline-flex markdown:items-center markdown:gap-1 markdown:rounded-lg markdown:border markdown:border-dashed markdown:border-border markdown:bg-bg-subtle markdown:px-2 markdown:py-1 markdown:text-text-muted" title={`attachment://${id}`}>
        <span aria-hidden="true">⭘</span> {name} — not available offline
      </span>
    );
  }

  return (
    <AttachmentActions id={id} runtime={runtime} embed={embed}>
      {(open) => (
        <button
          type="button"
          className="markdown:tap-h markdown:inline-flex markdown:cursor-pointer markdown:items-center markdown:gap-1 markdown:rounded-lg markdown:border markdown:border-border markdown:bg-bg-subtle markdown:px-2 markdown:py-1 markdown:text-text markdown:hover:bg-accent-subtle"
          title={`attachment://${id}`}
          aria-haspopup="menu"
          onClick={(event) => open(event.currentTarget)}
        >
          <span aria-hidden="true">🗎</span> {name}
          {meta ? <span className="markdown:text-[0.85em] markdown:text-text-muted">{formatSize(meta.size)}</span> : null}
        </button>
      )}
    </AttachmentActions>
  );
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? "B"}`;
}
