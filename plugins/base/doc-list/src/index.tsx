/**
 * `doc-list` — browse, search, sort, filter, create, and the **Trash view** (SPEC §6.5).
 *
 * **Search lives here** (it was its own plugin with its own results page). The list
 * page's search bar runs every provider seated on the `search` port (protocol
 * `lm/search.provider`, owned by this plugin), which offers the local index and the
 * server's itself, and the list becomes the ranked results (`search/`, `DocListView`).
 * The text is the URL's `?q=`, so a search survives reload and "back" from a result,
 * and the old `#/search?q=` address opens the same list. "Search documents" (Ctrl+Space by default) opens the list and focuses the bar.
 *
 * Everything it shows comes from `kernel.documents.subscribe`, which is a *live* local
 * query: the list updates as the feed arrives, offline included, with no polling and no
 * REST browsing (SPEC §4.1, §4.2).
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
 * **Acting on results is commands.** The toolbar's Actions button lists every command
 * that `takes: "documents"` (`lm/commands.command`) and runs the chosen one, through the
 * `lm/commands` service, with the ids of the results listed. This plugin's own is "Move
 * to Trash"; `folders` offers "Move to folder…". No `commands` plugin: no button.
 *
 * **Where a new document is filed is not this plugin's business.** `createDocument`
 * takes an opaque `parent` hint and announces every document it created on the `created`
 * port (`lm/document-browser.created`), hint included; `folders` listens and files it —
 * under the hint, or wherever its "new notes go to" setting says. An event rather than a
 * service because `folders` uses this plugin's service, and the reverse would be a cycle.
 * No `folders`, or one that failed to activate: the document is still created, at the
 * root. No plugin's opinion about folders may stop the app's most common action.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";
import type { Commands } from "@protocols/lm/commands";
import type { Command } from "@protocols/lm/commands.command";
import type { ContextMenu } from "@protocols/lm/context-menu";
import type { DocumentBrowser } from "@protocols/lm/document-browser";
import type { Icons } from "@protocols/lm/icons";
import type { KeybindingDefault } from "@protocols/lm/keybindings.default";
import type { MainView } from "@protocols/lm/main.view";
import type { Router } from "@protocols/lm/router";
import type { Route } from "@protocols/lm/router.route";
import type { SidebarPanel } from "@protocols/lm/sidebar.panel";

import type { ConditionIndex } from "../../_shared/conditions-index.js";

import { DocListView, TrashView } from "./DocListView.js";
import { documentPath, listPath, queryParam } from "./search/hash.js";
import { searchEngine } from "./search/providers.js";
import { ViewsPanel } from "./ViewsPanel.js";
import { yamlScalar } from "./yaml.js";

/**
 * What this plugin serves on its `browser` port: `lm/document-browser`, the protocol
 * package in `protocols/document-browser/`. `createDocument` rejects when the server
 * cannot be reached (creation is REST, SPEC §5.1); a caller with nowhere to show that
 * uses `newDocument`, which never rejects and reports a failure as a notice with a
 * retry action.
 */
export type DocListApi = DocumentBrowser;

