/**
 * `folders` — a tree over `fm.path` (SPEC §6.5).
 *
 * There are no folder objects. A "folder" is a prefix of the `fm.path` values that
 * exist in the projection, derived on the fly — which is why moving a document is a
 * *frontmatter splice* and nothing else, and why renaming a folder is a splice per
 * document inside it.
 *
 * Path normalization is fixed by SPEC §6.5 and implemented exactly, in `path.ts`, with a
 * test per clause: `/` segments, `.`/`..`/empty segments **stripped** (not resolved),
 * **case-sensitive**, duplicate names allowed (documents are id-addressed, so two
 * `home/lists` differing in case are two folders and that is intended).
 *
 * **Every write here is one `setFrontmatterValue` call** (SPEC §3.3). That is the whole
 * feature: no folder records to keep consistent, no rename transaction, nothing to
 * migrate. A rename is a loop of splices, and if it is interrupted half the documents
 * moved — which is recoverable, visible, and vastly preferable to a second source of
 * truth about where a document lives.
 *
 * Note for anyone running this today: `kernel.documents.splice` is still unimplemented in
 * the kernel runtime (it needs the core splice ABI in Wasm — `web/CONTRACTS.md` calls it
 * out as M3's one cross-area dependency). Moves and renames therefore surface the kernel's
 * `NotImplementedError` in the tree's error line rather than silently doing nothing, and
 * they start working the moment that lands, with no change here.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { DocumentRow, Kernel } from "@kernel";

import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";

import { FolderContents } from "./FolderContents.js";
import { FolderTree } from "./FolderTree.js";
import { buildTree, isRecursiveRename, normalizePath, renamedPath, type PathRow } from "./path.js";
import {
  POINTS,
  type Command,
  type MainView,
  type Route,
  type SidebarPanel,
} from "../../_shared/points.js";

/** A workspace bigger than this needs paging in the tree; say so rather than truncate quietly. */
const TREE_ROW_LIMIT = 20_000;

/**
 * How many documents a folder rename splices at once.
 *
 * Small on purpose: every splice hydrates a document and waits for a sync round trip, so
 * serial is slow (hundreds of sequential round trips for one rename) while unbounded is
 * worse — the in-memory replica LRU holds ~20 documents and the persisted set 50 (SPEC
 * §4.1), so a wide fan-out evicts the user's editable working set to move metadata.
 */
const RENAME_CONCURRENCY = 6;

export interface RenameOptions {
  /** Called after each document, including the ones that failed. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface FoldersApi {
  /** Normalize a raw `fm.path` value the way the tree does. */
  normalize(path: string): string;
  /** Every folder path in the workspace, sorted, with document counts. */
  tree(): Promise<readonly { readonly path: string; readonly documents: number }[]>;
  /** Move one document: a single `fm.path` splice (SPEC §3.3). */
  move(documentId: string, path: string): Promise<void>;
  /**
   * Move every document under `from` to `to`. One splice per document, run through a
   * small pool; `onProgress` fires after each one so a caller can show how far it got.
   */
  renameFolder(from: string, to: string, options?: RenameOptions): Promise<number>;
  /** The folder currently shown, or `undefined` when another view is. */
  current(): string | undefined;
}

interface DocListService {
  createDocument(options?: { readonly path?: string; readonly title?: string }): Promise<string>;
  /** Creates and reports its own failures (offline, above all). */
  newDocument(options?: { readonly path?: string; readonly title?: string }): void;
}

interface RouterService {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  onChange(listener: (path: string) => void): () => void;
  current(): string;
}

/** `#/folder?path=home/lists` — a query string, because `:name` matches one segment. */
const folderPath = (folder: string): string => {
  const path = normalizePath(folder);
  return path === "" ? "/folder?path=" : `/folder?path=${encodeURIComponent(path)}`;
};

