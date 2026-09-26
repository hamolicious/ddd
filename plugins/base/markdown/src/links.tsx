/**
 * The two app-internal URL schemes (SPEC §3.6, §6.5).
 *
 * `doc://<ulid>` and `attachment://<ulid>` are the reason `markdown` is the plugin that
 * "resolves" links rather than just printing them: both address workspace objects, and
 * both have to work with no network.
 *
 * - **`doc://<ulid>` renders the target's title from the projection.** Not from the
 *   server: the projection replicates to every client (SPEC §4.1), so a link's label is
 *   correct offline and before hydration. A target that is not in the projection renders
 *   as a chip saying so — "a missing target is a chip, not a dead link"
 *   (`web/CONTRACTS.md`), because a dead `<a>` that navigates to a blank document teaches
 *   the user nothing.
 * - **`attachment://<ulid>` needs an authenticated fetch.** The blob is behind the
 *   session (cookie in a browser, bearer token in the shell, SPEC §5.2), so it cannot go
 *   in an `<img src>` directly — `kernel.session.fetch` gets the bytes and an object URL
 *   carries them into the DOM. A fetch that fails is the offline case and renders "not
 *   available offline".
 *
 * Every one of these also carries the **promote-to-document** action (SPEC §3.6): pasting
 * a file into a document only embeds it, and this is where the user later says "actually,
 * make that a document".
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { PopupMenu, type MenuItem } from "./menu.js";
import { isInlineImage, type AttachmentMeta, type EmbedSite, type MarkdownRuntime } from "./runtime.js";

/** Load a value once per key, without tearing when the component unmounts mid-flight. */
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

// ---------------------------------------------------------------------------
// doc://
// ---------------------------------------------------------------------------

export interface DocLinkProps {
  readonly id: string;
  /** The link's own text, when the author wrote any. */
  readonly label?: ReactNode;
  /** `#fragment` of the destination, passed through to the route. */
  readonly fragment?: string | null;
  readonly runtime: MarkdownRuntime;
}

/**
 * A link to another document.
 *
 * The label rule: **explicit link text wins, the resolved title is the fallback.**
 * `[the grocery list](doc://01J…)` says what the author meant and should not be rewritten
 * under them; `[](doc://01J…)` has nothing to show and gets the live title. Anything else
 * would make a wiki-style link impossible to write.
 *
 * `href` is set to the real `doc://` URL and navigation is intercepted. That is not
 * decoration: it makes the link copyable, hoverable and middle-clickable-into-nothing
 * rather than a `<span>` pretending to be a link, while `preventDefault` keeps the browser
 * from trying to resolve a scheme it does not know.
 */
export function DocLink({ id, label, fragment, runtime }: DocLinkProps): ReactNode {
  const load = useCallback((key: string) => runtime.titleOf(key), [runtime]);
  const { value: title, done } = useResolved(id, load);
  const hasLabel = label !== undefined && label !== null && label !== "";

  if (done && title === undefined && !hasLabel) {
    return (
      <span className="markdown:tap-h markdown:inline-flex markdown:items-center markdown:gap-1 markdown:rounded-lg markdown:border markdown:border-warning markdown:bg-bg-subtle markdown:px-2 markdown:py-1 markdown:text-warning" title={`doc://${id}`}>
        <span aria-hidden="true">⚠</span> missing document
      </span>
    );
  }

  return (
    <a
      className="markdown:decoration-dotted"
      href={`doc://${id}${fragment ? `#${fragment}` : ""}`}
      title={title ?? id}
      onClick={(event) => {
        event.preventDefault();
        runtime.openDocument(id, fragment);
      }}
    >
      {hasLabel ? label : (title ?? id)}
    </a>
  );
}

// ---------------------------------------------------------------------------
// attachment://
// ---------------------------------------------------------------------------

/**
 * How this attachment is written in the text, and the write that flips it. Absent when
 * there is nowhere to write (a render with no document behind it).
 */
export interface EmbedToggle {
  /** `true` for `![…](…)`, `false` for `[…](…)`. */
  readonly preview: boolean;
  readonly toggle: () => void;
  /** Where it is, so promoting it can put a link to the new document in its place. */
  readonly site: EmbedSite;
}

interface AttachmentActionsProps {
  readonly id: string;
  readonly runtime: MarkdownRuntime;
  readonly embed?: EmbedToggle;
  readonly children: (open: () => void) => ReactNode;
}

/**
 * Wrap an embedded attachment with its action menu.
 *
 * The menu is the home of "promote to document" (SPEC §3.6) — it is a per-object action,
 * so a context menu on the object is where it belongs, and the same command is registered
 * in the palette against whichever attachment was last touched.
 */
export function AttachmentActions({ id, runtime, embed, children }: AttachmentActionsProps): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);

  const items: readonly MenuItem[] = [
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
  ];

  return (
    <span
      className="markdown:relative markdown:inline-block markdown:max-w-full"
      onContextMenu={(event) => {
        event.preventDefault();
        runtime.focusAttachment(id, embed?.site);
        setMenuOpen(true);
      }}
      onFocus={() => runtime.focusAttachment(id, embed?.site)}
      onPointerDown={() => runtime.focusAttachment(id, embed?.site)}
    >
      {children(() => {
        runtime.focusAttachment(id, embed?.site);
        setMenuOpen(true);
      })}
      {menuOpen ? (
        <PopupMenu label="File actions" items={items} onClose={() => setMenuOpen(false)} />
      ) : null}
    </span>
  );
}

export interface AttachmentProps {
  readonly id: string;
  readonly alt?: string;
  readonly runtime: MarkdownRuntime;
  readonly embed?: EmbedToggle;
}

/**
 * An embedded image: `![alt](attachment://<ulid>)`.
 *
 * Falls back to the chip for everything that is not a safely-inlineable raster image —
 * a PDF, a zip, and notably an SVG (SPEC §3.6's stored-XSS rule, enforced in
 * `runtime.isInlineImage`).
 */
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
          onDoubleClick={open}
        />
      )}
    </AttachmentActions>
  );
}

export interface AttachmentChipProps extends AttachmentProps {
  /** The blob is not in the local cache and the network did not answer (SPEC §3.6). */
  readonly unavailable?: boolean;
}

/** A non-image attachment, or an image that could not be loaded: a chip. */
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
          onClick={open}
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
