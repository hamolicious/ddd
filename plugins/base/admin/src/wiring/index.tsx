/**
 * The wiring editor (PLUGIN-PROTOCOLS §7): every plugin's ports and the wires between
 * them, drafts, Apply, history and rollback. It is the admin plugin's Wiring tab,
 * `#/admin/wiring`; `../index.tsx` offers what this builds.
 *
 * - `model.ts` — nodes, ports and wires from the plugin list and a resolution.
 * - `draft.ts` — the edits: connect, cut, seats, plug, and rebasing onto a newer live.
 * - `layout.ts` — columns by dependants, port rows, seats, wire curves. No DOM.
 * - `changes.ts` — the change list and apply plan as rows.
 * - `store.ts` — the state: live, draft, resolutions, plan, selection, storage.
 * - `Graph.tsx`, `Inspector.tsx`, `WiringView.tsx` — the screen.
 *
 * Everything goes through the admin-only wiring routes; the server authorizes, and the
 * tab is hidden from nobody (a non-admin sees "not an administrator").
 *
 * Previews run locally through the Wasm core; without it, and offline, the editor is
 * read-only. A draft lives in this browser, and in `localStorage` so a reload keeps it.
 */

import { useEffect, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";
import type { AltbarPanel } from "@protocols/lm/altbar.panel";
import type { Command } from "@protocols/lm/commands.command";
import type { ContextMenu } from "@protocols/lm/context-menu";
import type { Router } from "@protocols/lm/router";
import type { Shell } from "@protocols/lm/shell";

import { OfflineCopyState, offlineCopies } from "../../../_shared/offline-copy.js";
import type { SharedWiring } from "../hooks.js";

import { createWiringClient } from "./api.js";
import type { ChangeSummary } from "./changes.js";
import { Inspector } from "./Inspector.js";
import { EditorStore, type Selection } from "./store.js";
import { WiringView } from "./WiringView.js";

/** The admin section the editor is, and its path. */
export const WIRING_SECTION = "wiring";
export const WIRING_PATH = `/admin/${WIRING_SECTION}`;

const ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="1.5" y="2.5" width="5" height="4" rx="1" />
    <rect x="9.5" y="9.5" width="5" height="4" rx="1" />
    <path d="M6.5 4.5h2a2 2 0 0 1 2 2v3M1.5 11.5h3" />
    <circle cx="6" cy="11.5" r="1.2" />
  </svg>
);

export interface WiringEditorOptions {
  readonly kernel: Kernel;
  readonly router: Pick<Router, "navigate" | "current">;
  readonly shell: Pick<Shell, "layout" | "subscribeLayout" | "toggleAltbar">;
  readonly menu: Pick<ContextMenu, "confirm" | "openSheet" | "close">;
  /** The `main.view` id the section renders in, for the panel's `when`. */
  readonly viewId: string;
}

/** What admin offers for the editor, and how to take it down. */
export interface WiringEditor {
  /** The section's body: the toolbar, the graph and the draft bar. */
  readonly Section: () => ReactElement;
  /** The inspector, in the altbar while the Wiring tab is showing. */
  readonly panel: AltbarPanel;
  readonly commands: readonly Command[];
  /** The one store, and the actions with their confirms, for the plugin list's Connections. */
  readonly shared: SharedWiring;
  /** Everything the editor built itself; the kernel withdraws the offers. */
  dispose(): void;
}

export function createWiringEditor({ kernel, router, shell, menu, viewId }: WiringEditorOptions): WiringEditor {
  const admin = kernel.session.isAdmin();

  const copies = new OfflineCopyState();
  const client = createWiringClient(offlineCopies((path, init) => kernel.session.fetch(path, init), copies));
  const store = new EditorStore({
    client,
    core: kernel.core,
    editorId: kernel.pluginId,
    storageKey: `lm:wiring:draft:${location.host}${location.pathname}`,
    log: (message, ...rest) => kernel.log.warn(message, ...rest),
  });

  // Offline is read-only; a return of the socket, and a window coming back into focus,
  // are the cues to check whether live moved.
  let lastStatus: string | undefined;
  const unsubscribeSync = kernel.sync.subscribe((state) => {
    store.setOffline(state.status === "offline");
    if (state.status === "synced" && lastStatus !== undefined && lastStatus !== "synced") store.reloadSoon();
    lastStatus = state.status;
  });
  const onFocus = (): void => {
    if (store.state.phase === "ready") store.reloadSoon();
  };
  window.addEventListener("focus", onFocus);

  // ---- the actions the views share ----

  let sheetOpen = false;
  const isCompact = (): boolean => shell.layout().compact;
  const onWiringTab = (): boolean => router.current().split("?")[0] === WIRING_PATH;

  const openSheet = (): void => {
    if (sheetOpen) return;
    sheetOpen = true;
    menu.openSheet({
      title: "Inspector",
      onClose: () => {
        sheetOpen = false;
      },
      render: () => <Inspector store={store} onSelect={select} onConnect={connect} onApply={apply} compact />,
    });
  };

  const select = (selection: Selection): void => {
    store.select(selection);
    if (!selection) return;
    if (isCompact()) openSheet();
    else shell.toggleAltbar(true);
  };

  const connect = (from: string, to: string): void => {
    void store.connect(from, to, (offerProtocol, needProtocol) =>
      menu.confirm({
        title: "Wire by shape?",
        description: (
          <span className="admin:font-mono admin:text-xs">
            {offerProtocol} → {needProtocol}
          </span>
        ),
        confirmLabel: "Wire it",
      }),
    );
  };

  const apply = (): void => {
    void store.apply((summary: ChangeSummary, version: number) =>
      menu.confirm({
        title: summary.stopsEditor ? "This draft stops the wiring editor" : `This draft adds ${summary.addedErrors} error${summary.addedErrors === 1 ? "" : "s"}`,
        description: (
          <span className="admin:text-xs">
            {summary.stopsEditor && summary.addedErrors > 0 ? `+${summary.addedErrors} errors · ` : ""}
            Way back: <code>#/admin/plugins</code> · <code>?safe=bare</code>
          </span>
        ),
        confirmLabel: `Apply v${version + 1}`,
        danger: true,
      }),
    );
  };

  // ---- what admin offers for it ----

  const Section = (): ReactElement => {
    const layout = useSyncExternalStore(shell.subscribeLayout, shell.layout, shell.layout);
    useEffect(() => {
      void store.load();
    }, []);
    return (
      <WiringView store={store} isAdmin={admin} compact={layout.compact} onSelect={select} onConnect={connect} onApply={apply} onInspect={openSheet} />
    );
  };

  const panel: AltbarPanel = {
    id: "admin.wiring.inspector",
    title: "Inspector",
    icon: ICON,
    order: 60,
    when: (view) => view.id === viewId && view.params["section"] === WIRING_SECTION,
    component: () => <Inspector store={store} onSelect={select} onConnect={connect} onApply={apply} />,
  };

  const commands: readonly Command[] = [
    { id: "admin.wiring.open", title: "Open the wiring editor", category: "Wiring", run: () => router.navigate(WIRING_PATH) },
    {
      id: "admin.wiring.inspect",
      title: "Show the wiring inspector",
      category: "Wiring",
      when: onWiringTab,
      run: () => (isCompact() ? openSheet() : shell.toggleAltbar(true)),
    },
  ];

  return {
    Section,
    panel,
    commands,
    shared: { store, connect, apply },
    dispose: () => {
      unsubscribeSync();
      window.removeEventListener("focus", onFocus);
      if (sheetOpen) menu.close();
      store.dispose();
    },
  };
}
