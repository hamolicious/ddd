/**
 * `snapshots` — the open document's snapshots, in the altbar (SPEC §3.5).
 *
 * The server takes them on its own (the first edit after a pause, and one a day) and
 * keeps the last 20 plus one a day for 30 days; this plugin lists them for the document
 * on screen, takes one by hand, and restores one. Restoring replaces the whole text,
 * frontmatter included, for everyone, and the server snapshots the current text first,
 * so a restore can itself be undone from the same list.
 *
 * Any signed-in user may do all three, as with editing: snapshots are part of the
 * document, not an administrator's tool.
 *
 * - `Panel.tsx` — the list, the take / refresh / view / restore actions.
 * - `View.tsx` — one snapshot, read only, at `#/doc/<id>/snapshot/<snapshot>`.
 * - `api.ts` — the four REST calls and the labels for a snapshot's reason.
 */

import type { Kernel } from "@kernel";

import type { ContextMenuApi } from "../../_shared/context-menu-api.js";
import {
  POINTS,
  type AltbarPanel,
  type Command,
  type MainView,
  type Route,
  type ShownView,
} from "../../_shared/points.js";
import type { ShellUiApi } from "../../_shared/shell-api.js";

import { createSnapshotsClient } from "./api.js";
import { SnapshotsPanel } from "./Panel.js";
import { SnapshotView, type MarkdownApi } from "./View.js";

/** `document-surface`'s view: `#/doc/<id>`. */
const DOCUMENT_VIEW = "document.surface";
/** This plugin's own view: one snapshot, read only. */
const SNAPSHOT_VIEW = "snapshots.view";

const isDocument = (view: ShownView): boolean =>
  (view.id === DOCUMENT_VIEW || view.id === SNAPSHOT_VIEW) && Boolean(view.params["id"]);

interface RouterService {
  navigate(path: string): void;
}

export default function activate(kernel: Kernel): void {
  const menu = kernel.services.require<ContextMenuApi>("context-menu");
  const shell = kernel.services.require<ShellUiApi>("shell-ui");
  const markdown = kernel.services.require<MarkdownApi>("markdown");
  const router = kernel.services.require<RouterService>("router");
  const client = createSnapshotsClient((path, init) => kernel.session.fetch(path, init));

  // The panel's title says what it is; the camera in the top bar would say nothing.
  kernel.extensions.contribute<AltbarPanel>(POINTS.altbarPanel, {
    id: "snapshots",
    title: "Snapshots",
    order: 100,
    when: isDocument,
    component: ({ view }) => (
      <SnapshotsPanel
        key={view.params["id"]}
        documentId={view.params["id"] ?? ""}
        viewing={view.id === SNAPSHOT_VIEW ? view.params["snapshot"] : undefined}
        client={client}
        confirm={(request) => menu.confirm(request)}
        navigate={(path) => router.navigate(path)}
      />
    ),
  });

  kernel.extensions.contribute<Route>(POINTS.route, { path: "/doc/:id/snapshot/:snapshot", view: SNAPSHOT_VIEW });
  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: SNAPSHOT_VIEW,
    title: "Snapshot",
    component: ({ params }) => (
      <SnapshotView
        documentId={params?.["id"] ?? ""}
        snapshotId={params?.["snapshot"] ?? ""}
        client={client}
        markdown={markdown}
        confirm={(request) => menu.confirm(request)}
        navigate={(path) => router.navigate(path)}
      />
    ),
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "snapshots.show",
    title: "Show this document's snapshots",
    category: "Document",
    when: () => shell.layout().hasAltbar,
    run: () => shell.toggleAltbar(true),
  });
}
