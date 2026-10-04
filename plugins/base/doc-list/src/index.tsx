import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel, Unsubscribe } from "@kernel";
import { addCommand, addKeybinding } from "plugin:commands";
import { addAction, confirm, openFor } from "plugin:context-menu";
import { notifyCreated } from "plugin:doc-events";
import { addMode } from "plugin:document-surface";
import * as indexer from "plugin:indexer";
import { addRoute, current, navigate, onChange } from "plugin:router";
import { SavedSearch, SearchShell, encode, parse, save as saveSearch } from "plugin:search";
import type { SearchSpec } from "plugin:search";
import { addSidebarPanel, addView } from "plugin:shell-ui";

import { offerSavedView } from "../../_shared/saved-view-mode.js";
import { yamlScalar } from "../../_shared/yaml.js";

import { BasicSearch } from "./BasicSearch.js";
import { ADVANCED_PARAM, basicPath, isAdvanced } from "./mode.js";
import { TrashView } from "./DocListView.js";
import { createNoteList, type Looks } from "./NoteList.js";
import { ViewsPanel } from "./ViewsPanel.js";

function queryOf(hash: string): string {
  const path = hash.replace(/^#/, "");
  const index = path.indexOf("?");
  return index === -1 ? "" : path.slice(index + 1);
}

function documentPath(id: string, line?: number): string {
  const path = `/doc/${encodeURIComponent(id)}`;
  return line !== undefined && Number.isSafeInteger(line) && line >= 1 ? `${path}?line=${String(line)}` : path;
}

export interface NewDocumentOptions {
  readonly parent?: string;
  readonly title?: string;
}

export interface DocumentBrowser {
  readonly createDocument: (options?: NewDocumentOptions) => Promise<string>;
  readonly newDocument: (options?: NewDocumentOptions) => void;
  readonly visible: () => readonly string[];
}

export type DocListApi = DocumentBrowser;

export type { NoteListProps } from "./NoteList.js";

export const LIST_TYPE = "list";

const router = { navigate, current, onChange };
const menu = { confirm };
const search = { parse, encode };

let noteLooks: Looks | undefined;
const looksListeners = new Set<() => void>();

export function setNoteLooks(looks: Looks): Unsubscribe {
  noteLooks = looks;
  for (const listener of [...looksListeners]) listener();
  return () => {
    if (noteLooks !== looks) return;
    noteLooks = undefined;
    for (const listener of [...looksListeners]) listener();
  };
}

function useLooks(): Looks | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const again = (): void => bump((count) => count + 1);
    looksListeners.add(again);
    return () => {
      looksListeners.delete(again);
    };
  }, []);
  return noteLooks;
}

export const NoteList = createNoteList({
  useLooks,
  folders: { documents: () => indexer.documents(), subscribe: indexer.subscribe, version: () => indexer.version },
  openMenu: (element) => {
    openFor(element);
  },
});

let kernelRef: Kernel | undefined;

const active = (): Kernel => {
  if (!kernelRef) throw new Error("doc-list is not active yet: call it from your plugin's activate() or later");
  return kernelRef;
};

let visibleIds: readonly string[] = [];

const reportVisible = (ids: readonly string[]): void => {
  visibleIds = ids;
};

let focusWanted = false;
let focusSearch: (() => void) | undefined;

export async function createDocument(options?: NewDocumentOptions): Promise<string> {
  const kernel = active();
  const title = options?.title ?? "Untitled";
  const text = ["---", `title: ${yamlScalar(title)}`, "---", ""].join("\n");
  const id = await kernel.documents.create({ text });
  notifyCreated(options?.parent !== undefined ? { id, parent: options.parent } : { id });
  router.navigate(`/doc/${id}`);
  return id;
}

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

export function visible(): readonly string[] {
  return visibleIds;
}

