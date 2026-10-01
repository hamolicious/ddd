/**
 * `doc-list` — the all-documents page, new documents, and the **Trash view** (SPEC §6.5).
 *
 * **The all-documents page is a search, as a table** — `table`'s `TablePage`
 * (`plugin:table`), with the search in the URL: `#/?q=milk&where=…` is the spec's own
 * query string, and the table's columns ride along as `t.<key>`, so it survives reload and
 * "back" from a result, and the old `#/search?q=` address opens the same page. Searching
 * and filtering are `search`'s, the table and saving it are `table`'s; this plugin owns the
 * route, the heading, and "Search documents" (Ctrl+Space by default), which opens the page
 * and focuses the bar.
 *
 * Everything shown comes from `kernel.documents.subscribe`, which is a *live* local query:
 * the list updates as the feed arrives, offline included, with no polling and no REST
 * browsing (SPEC §4.1, §4.2).
 *
 * Two details, both implemented in the files next to this one:
 *
 * - **Trash is `includeDeleted` plus a filter, not another store.** A tombstoned
 *   document is an ordinary projection row with `deleted: true` and is restorable for
 *   30 days; purge is the server's job and is permanent (SPEC §3.5).
 * - **Trash sorts by `deleted_at` in the engine.** That root was outside the shared
 *   filter DSL's field space when this view was built, so the rows were ordered in the
 *   component after the query — correct only over the page that came back. The core
 *   change `backend/CONTRACTS.md` promised has landed, so the direction toggle is now a
 *   sort key on the query and the order holds over the whole of Trash.
 *
 * **`createDocument` authors the whole text, once.** That is the one moment when writing
 * a frontmatter block wholesale is correct (SPEC §3.3): there is no concurrent writer to
 * merge with yet, and no existing block to destroy. Every *later* metadata write in this
 * plugin's neighbourhood goes through `kernel.documents.splice`.
 *
 * **Acting on results is commands.** `search`'s Actions button lists every command that
 * `takes: "documents"` (`plugin:commands`' `addCommand`) and runs it with the ids listed. This
 * plugin's own is "Move to Trash"; `folders` offers "Move to folder…". A single note's
 * menu, wherever it is right-clicked, starts with this plugin's "Open" and ends with its
 * "Move to Trash" (`plugin:context-menu`'s `addAction`).
 *
 * **Where a new document is filed is not this plugin's business.** `createDocument`
 * takes an opaque `parent` hint and announces every document it created through
 * `plugin:doc-events`' `notifyCreated`, hint included; `folders` subscribes (`onCreated`)
 * and files it — under the hint, or wherever its "new notes go to" setting says. Through
 * `doc-events` rather than a call because `folders` depends on this plugin, and the
 * reverse would be a cycle.
 * No `folders`, or one that failed to activate: the document is still created, at the
 * root. No plugin's opinion about folders may stop the app's most common action.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";
import { addCommand, addKeybinding } from "plugin:commands";
import { addAction, confirm } from "plugin:context-menu";
import { notifyCreated } from "plugin:doc-events";
import { addRoute, current, navigate, onChange } from "plugin:router";
import { encode, parse } from "plugin:search";
import type { SearchSpec } from "plugin:search";
import { addSidebarPanel, addView } from "plugin:shell-ui";
import { TablePage, save as saveTable } from "plugin:table";

import { sameOptions } from "../../_shared/saved-view.js";
import { yamlScalar } from "../../_shared/yaml.js";

import { TrashView } from "./DocListView.js";
import { ViewsPanel } from "./ViewsPanel.js";

/** The query string part of a hash route, `""` when it has none. */
function queryOf(hash: string): string {
  const path = hash.replace(/^#/, "");
  const index = path.indexOf("?");
  return index === -1 ? "" : path.slice(index + 1);
}

/** A document's hash path, deep-linked to a line (`document-surface`'s `?line=`). */
function documentPath(id: string, line?: number): string {
  const path = `/doc/${encodeURIComponent(id)}`;
  return line !== undefined && Number.isSafeInteger(line) && line >= 1 ? `${path}?line=${String(line)}` : path;
}

export interface NewDocumentOptions {
  /**
   * Where the new document belongs, as a hint for whoever files documents (`folders`
   * files it under this note). Passed on to `plugin:doc-events`' `notifyCreated`.
   */
  readonly parent?: string;
  readonly title?: string;
}

/**
 * What this plugin exports for creating documents (the old `ddd/document-browser`
 * service). `createDocument` rejects when the server cannot be reached (creation is REST,
 * SPEC §5.1); a caller with nowhere to show that uses `newDocument`, which never rejects
 * and reports a failure as a notice with a retry action.
 */
export interface DocumentBrowser {
  /** Create an empty document and navigate to it. Rejects when the server cannot be reached. */
  readonly createDocument: (options?: NewDocumentOptions) => Promise<string>;
  /** The same, for UI entry points: never rejects, and reports a failure as a notice with a retry. */
  readonly newDocument: (options?: NewDocumentOptions) => void;
  /** The ids currently shown, for "select all" style commands. */
  readonly visible: () => readonly string[];
}

export type DocListApi = DocumentBrowser;

/** The table's settings on the all-documents page. */
type TableOptions = Readonly<Record<string, string>>;

/** The URL prefix of the table's settings, beside the search's own params. */
const TABLE_PARAM = "t.";

/** The table's settings a list URL's query string carries. */
function tableOptionsOf(query: string): TableOptions {
  const options: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (key.startsWith(TABLE_PARAM) && key.length > TABLE_PARAM.length && value !== "") options[key.slice(TABLE_PARAM.length)] = value;
  }
  return options;
}