const folderFromHash = (hash: string): string => {
  const route = hash.replace(/^#/, "");
  const index = route.indexOf("?");
  if (index === -1) return "";
  return normalizePath(new URLSearchParams(route.slice(index + 1)).get("path") ?? "");
};

export default function activate(kernel: Kernel): FoldersApi {
  const docs = kernel.services.require<DocListService>("doc-list");
  const router = kernel.services.require<RouterService>("router");

  /** Every live row, subscribed once and shared by the tree and the API. */
  const rowsListeners = new Set<() => void>();
  let rows: readonly PathRow[] = [];
  let loading = true;
  let loadError: string | undefined;

  const publish = (): void => {
    for (const listener of [...rowsListeners]) listener();
  };

  void (async () => {
    try {
      // One live query for the whole tree. `subscribe` re-runs only when a change can
      // alter the result (SPEC §4.2), so this is one subscription, not one per folder.
      //
      // **Machine-owned documents are excluded here rather than in the tree widget**
      // (`_shared/machine-docs.ts`), so every consumer of `rows` inherits it: the
      // counts, the "unfiled" total, *and* the rename walk — which is the one that
      // would otherwise matter. A folder rename splices `fm.path` on every row it
      // matches, and the kernel's settings documents are machine-owned (SPEC §3.3):
      // a tree that listed `.settings` would offer F2 on it and rewrite frontmatter
      // the kernel authors.
      //
      // No toggle here, deliberately. A hidden folder in a tree is a control that
      // looks like every other folder and behaves differently; `doc-list`'s "show
      // machine documents" is where the escape hatch belongs, because a list can hold
      // a mixed set without implying that a dotted folder is yours to reorganise.
      const subscription = await kernel.documents.subscribe({
        filter: EXCLUDE_MACHINE_DOCUMENTS,
        limit: TREE_ROW_LIMIT,
      });
      const take = (result: { rows: readonly DocumentRow[] }): void => {
        rows = result.rows.map((row) => ({ id: row.id, fm: row.fm }));
        loading = false;
        publish();
      };
      take(subscription.result);
      subscription.onChange(take);
    } catch (cause) {
      loading = false;
      loadError = cause instanceof Error ? cause.message : String(cause);
      publish();
    }
  })();

  const useRows = (): { rows: readonly PathRow[]; loading: boolean; error?: string } => {
    const [, setRevision] = useState(0);
    useEffect(() => {
      const listener = (): void => setRevision((value) => value + 1);
      rowsListeners.add(listener);
      return () => {
        rowsListeners.delete(listener);
      };
    }, []);
    return { rows, loading, ...(loadError !== undefined ? { error: loadError } : {}) };
  };

  // ---------------------------------------------------------------------------
  // Writes — all of them one splice
  // ---------------------------------------------------------------------------

  const move = async (documentId: string, path: string): Promise<void> => {
    const target = normalizePath(path);
    // The whole feature, in one call: no re-serialization of the frontmatter block.
    if (target === "") {
      await kernel.documents.splice.removeFrontmatterKey(documentId, "path");
      return;
    }
    await kernel.documents.splice.setFrontmatterValue(documentId, "path", target);
  };

  const renameFolder = async (
    from: string,
    to: string,
    options?: RenameOptions,
  ): Promise<number> => {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === "") throw new Error("the unfiled root cannot be renamed");
    if (isRecursiveRename(source, target)) {
      throw new Error(`Cannot move “${source}” into itself.`);
    }

    // The documents that actually move, decided before any write, so there is a total
    // to report progress against.
    const targets: { readonly id: string; readonly next: string }[] = [];
    for (const row of rows) {
      const next = renamedPath(normalizePath(row.fm["path"]), source, target);
      if (next !== undefined) targets.push({ id: row.id, next });
    }

    let moved = 0;
    let done = 0;
    const failures: string[] = [];
    options?.onProgress?.(0, targets.length);

    const writeOne = async (entry: { readonly id: string; readonly next: string }): Promise<void> => {
      try {
        if (entry.next === "") {
          await kernel.documents.splice.removeFrontmatterKey(entry.id, "path");
        } else {
          await kernel.documents.splice.setFrontmatterValue(entry.id, "path", entry.next);
        }
        moved += 1;
      } catch (cause) {
        // A rename is a set of independent splices: one failure must not abandon the
        // rest, and the user has to be told how far it got.
        failures.push(cause instanceof Error ? cause.message : String(cause));
      } finally {
        done += 1;
        options?.onProgress?.(done, targets.length);
      }
    };

    // A bounded pool rather than a serial loop or `Promise.all`.
    //
    // Each splice hydrates its document (`documents.open`) and waits for a sync round
    // trip before releasing it, so a folder of a few hundred documents was a few hundred
    // *sequential* round trips from inside a click handler — tens of seconds of frozen
    // tree on a LAN, minutes on a slow link. All at once is not the answer either: the
    // in-memory LRU holds ~20 documents and the persisted replica set 50 (SPEC §4.1), so
    // unbounded parallelism evicts the working set and floods one socket. A small pool
    // overlaps the latency without changing the churn.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(RENAME_CONCURRENCY, targets.length) }, async () => {
      for (;;) {
        const entry = targets[cursor++];
        if (entry === undefined) return;
        await writeOne(entry);
      }
    });
    await Promise.all(workers);

    if (failures.length > 0) {
      throw new Error(
        `moved ${moved} document${moved === 1 ? "" : "s"}; ${failures.length} failed: ${failures[0] ?? ""}`,
      );
    }
    return moved;
  };

  // ---------------------------------------------------------------------------
  // Contributions
  // ---------------------------------------------------------------------------

  const TreeHost = (): ReactElement => {
    const live = useRows();
    return (
      <FolderTree
        rows={live.rows}
        loading={live.loading}
        {...(live.error !== undefined ? { error: live.error } : {})}
        onMoveDocument={move}
        onRenameFolder={renameFolder}
        onNewDocumentHere={(folder) => docs.newDocument({ path: folder })}
        onSelectFolder={(folder) => router.navigate(folderPath(folder))}
        prompt={(message, initial) => globalThis.prompt(message, initial)}
      />
    );
  };

  const ContentsHost = (): ReactElement => {
    const [folder, setFolder] = useState(() => folderFromHash(location.hash));
    useEffect(() => router.onChange(() => setFolder(folderFromHash(location.hash))), []);
    return (
      <FolderContents
        documents={kernel.documents}
        folder={folder}
        onOpen={(id) => router.navigate(`/doc/${id}`)}
        onNewDocumentHere={(target) => docs.newDocument({ path: target })}
      />
    );
  };

  kernel.extensions.contribute<SidebarPanel>(POINTS.sidebarPanel, {
    id: "folders.tree",
    title: "Folders",
    order: 20,
    defaultOpen: true,
    component: TreeHost,
  });

  kernel.extensions.contribute<Route>(POINTS.route, { path: "/folder", view: "folders.contents" });
  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "folders.contents",
    title: "Folder",
    component: ContentsHost,
  });

  for (const command of [
    {
      id: "folders.newDocumentHere",
      title: "New document in this folder",
      category: "Folders",
      run: () => docs.newDocument({ path: api.current() ?? "" }),
    },
    {
      id: "folders.renameFolder",
      title: "Rename or move this folder",
      category: "Folders",
      when: () => (api.current() ?? "") !== "",
      run: async () => {
        const folder = api.current();
        if (!folder) return;
        const answer = globalThis.prompt(`Rename or move “${folder}” to:`, folder);
        if (answer === null) return;
        const moved = await renameFolder(folder, answer);
        kernel.log.info(`moved ${moved} document(s) from ${folder}`);
        router.navigate(folderPath(answer));
      },
    },
    {
      id: "folders.showUnfiled",
      title: "Show unfiled documents",
      category: "Folders",
      run: () => router.navigate(folderPath("")),
    },
  ] satisfies Command[]) {
    kernel.extensions.contribute<Command>(POINTS.command, command);
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  const api: FoldersApi = {
    normalize: (path) => normalizePath(path),
    tree: async () =>
      buildTree(rows).flat.map((node) => ({ path: node.path, documents: node.documents })),
    move,
    renameFolder,
    current: () => {
      const route = router.current();
      return route.split("?")[0] === "/folder" ? folderFromHash(route) : undefined;
    },
  };

  return api;
}
