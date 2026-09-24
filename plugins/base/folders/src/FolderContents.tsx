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
    // Unfiled: no `fm.path` at all, or one that normalizes away. `missing` and `is_null`
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
    <section className="folders-contents" aria-labelledby="folder-contents-heading">
      <header className="folders-contents-header">
        <h2 id="folder-contents-heading">{path === "" ? "Unfiled documents" : path}</h2>
        <button type="button" onClick={() => onNewDocumentHere(path)}>
          New document here
        </button>
      </header>

      {path !== "" && (
        <label className="folders-checkbox">
          <input
            type="checkbox"
            checked={includeSubfolders}
            onChange={(event) => setIncludeSubfolders(event.target.checked)}
          />
          <span>Include subfolders</span>
        </label>
      )}

      {state === "error" && (
        <p className="folders-error" role="alert">
          {error}
        </p>
      )}

      {state === "loading" ? (
        <p className="folders-empty" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <div className="folders-empty">
          <p>
            {path === ""
              ? "Every document has a folder."
              : `Nothing in ${path}${includeSubfolders ? " or its subfolders" : ""} yet.`}
          </p>
          <p>
            A document joins this folder by having <code>path: {path || "…"}</code> in its
            frontmatter — drag one here, or create one.
          </p>
        </div>
      ) : (
        <ul className="folders-doc-list">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="folders-doc"
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
                <span className="folders-doc-path">{row.path}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <details className="folders-json">
        <summary>Filter (the shared DSL, SPEC §4.2)</summary>
        <pre>{JSON.stringify(query.filter, null, 2)}</pre>
      </details>
    </section>
  );
}