// The functions of the plugins this one depends on, grouped as they are read below.
const router = { navigate, current, onChange };
const menu = { confirm };
const search = { parse, encode };
const table = { TablePage, save: saveTable };

let kernelRef: Kernel | undefined;

const active = (): Kernel => {
  if (!kernelRef) throw new Error("doc-list is not active yet: call it from your plugin's activate() or later");
  return kernelRef;
};

/** Ids the list last rendered, for `visible()`. */
let visibleIds: readonly string[] = [];

/**
 * "Search documents" asks for the field before the list may be on screen, so the request
 * waits here and the field takes it when it mounts; a list already open is focused at once.
 */
let focusWanted = false;
let focusSearch: (() => void) | undefined;

/** Create an empty document and navigate to it. Rejects when the server cannot be reached. */
export async function createDocument(options?: NewDocumentOptions): Promise<string> {
  const kernel = active();
  // A new document is just text. The frontmatter block is written here rather than
  // spliced afterwards: at creation there is no concurrent writer to merge with, and
  // this is the one moment when authoring the whole text is correct (SPEC §3.3).
  const title = options?.title ?? "Untitled";
  // Frontmatter only: a new note starts empty.
  const text = ["---", `title: ${yamlScalar(title)}`, "---", ""].join("\n");
  const id = await kernel.documents.create({ text });
  // Filing is whoever listens: `folders` puts it under `parent`, or its default.
  notifyCreated(options?.parent !== undefined ? { id, parent: options.parent } : { id });
  router.navigate(`/doc/${id}`);
  return id;
}

/**
 * Creating a document is offered from four places — `Mod+N`, the navbar, the palette and
 * the folder tree — and **it can fail**: offline it succeeds on the device, but the server
 * can still refuse it (too large, say). Throwing the promise away meant the palette
 * closed, no document opened, and the only trace was an unhandled rejection in the
 * console. Every entry point goes through this instead, so a failure is a notice with a
 * retry, the way the delete and restore paths already surface theirs.
 */
