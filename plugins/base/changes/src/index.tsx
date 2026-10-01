/**
 * `changes` — the open document's history, in the altbar (SPEC §3.5).
 *
 * Two kinds of entry in one timeline, newest first:
 *
 * - **Changes**: every write that changed the text, recorded by the server as hunks
 *   (`backend/…/changes.rs`) and grouped by author and pause. View shows what a group
 *   did as a diff; Revert undoes it as a new change, keeping everything after it, and is
 *   refused, with the reason, when a later change touched the same text.
 * - **Snapshots**: whole texts kept forever, taken by the server before every restore (and
 *   by anything that posts one). View shows one read only; Restore puts it back,
 *   snapshotting the current text first.
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

import { offlineCopies } from "../../_shared/offline-copy.js";
import { changesOfflineCopy } from "./offline.js";
import type { Kernel } from "@kernel";

import { addCommand } from "plugin:commands";
import { confirm } from "plugin:context-menu";
import { bodyOf, render } from "plugin:markdown";
import { addRoute, navigate } from "plugin:router";
import { addAltbarPanel, addView, layout, toggleAltbar, type MainView, type ShownView } from "plugin:shell-ui";

import { createSnapshotsClient } from "./api.js";
import { ChangeView } from "./ChangeView.js";
import { ChangesPanel, type Viewing } from "./Panel.js";
import { SnapshotView } from "./View.js";

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

export default function activate(kernel: Kernel): void {
  const markdown = { render, bodyOf };
  // Offline, the panel and views show what they last loaded, marked (dev-docs/resolved/SYNC-DECISIONS.md §9).
  const client = createSnapshotsClient(offlineCopies((path, init) => kernel.session.fetch(path, init), changesOfflineCopy));

  addAltbarPanel({
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
        confirm={confirm}
        navigate={(path) => navigate(path)}
      />
    ),
  });

  addRoute([
    { path: "/doc/:id/snapshot/:snapshot", view: SNAPSHOT_VIEW },
    { path: "/doc/:id/change/:from/:to", view: CHANGE_VIEW },
  ]);

  const snapshotView: MainView = {
    id: SNAPSHOT_VIEW,
    title: "Snapshot",
    component: ({ params }) => (
      <SnapshotView
        documentId={params?.["id"] ?? ""}
        snapshotId={params?.["snapshot"] ?? ""}
        client={client}
        markdown={markdown}
        confirm={confirm}
        navigate={(path) => navigate(path)}
      />
    ),
  };
  const changeView: MainView = {
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
        confirm={confirm}
        navigate={(path) => navigate(path)}
      />
    ),
  };
  addView([snapshotView, changeView]);

  addCommand({
    id: "changes.show",
    title: "Show this document's changes",
    category: "Document",
    when: () => layout().hasAltbar,
    run: () => toggleAltbar(true),
  });
}
