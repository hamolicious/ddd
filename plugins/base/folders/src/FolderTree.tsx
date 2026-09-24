/**
 * The folder tree, in the sidebar.
 *
 * **Keyboard-operable, as a real tree.** `role="tree"` with one tab stop and
 * `aria-activedescendant`: `ArrowDown`/`ArrowUp` move, `ArrowRight`/`ArrowLeft` expand and
 * collapse (collapsed-`ArrowLeft` jumps to the parent, which is the WAI-ARIA behaviour),
 * `Home`/`End` jump, `Enter` filters the list to the folder, `F2` renames. That is SPEC
 * §8's "keyboard-operable" applied to the one widget in the base distribution that is
 * genuinely two-dimensional.
 *
 * **Drag and drop is the mouse shorthand, never the only path.** Dropping a document on a
 * folder moves it; so does the "Move to…" prompt on the row, and so does the properties
 * panel editing `fm.path` directly. All three end in the same place: one
 * `kernel.documents.splice.setFrontmatterValue` call (SPEC §3.3).
 *
 * The drag payload is a plain text/plain document id, deliberately: `doc-list` rows and
 * anything else that wants to be draggable into a folder only has to set that, with no
 * shared type and no import between plugins.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";

import { buildTree, parentOf, type FolderNode, type PathRow } from "./path.js";

/** The drag type a draggable document row should set. */
export const DOCUMENT_DRAG_TYPE = "text/plain";

export interface FolderTreeProps {
  readonly rows: readonly PathRow[];
  readonly loading: boolean;
  readonly error?: string;
  /** Move one document into a folder (a single `fm.path` splice). */
  readonly onMoveDocument: (documentId: string, folder: string) => Promise<void>;
  /** Rename/move a folder: one splice per document inside it, with progress. */
  readonly onRenameFolder: (
    from: string,
    to: string,
    options?: { readonly onProgress?: (done: number, total: number) => void },
  ) => Promise<number>;
  readonly onNewDocumentHere: (folder: string) => void;
  /** Show the documents in a folder (the doc-list view, filtered). */
  readonly onSelectFolder: (folder: string) => void;
  /** Ask the user for a new folder name; injected so this file stays testable-by-eye. */
  readonly prompt: (message: string, initial: string) => string | null;
}