export function newDocument(options?: NewDocumentOptions): void {
  const kernel = active();
  void createDocument(options).catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    kernel.log.error("could not create a document", cause);
    kernel.ui.notify({
      id: "doc-list.create-failed",
      level: "error",
      message: `Could not create the document: ${message}`,
      actions: [{ label: "Try again", run: () => newDocument(options) }],
    });
  });
}

/** The ids currently shown, for "select all" style commands. */
export function visible(): readonly string[] {
  return visibleIds;
}

export default function activate(kernel: Kernel): void {
  kernelRef = kernel;
  /** The list's path for a search and its table: the bare list for the default one. */
  const pathFor = (spec: SearchSpec, options: TableOptions): string => {
    const params = new URLSearchParams(search.encode(spec));
    for (const key of Object.keys(options).sort()) {
      const value = options[key];
      if (value !== undefined && value !== "") params.set(`${TABLE_PARAM}${key}`, value);
    }
    const encoded = params.toString();
    return encoded === "" ? "/" : `/?${encoded}`;
  };

  const open = (id: string, line?: number): void => router.navigate(documentPath(id, line));

  const openSearch = (): void => {
    const onList = router.current().split("?")[0] === "/";
    if (!onList) router.navigate("/");
    if (focusSearch) focusSearch();
    else focusWanted = true;
  };

  const create = newDocument;

  /** "Move to Trash" for many documents at once, after asking. */
  const trashAll = async (argument: unknown): Promise<void> => {
    const ids = Array.isArray(argument) ? argument.filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) return;
    const many = ids.length === 1 ? "this document" : `these ${ids.length.toLocaleString()} documents`;
    const sure = await menu.confirm({
      title: `Move ${many} to Trash?`,
      description: "They can be restored from Trash for 30 days.",
      confirmLabel: "Move to Trash",
      danger: true,
    });
    if (!sure) return;
    const results = await Promise.allSettled(ids.map((id) => kernel.documents.delete(id)));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      kernel.ui.notify({
        id: "doc-list.trash-failed",
        level: "error",
        message: `${failed.toLocaleString()} of ${ids.length.toLocaleString()} documents could not be moved to Trash.`,
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  const ListHost = (): ReactElement => {
    const [spec, setSpec] = useState<SearchSpec>(() => search.parse(queryOf(location.hash)));
    const [options, setOptions] = useState<TableOptions>(() => tableOptionsOf(queryOf(location.hash)));
    const input = useRef<HTMLInputElement>(null);

    // The URL is the state: back, forward and links move the search.
    useEffect(() => {
      // The old results page's address, spelled the list's way — on arrival, and on a
      // hash change while the list is already on screen (same view, no remount).
      const canonical = (): void => {
        if (router.current().split("?")[0] === "/search") {
          const query = queryOf(location.hash);
          router.navigate(pathFor(search.parse(query), tableOptionsOf(query)), { replace: true });
        }
      };
      canonical();
      return router.onChange(() => {
        canonical();
        // Compared encoded: the URL holds the trimmed text, and echoing it back would eat
        // the space typed between two words; filter row ids are not in it either.
        const query = queryOf(location.hash);
        const next = search.parse(query);
        setSpec((current) => (search.encode(current) === search.encode(next) ? current : next));
        const nextOptions = tableOptionsOf(query);
        setOptions((current) => (sameOptions(current, nextOptions) ? current : nextOptions));
      });
    }, []);
    useEffect(() => {
      focusSearch = () => {
        input.current?.focus();
        input.current?.select();
      };
      if (focusWanted) {
        focusWanted = false;
        focusSearch();
      }
      return () => {
        focusSearch = undefined;
      };
    }, []);

    const Page = table.TablePage;
    return (
      <Page
        spec={spec}
        onSpecChange={(next) => {
          setSpec(next);
          // Replaced, not pushed: one history entry per search, not one per keystroke.
          router.navigate(pathFor(next, options), { replace: true });
        }}
        options={options}
        onOptionsChange={(next) => {
          setOptions(next);
          router.navigate(pathFor(spec, next), { replace: true });
        }}
        heading="Documents"
        onOpen={open}
        searchInput={input}
        onRendered={(ids) => {
          visibleIds = ids;
        }}
        {...(search.encode(spec) !== "" || Object.keys(options).length > 0
          ? {
              onSave: () => {
                void table.save(spec, options).catch((cause: unknown) => {
                  kernel.log.error("could not save the search", cause);
                  kernel.ui.notify({
                    id: "doc-list.save-search-failed",
                    level: "error",
                    message: `Could not save the search: ${cause instanceof Error ? cause.message : String(cause)}`,
                  });
                });
              },
            }
          : {})}
      />
    );
  };

  const TrashHost = (): ReactElement => (
    <TrashView
      documents={kernel.documents}
      onOpen={open}
      onRestore={(id) => kernel.documents.restore(id)}
      currentUserId={kernel.session.user.id}
    />
  );

  const PanelHost = (): ReactElement => {
    const [path, setPath] = useState(() => router.current());
    useEffect(() => router.onChange(setPath), []);
    return (
      <ViewsPanel
        documents={kernel.documents}
        current={path.split("?")[0] ?? "/"}
        onNavigate={(next) => router.navigate(next)}
      />
    );
  };

  // `/` is the catch-all. The router ranks routes by specificity and breaks ties by `order`.
  addRoute([
    { path: "/", view: "doc-list.all", order: 900 },
    { path: "/search", view: "doc-list.all" },
    { path: "/trash", view: "doc-list.trash" },
  ]);

  addView([
    { id: "doc-list.all", title: "Documents", component: ListHost },
    { id: "doc-list.trash", title: "Trash", component: TrashHost },
  ]);

  // Any note's menu: Open first, Move to Trash last. `document.trash` is a shared id, so a
  // plugin that knows more (`folders`, about the notes inside) replaces it by adding its own.
  addAction([
    {
      id: "document.open",
      target: "ddd/document",
      order: 0,
      items: (target) => [{ id: "open", label: "Open", run: () => router.navigate(`/doc/${encodeURIComponent(target.id)}`) }],
    },
    {
      id: "document.trash",
      target: "ddd/document",
      order: 100,
      items: (target) => [
        {
          id: "trash",
          label: "Move to Trash",
          hint: "Restorable for 30 days.",
          danger: true,
          run: () =>
            void kernel.documents.delete(target.id).catch((cause: unknown) =>
              kernel.ui.notify({
                id: "doc-list.trash-failed",
                level: "error",
                message: `Could not move it to Trash: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
            ),
        },
      ],
    },
  ]);

  addSidebarPanel({
    id: "doc-list.views",
    title: "Views",
    order: 10,
    defaultOpen: true,
    component: PanelHost,
  });

  addCommand([
    {
      id: "doc-list.new",
      title: "New document",
      category: "Documents",
      icon: "file-plus",
      run: () => create(),
    },
    {
      id: "doc-list.all",
      title: "Show all documents",
      category: "Documents",
      icon: "files",
      run: () => router.navigate("/"),
    },
    {
      id: "doc-list.search",
      title: "Search documents",
      category: "Documents",
      icon: "search",
      run: openSearch,
    },
    {
      id: "doc-list.openTrash",
      title: "Open Trash",
      category: "Documents",
      icon: "trash-x",
      run: () => router.navigate("/trash"),
    },
    {
      id: "doc-list.trashDocuments",
      title: "Move to Trash",
      category: "Documents",
      icon: "trash",
      takes: "documents",
      run: trashAll,
    },
  ]);
  addKeybinding([
    { command: "doc-list.new", keys: "Mod+N" },
    // Literal Ctrl, not Mod: Cmd+Space is the Mac's own search.
    { command: "doc-list.search", keys: "Ctrl+Space" },
  ]);
}

export function deactivate(): void {
  kernelRef = undefined;
  focusSearch = undefined;
  focusWanted = false;
}
