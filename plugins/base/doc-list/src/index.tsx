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

type TableOptions = Readonly<Record<string, string>>;

const TABLE_PARAM = "t.";

function tableOptionsOf(query: string): TableOptions {
  const options: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (key.startsWith(TABLE_PARAM) && key.length > TABLE_PARAM.length && value !== "") options[key.slice(TABLE_PARAM.length)] = value;
  }
  return options;
}

const router = { navigate, current, onChange };
const menu = { confirm };
const search = { parse, encode };
const table = { TablePage, save: saveTable };

let kernelRef: Kernel | undefined;

const active = (): Kernel => {
  if (!kernelRef) throw new Error("doc-list is not active yet: call it from your plugin's activate() or later");
  return kernelRef;
};

let visibleIds: readonly string[] = [];

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
    const [options, setOptions] = useState<TableOptions>(() => tableOptionsOf(queryOf(location.hash)));
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
      const canonical = (): void => {
        if (router.current().split("?")[0] === "/search") {
          const query = queryOf(location.hash);
          router.navigate(pathFor(search.parse(query), tableOptionsOf(query)), { replace: true });
        }
      };
      canonical();
      return router.onChange(() => {
        canonical();
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
