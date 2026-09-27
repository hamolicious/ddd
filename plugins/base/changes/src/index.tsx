/**
 * `changes` — the open document's history, in the altbar (SPEC §3.5).
 *
 * Two kinds of entry in one timeline, newest first:
 *
 * - **Changes**: every write that changed the text, recorded by the server as hunks
 *   (`backend/…/changes.rs`) and grouped by author and pause. View shows what a group
 *   did as a diff; Revert undoes it as a new change, keeping everything after it, and is
 *   refused, with the reason, when a later change touched the same text.
 * - **Snapshots**: whole texts kept forever: taken by hand, or automatically before a restore.
 *   View shows one read only; Restore puts it back, snapshotting the current text first.
 *
 * Any signed-in user may do all of it, as with editing: history is part of the document,
 * not an administrator's tool.
 *
 * - `Panel.tsx` — the timeline and its actions.
 * - `ChangeView.tsx` — one change group, `#/doc/<id>/change/<from>/<to>`.
 * - `View.tsx` — one snapshot, `#/doc/<id>/snapshot/<snapshot>`.
 * - `Banner.tsx` — the "read only, this is the past" strip both pages share.
 * - `api.ts` — the REST calls, and how their fields read to a person.
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
import { ChangeView } from "./ChangeView.js";
import { ChangesPanel, type Viewing } from "./Panel.js";
import { SnapshotView, type MarkdownApi } from "./View.js";

/** `document-surface`'s view: `#/doc/<id>`. */
const DOCUMENT_VIEW = "document.surface";
/** This plugin's own views: one snapshot, one change group, read only. */
const SNAPSHOT_VIEW = "changes.snapshot";
const CHANGE_VIEW = "changes.change";

const isDocument = (view: ShownView): boolean =>
  (view.id === DOCUMENT_VIEW || view.id === SNAPSHOT_VIEW || view.id === CHANGE_VIEW) &&
  Boolean(view.params["id"]);

const viewingOf = (view: ShownView): Viewing | undefined => {
  if (view.id === SNAPSHOT_VIEW && view.params["snapshot"]) return { kind: "snapshot", id: view.params["snapshot"] };
  if (view.id === CHANGE_VIEW) {
    const from = Number(view.params["from"]);
    const to = Number(view.params["to"]);
    if (Number.isInteger(from) && Number.isInteger(to)) return { kind: "change", from, to };
  }
  return undefined;
};

interface RouterService {
  navigate(path: string): void;
}

export default function activate(kernel: Kernel): void {
  const menu = kernel.services.require<ContextMenuApi>("context-menu");
  const shell = kernel.services.require<ShellUiApi>("shell-ui");
  const markdown = kernel.services.require<MarkdownApi>("markdown");
  const router = kernel.services.require<RouterService>("router");
  const client = createSnapshotsClient((path, init) => kernel.session.fetch(path, init));

  kernel.extensions.contribute<AltbarPanel>(POINTS.altbarPanel, {
    id: "changes",
    title: "Changes",
    order: 100,
    when: isDocument,
    component: ({ view }) => (
      <ChangesPanel
        key={view.params["id"]}
        documentId={view.params["id"] ?? ""}
        viewing={viewingOf(view)}
        isAdmin={kernel.session.isAdmin()}
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

  kernel.extensions.contribute<Route>(POINTS.route, { path: "/doc/:id/change/:from/:to", view: CHANGE_VIEW });
  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: CHANGE_VIEW,
    title: "Change",
    component: ({ params }) => (
      <ChangeView
        key={`${params?.["id"]}/${params?.["from"]}/${params?.["to"]}`}
        documentId={params?.["id"] ?? ""}
        from={Number(params?.["from"])}
        to={Number(params?.["to"])}
        client={client}
        markdown={markdown}
        confirm={(request) => menu.confirm(request)}
        navigate={(path) => router.navigate(path)}
      />
    ),
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "changes.show",
    title: "Show this document's changes",
    category: "Document",
    when: () => shell.layout().hasAltbar,
    run: () => shell.toggleAltbar(true),
  });
}
