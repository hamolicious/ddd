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

const DOCUMENT_VIEW = "document.surface";
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
        documents={kernel.documents}
        sync={kernel.sync}
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
