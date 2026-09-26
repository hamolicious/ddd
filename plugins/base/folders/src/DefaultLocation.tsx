/**
 * "New notes go to" — one `settings.section`, one control.
 *
 * The owner's ask, and a small one with a sharp edge: the folder it names may not exist
 * any more. Folders are derived from `fm.path`, so the last document leaving `home/lists`
 * makes that folder stop existing, and a picker that silently dropped the stored value
 * would file the next note at root without saying so. A value that matches nothing is
 * therefore kept in the list, marked, and left selected until someone changes it — it is
 * still a perfectly good path to write into a new document's frontmatter, and writing it
 * is what brings the folder back.
 *
 * A `<select>` rather than a tree: it is one tab stop, it is a native picker on a phone,
 * and at 390 px it cannot overflow the pane.
 */

import { useId, useState } from "react";
import type { ReactElement } from "react";

import { normalizePath } from "./path.js";

export interface DefaultLocationProps {
  /** Folders derived from `fm.path`, in tree order. */
  readonly folders: readonly string[];
  /** Folders that exist only in settings, having never held a document. */
  readonly extraFolders: readonly string[];
  readonly value: string;
  /**
   * Store the choice. **Resolves when it is stored and rejects when it is not** — this
   * control shows the difference, so a caller that swallows the failure makes it lie.
   */
  readonly onChange: (path: string) => Promise<void>;
}

export function DefaultLocation({
  folders,
  extraFolders,
  value,
  onChange,
}: DefaultLocationProps): ReactElement {
  const id = useId();
  /*
   * Optimistic, and reverted on failure — the same shape as `document-surface`'s
   * "Open documents in", because the failure is the same one.
   *
   * A settings write is a CRDT splice into a document that may have to be created
   * first, so it can fail: offline at the wrong moment is enough. Handing the promise
   * to nobody made that an unhandled rejection in the console and nothing on screen —
   * the select kept the value the user picked while the stored setting, and the
   * `doc-list` announcement riding on it, still said the old one. New notes then went
   * somewhere the one control that claims to decide it did not say.
   */
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const current = normalizePath(pending ?? value);

  const choose = (next: string): void => {
    setPending(normalizePath(next));
    setProblem(undefined);
    void onChange(next)
      .catch((cause: unknown) => {
        setProblem(
          `That could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      })
      // Either way the stored value takes over again: on success it is what was just
      // written, on failure it is what the picker has to go back to showing.
      .finally(() => setPending(undefined));
  };

  const known = [...new Set([...folders, ...extraFolders.map((folder) => normalizePath(folder))])]
    .filter((folder) => folder !== "")
    .sort((left, right) => left.localeCompare(right) || (left < right ? -1 : 1));
  const missing = current !== "" && !known.includes(current);

  return (
    <div className="folders:flex folders:flex-col folders:gap-3 folders:font-sans folders:text-text">
      <label className="folders:flex folders:flex-wrap folders:items-center folders:gap-3" htmlFor={id}>
        <span>New notes go to</span>
        <select
          className="folders:min-h-[var(--lm-tap-target)] folders:min-w-0 folders:flex-1 folders:rounded folders:border folders:border-border folders:bg-bg folders:px-2 folders:text-text"
          id={id}
          value={current}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">Root (no folder)</option>
          {missing && <option value={current}>{current} (no documents in it yet)</option>}
          {known.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
      </label>
      <p className="folders:m-0 folders:text-sm folders:text-text-muted">
        A new document gets <code>path: {current === "" ? "…" : current}</code> in its
        frontmatter{current === "" ? " — or no path line at all, at the root" : ""}. Creating one
        from a folder’s <span aria-hidden="true">+</span> still files it in that folder.
      </p>
      {problem !== undefined ? (
        <p className="folders:m-0 folders:text-sm folders:text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