export function FolderTree({
  rows,
  loading,
  error,
  onMoveDocument,
  onRenameFolder,
  onNewDocumentHere,
  onSelectFolder,
  prompt,
}: FolderTreeProps): ReactElement {
  const tree = useMemo(() => buildTree(rows), [rows]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined);
  const treeRef = useRef<HTMLDivElement | null>(null);

  /** Rows the user can actually reach: descendants of a collapsed folder are hidden. */
  const visible = useMemo(() => {
    const hidden = (path: string): boolean => {
      let parent = parentOf(path);
      while (parent !== "") {
        if (collapsed.has(parent)) return true;
        parent = parentOf(parent);
      }
      return false;
    };
    return tree.flat.filter((node) => !hidden(node.path));
  }, [collapsed, tree.flat]);

  // An active row that just disappeared (its parent collapsed, its documents moved) would
  // leave `aria-activedescendant` pointing at nothing.
  useEffect(() => {
    if (active !== undefined && !visible.some((node) => node.path === active)) {
      setActive(visible[0]?.path);
    }
  }, [active, visible]);

  const toggle = useCallback((path: string, expand?: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      const shouldExpand = expand ?? next.has(path);
      if (shouldExpand) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rename = useCallback(
    (node: FolderNode) => {
      const answer = prompt(`Rename or move “${node.path}” to:`, node.path);
      if (answer === null) return;
      setBusy(true);
      setProblem(undefined);
      setProgress(undefined);
      // A rename is one splice per document inside the folder, and each one is a sync
      // round trip — so a big folder takes real time. Reporting how far it has got is
      // the difference between "working" and "frozen".
      void onRenameFolder(node.path, answer, {
        onProgress: (done, total) => setProgress(total > 1 ? { done, total } : undefined),
      })
        .catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => {
          setBusy(false);
          setProgress(undefined);
        });
    },
    [onRenameFolder, prompt],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (visible.length === 0) return;
      const index = visible.findIndex((node) => node.path === active);
      const node = index >= 0 ? visible[index] : undefined;
      const move = (next: number): void => {
        event.preventDefault();
        setActive(visible[Math.max(0, Math.min(visible.length - 1, next))]?.path);
      };

      switch (event.key) {
        case "ArrowDown":
          move(index + 1);
          return;
        case "ArrowUp":
          move(index < 0 ? 0 : index - 1);
          return;
        case "Home":
          move(0);
          return;
        case "End":
          move(visible.length - 1);
          return;
        case "ArrowRight":
          if (node && node.children.length > 0 && collapsed.has(node.path)) {
            event.preventDefault();
            toggle(node.path, true);
          } else if (node && node.children.length > 0) {
            move(index + 1);
          }
          return;
        case "ArrowLeft":
          if (!node) return;
          event.preventDefault();
          if (node.children.length > 0 && !collapsed.has(node.path)) {
            toggle(node.path, false);
            return;
          }
          {
            const parent = parentOf(node.path);
            if (parent !== "") setActive(parent);
          }
          return;
        case "Enter":
          if (node) {
            event.preventDefault();
            onSelectFolder(node.path);
          }
          return;
        case "F2":
          if (node) {
            event.preventDefault();
            rename(node);
          }
          return;
        default:
      }
    },
    [active, collapsed, onSelectFolder, rename, toggle, visible],
  );

  const drop = useCallback(
    (folder: string, documentId: string) => {
      setDropTarget(undefined);
      if (documentId === "") return;
      setBusy(true);
      setProblem(undefined);
      void onMoveDocument(documentId, folder)
        .catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setBusy(false));
    },
    [onMoveDocument],
  );

  if (loading) {
    return (
      <p className="folders-empty" role="status">
        Loading folders…
      </p>
    );
  }

  return (
    <div className="folders">
      {error && (
        <p className="folders-error" role="alert">
          {error}
        </p>
      )}
      {problem && (
        <p className="folders-error" role="alert">
          {problem}
        </p>
      )}
      {progress && (
        <p className="folders-progress" role="status">
          Moving documents… {progress.done} of {progress.total}
        </p>
      )}

      {tree.roots.length === 0 ? (
        <div className="folders-empty">
          <p>No folders yet.</p>
          <p>
            A folder is just a <code>path:</code> line in a document’s frontmatter —
            <code> path: home/lists</code> puts it in <code>home</code> → <code>lists</code>.
            Nothing is created or deleted: the tree is whatever paths exist.
          </p>
        </div>
      ) : (
        <div
          className="folders-tree"
          role="tree"
          aria-label="Folders"
          aria-busy={busy}
          tabIndex={0}
          ref={treeRef}
          {...(active !== undefined ? { "aria-activedescendant": `folders-node-${active}` } : {})}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (active === undefined) setActive(visible[0]?.path);
          }}
        >
          {visible.map((node) => {
            const expandable = node.children.length > 0;
            const expanded = expandable ? !collapsed.has(node.path) : undefined;
            return (
              <div
                key={node.path}
                id={`folders-node-${node.path}`}
                role="treeitem"
                aria-level={node.depth + 1}
                aria-selected={node.path === active}
                {...(expanded !== undefined ? { "aria-expanded": expanded } : {})}
                className={[
                  "folders-node",
                  node.path === active ? "folders-node-active" : "",
                  node.path === dropTarget ? "folders-node-drop" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ paddingLeft: `calc(var(--lm-space) * ${node.depth * 1.5 + 0.5})` }}
                onMouseDown={() => setActive(node.path)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropTarget(node.path);
                }}
                onDragLeave={() => setDropTarget((current) => (current === node.path ? undefined : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  drop(node.path, event.dataTransfer.getData(DOCUMENT_DRAG_TYPE).trim());
                }}
              >
                {expandable ? (
                  <button
                    type="button"
                    className="folders-twisty"
                    tabIndex={-1}
                    aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                    onClick={() => toggle(node.path)}
                  >
                    {expanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="folders-twisty" aria-hidden="true" />
                )}

                <button
                  type="button"
                  className="folders-name"
                  tabIndex={-1}
                  onClick={() => onSelectFolder(node.path)}
                >
                  {node.name}
                </button>
                <span className="folders-count" aria-label={`${node.documents} documents`}>
                  {node.documents}
                </span>

                <span className="folders-actions">
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`New document in ${node.path}`}
                    title="New document here"
                    onClick={() => onNewDocumentHere(node.path)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Rename or move ${node.path}`}
                    title="Rename or move (F2)"
                    onClick={() => rename(node)}
                  >
                    ✎
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {tree.unfiled > 0 && (
        <button
          type="button"
          className={`folders-unfiled${dropTarget === "" ? " folders-node-drop" : ""}`}
          onClick={() => onSelectFolder("")}
          onDragOver={(event) => {
            event.preventDefault();
            setDropTarget("");
          }}
          onDragLeave={() => setDropTarget((current) => (current === "" ? undefined : current))}
          onDrop={(event) => {
            event.preventDefault();
            drop("", event.dataTransfer.getData(DOCUMENT_DRAG_TYPE).trim());
          }}
        >
          Unfiled <span className="folders-count">{tree.unfiled}</span>
        </button>
      )}

      <p className="folders-hint">
        Drag a document onto a folder to move it, or press F2 on a folder to rename it.
        Renaming rewrites <code>fm.path</code> in every document inside it.
      </p>
    </div>
  );
}
