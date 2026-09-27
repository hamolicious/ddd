/**
 * `graph` — every note and the links between them, as a live force-directed graph.
 *
 * - `model.ts` — nodes and links, from `indexer`'s documents and outgoing connections.
 * - `simulation.ts` — the physics: repel, springs, a pull to the middle.
 * - `renderer.ts` — the canvas: drawing, zoom and pan, drag, hover, click to open.
 * - `GraphView.tsx` / `Controls.tsx` — the view and its settings panel.
 * - `settings.ts` — filters, display and forces, stored per user.
 *
 * Two places to see it: the whole workspace at `#/graph` (the header's button, the
 * palette, `Mod+G`), and the open note's neighbourhood as a panel in the altbar, whose
 * expand button opens the full graph zoomed in to that note (`#/graph?focus=<id>`). Both
 * follow the index, so a link typed into a note appears in the graph as it is typed.
 */

import type { Kernel } from "@kernel";

import type { IndexerApi } from "../../_shared/indexer-api.js";
import {
  POINTS,
  type AltbarPanel,
  type Command,
  type KeybindingDefault,
  type MainView,
  type NavbarItem,
  type Route,
  type ShownView,
} from "../../_shared/points.js";
import type { ShellUiApi } from "../../_shared/shell-api.js";

import { GraphView } from "./GraphView.js";
import { createSettingsStore, settingsSchema } from "./settings.js";

interface RouterService {
  navigate(path: string): void;
  /** The current path's query string, parsed. */
  query(): URLSearchParams;
}

const VIEW = "graph.main";
/** `document-surface`'s view: `#/doc/<id>`. */
const DOCUMENT_VIEW = "document.surface";

const ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="4" cy="4" r="2" />
    <circle cx="12" cy="6" r="2" />
    <circle cx="6" cy="12" r="2" />
    <path d="M5.8 4.4 10.1 5.5M4.6 5.9l.9 4.2M7.6 10.9l3-3.4" />
  </svg>
);

export default function activate(kernel: Kernel): void {
  const indexer = kernel.services.require<IndexerApi>("indexer");
  const router = kernel.services.require<RouterService>("router");
  const shell = kernel.services.require<ShellUiApi>("shell-ui");

  kernel.settings.defineSchema(settingsSchema());
  const store = createSettingsStore(kernel);

  const openGraph = (): void => router.navigate("/graph");
  const open = (id: string, newTab: boolean): void => {
    const path = `/doc/${encodeURIComponent(id)}`;
    if (newTab) globalThis.open(`${location.pathname}${location.search}#${path}`, "_blank", "noopener");
    else router.navigate(path);
  };

  kernel.extensions.contribute<Route>(POINTS.route, { path: "/graph", view: VIEW });
  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: VIEW,
    title: "Graph",
    // `?focus=<id>`: opened from a note's local graph, it zooms in to that note.
    component: () => (
      <GraphView indexer={indexer} store={store} open={open} focus={router.query().get("focus") ?? undefined} />
    ),
  });

  kernel.extensions.contribute<AltbarPanel>(POINTS.altbarPanel, {
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
          openGlobal={() => router.navigate(`/graph?focus=${encodeURIComponent(view.params["id"] ?? "")}`)}
        />
      </div>
    ),
  });

  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "graph.open",
    label: "Graph",
    icon: ICON,
    side: "end",
    order: 80,
    onSelect: openGraph,
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "graph.open",
    title: "Open graph view",
    category: "Graph",
    run: openGraph,
  });
  kernel.extensions.contribute<KeybindingDefault>(POINTS.keybinding, { command: "graph.open", keys: "Mod+G" });
  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "graph.local",
    title: "Show this note's local graph",
    category: "Graph",
    when: () => shell.layout().hasAltbar,
    run: () => shell.toggleAltbar(true),
  });
}
