/**
 * `doc-list` — browse, search, sort, filter, create, and the **Trash view** (SPEC §6.5).
 *
 * **Search lives here** (it was its own plugin with its own results page). The list
 * page's search bar runs every `search.provider` — this plugin defines the point and
 * contributes the local index and the server's — and the list becomes the ranked
 * results (`search/`, `DocListView`). The text is the URL's `?q=`, so a search survives
 * reload and "back" from a result, and the old `#/search?q=` address opens the same
 * list. "Search documents" (Ctrl+Space by default) opens the list and focuses the bar.
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
 * INTEGRATION (folders): **where an unfiled new document lands arrives as an event.**
 * `folders` owns the "new notes go here" setting and emits `folders:default-location`
 * with `{ path }` at its own activation and on every change; `createDocument` uses the
 * last value it heard whenever the caller named no `path` of its own. That direction is
 * forced: `folders` *depends on* `doc-list`, so `kernel.services.get("folders")` from
 * here is a `ContractViolationError` by design (SPEC §6.4) and declaring the dependency
 * back would be a cycle the loader cannot order. The event bus needs no dependency in
 * either direction.
 *
 * Two properties this rests on, both stated because `kernel.events` gives neither for
 * free (it is fire-and-forget with no replay, SPEC §6.3):
 *
 * - **The listener is registered in `activate`**, before any plugin that depends on this
 *   one can have activated. `folders`' announcement therefore cannot precede it.
 * - **Root is the floor.** No `folders`, a `folders` that failed to activate, an empty
 *   setting, or a payload that is not a string: the document is created at the root and
 *   is still created. No plugin's opinion about folders may stop the app's most common
 *   action.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";

import { DocListView, TrashView } from "./DocListView.js";
import { documentPath, listPath, queryParam } from "./search/hash.js";
import { searchEngine } from "./search/providers.js";
import { ViewsPanel } from "./ViewsPanel.js";
import { yamlScalar } from "./yaml.js";
import type { ContextMenuApi } from "../../_shared/context-menu-api.js";
import {
  POINTS,
  type Command,
  type KeybindingDefault,
  type MainView,
  type Route,
  type SidebarPanel,
} from "../../_shared/points.js";

export interface DocListApi {
  /**
   * Create an empty document and navigate to it. `path` seeds `fm.path`.
   *
   * Rejects when the server cannot be reached (creation is REST, SPEC §5.1). A caller
   * that has nowhere to show that should use {@link DocListApi.newDocument} instead.
   */
  createDocument(options?: { readonly path?: string; readonly title?: string }): Promise<string>;
  /**
   * The same thing, for UI entry points: never rejects, and reports a failure as a
   * notice with a retry action.
   */
  newDocument(options?: { readonly path?: string; readonly title?: string }): void;
  /** The id list currently shown, for "select all" style commands. */
  visible(): readonly string[];
}

interface RouterService {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  onChange(listener: (path: string) => void): () => void;
  current(): string;
}

export default function activate(kernel: Kernel): DocListApi {
  const router = kernel.services.require<RouterService>("router");
  const menu = kernel.services.require<ContextMenuApi>("context-menu");

  /**
   * Where an unfiled new document goes — the folder `folders` keeps as a per-user
   * setting, or the workspace root, which is the value until something says otherwise.
   *
   * See this file's header for why it arrives as an event rather than as a service
   * call. The listener is registered **here, in `activate`**, and that is the whole of
   * the ordering contract: `folders` depends on this plugin, so its `activate` — and
   * the announcement at the end of it — cannot run until this line has.
   *
   * Treated as untrusted input, because an event payload is: anything that is not a
   * non-empty string leaves the value at the root rather than putting `undefined` or a
   * number into a `path:` line.
   */
  let defaultLocation = "";
  kernel.events.on<{ readonly path?: unknown }>("folders:default-location", (event) => {
    const path = event.payload?.path;
    defaultLocation = typeof path === "string" ? path.trim() : "";
  });

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
   * and the folder tree — and **it can fail**: `documents.create` is REST (SPEC §5.1), so
   * offline it rejects. Throwing the promise away (`void api.createDocument()`) meant the
   * palette closed, no document opened, and the only trace was an unhandled rejection in
   * the console. Every entry point goes through this instead, so a failure is a notice
   * with a retry, the way the delete and restore paths already surface theirs.
   */
  const create = (options?: { readonly path?: string; readonly title?: string }): void => {
    void api.createDocument(options).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      kernel.log.error("could not create a document", cause);
      kernel.ui.notify({
        id: "doc-list.create-failed",
        level: "error",
        message: "Could not create the document — the server is unreachable.",
        detail: `${message}\n\nExisting documents still work offline.`,
        actions: [{ label: "Try again", run: () => create(options) }],
      });
    });
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

  kernel.extensions.contribute<Route>(POINTS.route, { path: "/", view: "doc-list.all", order: 900 });
  kernel.extensions.contribute<Route>(POINTS.route, { path: "/search", view: "doc-list.all" });
  kernel.extensions.contribute<Route>(POINTS.route, { path: "/trash", view: "doc-list.trash" });

  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "doc-list.all",
    title: "Documents",
    component: ListHost,
  });
  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "doc-list.trash",
    title: "Trash",
    component: TrashHost,
  });

  kernel.extensions.contribute<SidebarPanel>(POINTS.sidebarPanel, {
    id: "doc-list.views",
    title: "Views",
    order: 10,
    defaultOpen: true,
    component: PanelHost,
  });

  for (const command of [
    {
      id: "doc-list.new",
      title: "New document",
      category: "Documents",
      run: () => create(),
    },
    {
      id: "doc-list.all",
      title: "Show all documents",
      category: "Documents",
      run: () => router.navigate("/"),
    },
    {
      id: "doc-list.search",
      title: "Search documents",
      category: "Documents",
      run: openSearch,
    },
    {
      id: "doc-list.openTrash",
      title: "Open Trash",
      category: "Documents",
      run: () => router.navigate("/trash"),
    },
  ] satisfies Command[]) {
    kernel.extensions.contribute<Command>(POINTS.command, command);
  }
  kernel.extensions.contribute<KeybindingDefault>(POINTS.keybinding, {
    command: "doc-list.new",
    keys: "Mod+N",
  });
  // Literal Ctrl, not Mod: Cmd+Space is the Mac's own search.
  kernel.extensions.contribute<KeybindingDefault>(POINTS.keybinding, {
    command: "doc-list.search",
    keys: "Ctrl+Space",
  });

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  const api: DocListApi = {
    createDocument: async (options) => {
      // A new document is just text. The frontmatter block is written here rather than
      // spliced afterwards: at creation there is no concurrent writer to merge with, and
      // this is the one moment when authoring the whole text is correct (SPEC §3.3).
      const title = options?.title ?? "Untitled";
      // An explicit path always wins: a folder's "+" button knows where it is, and no
      // default may overrule a caller that said so. Only an *unfiled* document asks
      // where unfiled documents go, and the answer is the root until told otherwise.
      const path = options?.path ?? defaultLocation;
      const front = ["---", `title: ${yamlScalar(title)}`];
      if (path) front.push(`path: ${yamlScalar(path)}`);
      front.push("---", "", `# ${title}`, "");
      const id = await kernel.documents.create({ text: front.join("\n") });
      router.navigate(`/doc/${id}`);
      return id;
    },
    newDocument: (options) => create(options),
    visible: () => visible,
  };

  return api;
}
