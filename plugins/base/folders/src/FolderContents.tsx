/**
 * The documents in one folder (`#/folder?path=home/lists`).
 *
 * It exists because selecting a folder has to *show* something, and `doc-list`'s view owns
 * its own filter state — reaching into it would be a plugin editing another plugin's
 * internals. One live query with a folder filter is both smaller and the honest shape: the
 * filter is the same DSL JSON `doc-list` builds, and it is printed on the page.
 *
 * The filter is `fm.path == folder` **or** `fm.path starts_with "folder/"`, never a bare
 * prefix match: `starts_with "home"` also matches `homework`, and a folder tree that
 * silently included a sibling would be worse than no tree.
 *
 * Rows are draggable, which is what makes the tree's drop targets useful.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import type { DocumentQuery, FilterJson, DocumentsApi } from "@kernel";

import { DOCUMENT_DRAG_TYPE } from "./FolderTree.js";
import { normalizePath } from "./path.js";

/** The DSL filter selecting one folder, with or without its subfolders. */
export function folderFilter(folder: string, includeSubfolders: boolean): FilterJson {
  const path = normalizePath(folder);
  if (path === "") {
    // Root: no `fm.path` at all, or one that normalizes away. `missing` and `is_null`
    // are different questions in this DSL (SPEC §4.2), so both are asked.
    return { or: [{ missing: { field: "fm.path" } }, { is_null: { field: "fm.path" } }] };
  }
  const exact: FilterJson = { cmp: { field: "fm.path", op: "eq", value: { str: path } } };
  if (!includeSubfolders) return exact;
  return {
    or: [exact, { text: { field: "fm.path", mode: "starts_with", value: `${path}/` } }],
  };
}

export interface FolderContentsProps {
  readonly documents: DocumentsApi;
  readonly folder: string;
  readonly onOpen: (id: string) => void;
  readonly onNewDocumentHere: (folder: string) => void;
}

export function FolderContents({
  documents,
  folder,
  onOpen,
  onNewDocumentHere,
}: FolderContentsProps): ReactElement {
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [rows, setRows] = useState<readonly { id: string; title: string; path: string }[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | undefined>(undefined);

  const path = normalizePath(folder);
  const query = useMemo<DocumentQuery>(
    () => ({
      filter: folderFilter(path, includeSubfolders),
      sort: [{ field: "title", direction: "asc" }],
      limit: 500,
    }),
    [includeSubfolders, path],
  );

  useEffect(() => {
    let live = true;
    let close: (() => void) | undefined;
    setState("loading");
    void (async () => {
      try {
        const subscription = await documents.subscribe(query);
        if (!live) {
          subscription.close();
          return;
        }
        const publish = (result: { rows: readonly { id: string; title: string; fm: { readonly [key: string]: unknown } }[] }): void => {
          setRows(
            result.rows.map((row) => ({
              id: row.id,
              title: row.title,
              path: normalizePath(row.fm["path"]),
            })),
          );
          setState("ready");
        };
        publish(subscription.result);
        const off = subscription.onChange(publish);
        close = () => {
          off();
          subscription.close();
        };
      } catch (cause) {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setState("error");
      }
    })();
    return () => {
      live = false;
      close?.();
    };
  }, [documents, query]);

  return (
    <section className="mx-auto flex w-full max-w-[56rem] flex-col gap-5 p-3 font-sans text-text compact:p-2" aria-labelledby="folder-contents-heading">
      <header className="flex flex-col gap-3 rounded-lg border border-border bg-bg-raised p-4 shadow-1 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="folder-contents-heading" className="m-0 font-mono text-lg">{path === "" ? "Root" : path}</h2>
        <button type="button" className="tap rounded-md border border-border bg-bg-subtle px-3 hover:bg-accent-subtle" onClick={() => onNewDocumentHere(path)}>
          New document here
        </button>
      </header>

      {path !== "" && (
        <label className="flex min-h-[var(--lm-tap-target)] items-center gap-1 text-sm text-text-muted">
          <input
            type="checkbox"
            checked={includeSubfolders}
            onChange={(event) => setIncludeSubfolders(event.target.checked)}
          />
          <span>Include subfolders</span>
        </label>
      )}

      {state === "error" && (
        <p className="m-0 rounded-md border border-danger bg-bg-raised p-3 text-sm" role="alert">
          {error}
        </p>
      )}

      {state === "loading" ? (
        <p className="m-0 text-sm text-text-muted" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col gap-3 text-sm text-text-muted">
          <p>
            {path === ""
              ? "Nothing at the root yet."
              : `Nothing in ${path}${includeSubfolders ? " or its subfolders" : ""} yet.`}
          </p>
          <p>
            {path === "" ? (
              <>
                A document with no <code>path:</code> line in its frontmatter sits here.
              </>
            ) : (
              <>
                Set <code>path: {path}</code> in a document’s properties to file it here.
              </>
            )}
          </p>
        </div>
      ) : (
        <ul className="folders-doc-list m-0 flex list-none flex-col overflow-hidden rounded-lg border border-border bg-bg-raised shadow-1">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-0 items-center gap-3 border-b border-border px-3 last:border-b-0">
              <button
                type="button"
                className="folders-doc tap min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-link"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, row.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => onOpen(row.id)}
              >
                {row.title}
              </button>
              {includeSubfolders && row.path !== path && (
                <span className="folders-doc-path min-w-[3ch] truncate font-mono text-xs text-text-muted">{row.path}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <details className="text-sm text-text-muted">
        {/* Same wording as the document list's own disclosure: a spec section number is
            a note to whoever builds this, not to whoever uses it. */}
        <summary>Show the filter as JSON</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-bg-subtle p-3 font-mono">{JSON.stringify(query.filter, null, 2)}</pre>
      </details>
    </section>
  );
}
