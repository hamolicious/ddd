/**
 * `doc-list` — browse, sort, filter, create, and the **Trash view** (SPEC §6.5).
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
 * - **Sorting Trash by `deleted_at` is not available** — the shared filter DSL's field
 *   space does not reach that root, so the server refuses `sort=deleted_at` and the
 *   client cannot reproduce that order either. `backend/CONTRACTS.md` records it as a
 *   core change that lands with whoever builds this view; until then Trash is ordered in
 *   the client after the query, and `TrashView` says so on screen.
 *
 * **`createDocument` authors the whole text, once.** That is the one moment when writing
 * a frontmatter block wholesale is correct (SPEC §3.3): there is no concurrent writer to
 * merge with yet, and no existing block to destroy. Every *later* metadata write in this
 * plugin's neighbourhood goes through `kernel.documents.splice`.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";

import { DocListView, TrashView } from "./DocListView.js";
import { ViewsPanel } from "./ViewsPanel.js";
import { yamlScalar } from "./yaml.js";
import {
  POINTS,
  type Command,
  type KeybindingDefault,
  type MainView,
  type NavbarItem,
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

  /** Ids the list last rendered, for `visible()`. */
  let visible: readonly string[] = [];

  const open = (id: string): void => router.navigate(`/doc/${id}`);

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
        message: "The document could not be created.",
        detail:
          `${message}\n\n` +
          "Creating a document needs the server: it mints the id and records the document " +
          "before it can be edited. Existing documents stay readable offline, and recently " +
          "opened ones stay editable.",
        actions: [{ label: "Try again", run: () => create(options) }],
      });
    });
  };

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  const ListHost = (): ReactElement => (
    <DocListView
      documents={kernel.documents}
      onOpen={open}
      onCreate={() => create()}
      onDelete={(id) => kernel.documents.delete(id)}
      onRendered={(ids) => {
        visible = ids;
      }}
    />
  );

  const TrashHost = (): ReactElement => (
    <TrashView
      documents={kernel.documents}
      onOpen={open}
      onRestore={(id) => kernel.documents.restore(id)}
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

  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "doc-list.new",
    label: "New document",
    side: "start",
    order: 10,
    onSelect: () => create(),
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

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  const api: DocListApi = {
    createDocument: async (options) => {
      // A new document is just text. The frontmatter block is written here rather than
      // spliced afterwards: at creation there is no concurrent writer to merge with, and
      // this is the one moment when authoring the whole text is correct (SPEC §3.3).
      const title = options?.title ?? "Untitled";
      const front = ["---", `title: ${yamlScalar(title)}`];
      if (options?.path) front.push(`path: ${yamlScalar(options.path)}`);
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