export default function activate(kernel: Kernel): DocListApi {
  // Each handle is limited to the port's `needs` in the manifest: exactly what is read here.
  const router = kernel.ports.use<Pick<Router, "navigate" | "current" | "onChange">>("router");
  const menu = kernel.ports.use<Pick<ContextMenu, "open" | "confirm">>("menu");
  const registry = (): Pick<Commands, "list" | "run"> | undefined =>
    kernel.ports.bound("registry") ? kernel.ports.use<Pick<Commands, "list" | "run">>("registry") : undefined;
  const icons = (): Pick<Icons, "Icon"> | undefined =>
    kernel.ports.bound("icons") ? kernel.ports.use<Pick<Icons, "Icon">>("icons") : undefined;
  // Suggestions for the filter's properties and values; the filter works without them.
  const index = (): ConditionIndex | undefined =>
    kernel.ports.bound("index") ? kernel.ports.use<ConditionIndex>("index") : undefined;

  /** Ids the list last rendered, for `visible()`. */
  let visible: readonly string[] = [];

  const open = (id: string, line?: number): void => router.navigate(documentPath(id, line));

  const search = searchEngine(kernel);

  /**
   * "Search documents" asks for the field before the list may be on screen, so the
   * request waits here and the field takes it when it mounts; a list already open is
   * focused at once.
   */
  let focusWanted = false;
  let focusSearch: (() => void) | undefined;
  const openSearch = (): void => {
    const onList = router.current().split("?")[0] === "/";
    if (!onList) router.navigate("/");
    if (focusSearch) focusSearch();
    else focusWanted = true;
  };

  /**
   * Creating a document is offered from four places — `Mod+N`, the navbar, the palette
   * and the folder tree — and **it can fail**: offline it succeeds on the device, but
   * the server can still refuse it (too large, say). Throwing the promise away (`void api.createDocument()`) meant the
   * palette closed, no document opened, and the only trace was an unhandled rejection in
   * the console. Every entry point goes through this instead, so a failure is a notice
   * with a retry, the way the delete and restore paths already surface theirs.
   */
  const create = (options?: { readonly parent?: string; readonly title?: string }): void => {
    void api.createDocument(options).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      kernel.log.error("could not create a document", cause);
      kernel.ui.notify({
        id: "doc-list.create-failed",
        level: "error",
        message: `Could not create the document: ${message}`,
        actions: [{ label: "Try again", run: () => create(options) }],
      });
    });
  };

  /** The Actions menu: every command that takes documents, run with the results' ids. */
  const openActions = (ids: readonly string[], anchor: HTMLElement): void => {
    const commands = registry();
    const Icon = icons()?.Icon;
    const available = (commands?.list() ?? []).filter((command) => command.takes === "documents");
    menu.open({
      title: `${ids.length.toLocaleString()} document${ids.length === 1 ? "" : "s"}`,
      anchor,
      sections: [
        {
          items:
            available.length === 0
              ? [{ id: "none", label: "No actions available", disabled: true, run: () => undefined }]
              : available.map((command) => ({
                  id: command.id,
                  label: command.title,
                  ...(Icon && command.icon !== undefined ? { icon: <Icon name={command.icon} /> } : {}),
                  run: () => {
                    void commands?.run(command.id, ids).catch((cause: unknown) => {
                      kernel.log.error(`command "${command.id}" failed`, cause);
                      kernel.ui.notify({
                        id: "doc-list.action-failed",
                        level: "error",
                        message: `${command.title} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                      });
                    });
                  },
                })),
        },
      ],
    });
  };

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
    const [query, setQuery] = useState(() => queryParam(location.hash, "q"));
    const input = useRef<HTMLInputElement>(null);

    // The URL is the state: back, forward and links move the search box.
    useEffect(() => {
      // The old results page's address, spelled the list's way — on arrival, and on a
      // hash change while the list is already on screen (same view, no remount).
      const canonical = (): void => {
        if (router.current().split("?")[0] === "/search") {
          router.navigate(listPath(queryParam(location.hash, "q")), { replace: true });
        }
      };
      canonical();
      return router.onChange(() => {
        canonical();
        // Compared trimmed: the URL holds the trimmed text, and echoing it back would
        // eat the space typed between two words.
        const next = queryParam(location.hash, "q");
        setQuery((current) => (current.trim() === next.trim() ? current : next));
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

    return (
      <DocListView
        documents={kernel.documents}
        index={index()}
        menu={menu}
        onOpen={open}
        onCreate={() => create()}
        onDelete={(id) => kernel.documents.delete(id)}
        onRendered={(ids) => {
          visible = ids;
        }}
        search={search}
        query={query}
        onQueryChange={(next) => {
          setQuery(next);
          // Replaced, not pushed: one history entry per search, not one per keystroke.
          router.navigate(listPath(next), { replace: true });
        }}
        searchInput={input}
        {...(registry() ? { onActions: openActions } : {})}
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

  // `/` is the catch-all. The router ranks routes by specificity and breaks ties by seat
  // order (PLUGIN-PROTOCOLS §6a); `order` here is only the protocol's default-seat hint.
  kernel.ports.offer<Route>("route", [
    { path: "/", view: "doc-list.all", order: 900 },
    { path: "/search", view: "doc-list.all" },
    { path: "/trash", view: "doc-list.trash" },
  ]);

  kernel.ports.offer<MainView>("views", [
    { id: "doc-list.all", title: "Documents", component: ListHost },
    { id: "doc-list.trash", title: "Trash", component: TrashHost },
  ]);

  kernel.ports.offer<SidebarPanel>("list", {
    id: "doc-list.views",
    title: "Views",
    order: 10,
    defaultOpen: true,
    component: PanelHost,
  });

  kernel.ports.offer<Command>("commands", [
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
  kernel.ports.offer<KeybindingDefault>("keys", [
    { command: "doc-list.new", keys: "Mod+N" },
    // Literal Ctrl, not Mod: Cmd+Space is the Mac's own search.
    { command: "doc-list.search", keys: "Ctrl+Space" },
  ]);

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  const api: DocListApi = {
    createDocument: async (options) => {
      // A new document is just text. The frontmatter block is written here rather than
      // spliced afterwards: at creation there is no concurrent writer to merge with, and
      // this is the one moment when authoring the whole text is correct (SPEC §3.3).
      const title = options?.title ?? "Untitled";
      const text = ["---", `title: ${yamlScalar(title)}`, "---", "", `# ${title}`, ""].join("\n");
      const id = await kernel.documents.create({ text });
      // Filing is whoever listens: `folders` puts it under `parent`, or its default.
      kernel.ports.emit("created", options?.parent !== undefined ? { id, parent: options.parent } : { id });
      router.navigate(`/doc/${id}`);
      return id;
    },
    newDocument: (options) => create(options),
    visible: () => visible,
  };

  kernel.ports.serve("browser", api);
  return api;
}
