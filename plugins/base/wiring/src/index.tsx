/**
 * `wiring` — the wiring editor (PLUGIN-PROTOCOLS §7): every plugin's ports and the wires
 * between them, drafts, Apply, history and rollback, at `#/wiring`.
 *
 * - `model.ts` — nodes, ports and wires from the plugin list and a resolution.
 * - `draft.ts` — the edits: connect, cut, seats, plug, and rebasing onto a newer live.
 * - `layout.ts` — columns by dependants, port rows, seats, wire curves. No DOM.
 * - `changes.ts` — the change list and apply plan as rows.
 * - `store.ts` — the state: live, draft, resolutions, plan, selection, storage.
 * - `Graph.tsx`, `Inspector.tsx`, `WiringView.tsx` — the screen.
 *
 * Written against `kernel.ports` alone: it names its own ports (`router`, `shell`, `menu`
 * in; `route`, `view`, `panel`, `commands` out) and the server's resolver wires
 * them. It has no kernel privilege; everything goes through the admin-only wiring routes,
 * and the plugin hides its entry points for non-admins as a courtesy (the route exists
 * for everyone so a direct link says "not an administrator" rather than 404).
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
import type { MainView } from "@protocols/lm/main.view";
import type { Router } from "@protocols/lm/router";
import type { Route } from "@protocols/lm/router.route";
import type { Shell } from "@protocols/lm/shell";

import { OfflineCopyState, offlineCopies } from "../../_shared/offline-copy.js";

import { createWiringClient } from "./api.js";
import type { ChangeSummary } from "./changes.js";
import { Inspector } from "./Inspector.js";
import { EditorStore, type Selection } from "./store.js";
import { WiringView } from "./WiringView.js";

export const VIEW = "wiring.main";

const ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="1.5" y="2.5" width="5" height="4" rx="1" />
    <rect x="9.5" y="9.5" width="5" height="4" rx="1" />
    <path d="M6.5 4.5h2a2 2 0 0 1 2 2v3M1.5 11.5h3" />
    <circle cx="6" cy="11.5" r="1.2" />
  </svg>
);

/** What `activate` leaves behind for `deactivate` to undo. */
let teardown: (() => void) | undefined;

export default function activate(kernel: Kernel): void {
  const router = kernel.ports.use<Pick<Router, "navigate" | "current" | "onChange">>("router");
  const shell = kernel.ports.use<Pick<Shell, "layout" | "subscribeLayout" | "toggleAltbar">>("shell");
  const menu = kernel.ports.use<Pick<ContextMenu, "confirm" | "modal" | "openSheet" | "close">>("menu");
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
          <span className="wiring:font-mono wiring:text-xs">
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
          <span className="wiring:text-xs">
            {summary.stopsEditor && summary.addedErrors > 0 ? `+${summary.addedErrors} errors · ` : ""}
            Way back: <code>#/admin/plugins</code> · <code>?safe=bare</code>
          </span>
        ),
        confirmLabel: `Apply v${version + 1}`,
        danger: true,
      }),
    );
  };

  // ---- what the plugin offers ----

  kernel.ports.offer<Route>("route", { path: "/wiring", view: VIEW });

  const Host = (): ReactElement => {
    const layout = useSyncExternalStore(shell.subscribeLayout, shell.layout, shell.layout);
    useEffect(() => {
      void store.load();
    }, []);
    return (
      <WiringView store={store} isAdmin={admin} compact={layout.compact} onSelect={select} onConnect={connect} onApply={apply} onInspect={openSheet} />
    );
  };
  kernel.ports.offer<MainView>("view", { id: VIEW, title: "Wiring", component: Host });

  if (admin) {
    kernel.ports.offer<AltbarPanel>("panel", {
      id: "wiring.inspector",
      title: "Inspector",
      icon: ICON,
      order: 60,
      when: (view) => view.id === VIEW,
      component: () => <Inspector store={store} onSelect={select} onConnect={connect} onApply={apply} />,
    });
    kernel.ports.offer<Command>("commands", [
      { id: "wiring.open", title: "Open the wiring editor", category: "Wiring", run: () => router.navigate("/wiring") },
      {
        id: "wiring.inspect",
        title: "Show the wiring inspector",
        category: "Wiring",
        when: () => router.current().split("?")[0] === "/wiring",
        run: () => (isCompact() ? openSheet() : shell.toggleAltbar(true)),
      },
    ]);
  }

  teardown = () => {
    unsubscribeSync();
    window.removeEventListener("focus", onFocus);
    if (sheetOpen) menu.close();
    store.dispose();
  };
}

/** Everything `activate` built itself; the kernel withdraws the offers (`"hot": true`). */
export function deactivate(): void {
  teardown?.();
  teardown = undefined;
}