export default function activate(kernel: Kernel): void {
  kernelRef = kernel;
  const pathFor = (spec: SearchSpec): string => {
    const params = new URLSearchParams(search.encode(spec));
    params.set(ADVANCED_PARAM, "1");
    return `/?${params.toString()}`;
  };

  const open = (id: string, line?: number): void => router.navigate(documentPath(id, line));

  const openSearch = (): void => {
    const onList = router.current().split("?")[0] === "/";
    if (!onList) router.navigate("/");
    if (focusSearch) focusSearch();
    else focusWanted = true;
  };

  const create = newDocument;

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

  const ListHost = (): ReactElement => {
    const [spec, setSpec] = useState<SearchSpec>(() => search.parse(queryOf(location.hash)));
    const [advanced, setAdvanced] = useState(() => isAdvanced(queryOf(location.hash)));
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
      const canonical = (): void => {
        if (router.current().split("?")[0] === "/search") {
          const query = queryOf(location.hash);
          const parsed = search.parse(query);
          router.navigate(isAdvanced(query) ? pathFor(parsed) : basicPath(parsed.query), { replace: true });
        }
      };
      canonical();
      return router.onChange(() => {
        canonical();
        const query = queryOf(location.hash);
        const next = search.parse(query);
        setSpec((current) => (search.encode(current) === search.encode(next) ? current : next));
        setAdvanced(isAdvanced(query));
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

    if (!advanced) {
      return (
        <BasicSearch
          query={spec.query}
          onQueryChange={(query) => {
            setSpec({ ...search.parse(""), query });
            router.navigate(basicPath(query), { replace: true });
          }}
          onAdvanced={() => {
            setAdvanced(true);
            router.navigate(pathFor(spec), { replace: true });
          }}
          onOpen={open}
          onRendered={reportVisible}
          searchInput={input}
          search={kernel.search}
          NoteList={NoteList}
        />
      );
    }

    return (
      <SearchShell
        spec={spec}
        onSpecChange={(next) => {
          setSpec(next);
          router.navigate(pathFor(next), { replace: true });
        }}
        heading="Documents"
        onOpen={open}
        searchInput={input}
        onRendered={reportVisible}
        renderView={(props) => <NoteList results={props.results} onOpen={props.onOpen} searchInput={input} />}
        headerActions={
          <button
            type="button"
            className="doclist-basic-toggle"
            onClick={() => {
              const query = spec.query;
              setAdvanced(false);
              setSpec({ ...search.parse(""), query });
              router.navigate(basicPath(query), { replace: true });
            }}
          >
            Basic search
          </button>
        }
        {...(search.encode(spec) !== ""
          ? {
              onSave: () => {
                void saveSearch(spec, { type: LIST_TYPE }).catch((cause: unknown) => {
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
      search={kernel.search}
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
        search={kernel.search}
        current={path.split("?")[0] ?? "/"}
        onNavigate={(next) => router.navigate(next)}
      />
    );
  };

  offerSavedView(
    kernel,
    {
      type: LIST_TYPE,
      label: "List",
      noun: "list",
      commandId: "doc-list.newList",
      commandIcon: "list",
      icon: (
        <svg aria-hidden="true" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
        </svg>
      ),
      order: 15,
      render: (props) => <NoteList results={props.results} onOpen={props.onOpen} />,
    },
    {
      addMode,
      addCommand: (command) =>
        addCommand({
          ...command,
          run: async () => {
            await command.run();
          },
        }),
      addAction,
      notifyCreated,
      search: () => ({ SavedSearch, encode }),
      navigate: (path) => router.navigate(path),
    },
  );

  addRoute([
    { path: "/", view: "doc-list.all", order: 900 },
    { path: "/search", view: "doc-list.all" },
    { path: "/trash", view: "doc-list.trash" },
  ]);

  addView([
    { id: "doc-list.all", title: "Documents", component: ListHost },
    { id: "doc-list.trash", title: "Trash", component: TrashHost },
  ]);

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
    { command: "doc-list.search", keys: "Ctrl+Space" },
  ]);
}

export function deactivate(): void {
  kernelRef = undefined;
  focusSearch = undefined;
  focusWanted = false;
}
