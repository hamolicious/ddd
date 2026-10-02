import type { Kernel } from "@kernel";

import { addCommand, addKeybinding } from "plugin:commands";
import { addItem } from "plugin:toolbar";
import * as indexer from "plugin:indexer";
import { addRoute, navigate, query } from "plugin:router";
import { addAltbarPanel, addView, layout, toggleAltbar, type ShownView } from "plugin:shell-ui";

import { GraphView } from "./GraphView.js";
import { createSettingsStore, settingsSchema, type SettingsStore } from "./settings.js";

const VIEW = "graph.main";
const DOCUMENT_VIEW = "document.surface";

const ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="4" cy="4" r="2" />
    <circle cx="12" cy="6" r="2" />
    <circle cx="6" cy="12" r="2" />
    <path d="M5.8 4.4 10.1 5.5M4.6 5.9l.9 4.2M7.6 10.9l3-3.4" />
  </svg>
);

let liveStore: SettingsStore | undefined;

export default function activate(kernel: Kernel): void {
  kernel.settings.defineSchema(settingsSchema());
  const store = createSettingsStore(kernel);
  liveStore = store;

  const openGraph = (): void => navigate("/graph");
  const open = (id: string, newTab: boolean): void => {
    const path = `/doc/${encodeURIComponent(id)}`;
    if (newTab) globalThis.open(`${location.pathname}${location.search}#${path}`, "_blank", "noopener");
    else navigate(path);
  };

  addRoute({ path: "/graph", view: VIEW });
  addView({
    id: VIEW,
    title: "Graph",
    component: () => (
      <GraphView indexer={indexer} store={store} open={open} focus={query().get("focus") ?? undefined} />
    ),
  });

  addAltbarPanel({
    id: "graph.local",
    title: "Graph",
    icon: ICON,
    order: 50,
    when: (view: ShownView) => view.id === DOCUMENT_VIEW && Boolean(view.params["id"]),
    component: ({ view }) => (
      <div className="graph:h-72">
        <GraphView
          indexer={indexer}
          store={store}
          open={open}
          center={view.params["id"]}
          openGlobal={() => navigate(`/graph?focus=${encodeURIComponent(view.params["id"] ?? "")}`)}
        />
      </div>
    ),
  });

  addItem({
    id: "graph.open",
    label: "Graph",
    icon: ICON,
    side: "end",
    order: 80,
    onSelect: openGraph,
  });

  addCommand([
    {
      id: "graph.open",
      title: "Open graph view",
      category: "Graph",
      run: openGraph,
    },
    {
      id: "graph.local",
      title: "Show this note's local graph",
      category: "Graph",
      when: () => layout().hasAltbar,
      run: () => toggleAltbar(true),
    },
  ]);
  addKeybinding({ command: "graph.open", keys: "Mod+G" });
}

export function deactivate(): void {
  liveStore?.flush();
  liveStore = undefined;
}
