/**
 * The layout: navbar, sidebar, one main region. Everything inside them belongs to
 * another plugin, which is what makes this shell replaceable — a different shell
 * defines the same three points and nothing else has to change (SPEC §6.1).
 *
 * The properties that are requirements rather than styling:
 *
 * - **Landmarks and a skip link** (SPEC §8): `<header>`, `<nav>`, `<aside>`,
 *   `<main>`, and a first-tab-stop link that moves focus into the main region.
 * - **The mobile breakpoint** (SPEC §6.5): below it the sidebar is a drawer over a
 *   single pane, Escape closes it, focus moves into it when it opens and back to the
 *   toggle when it closes, and every control is at least `--lm-tap-target` tall.
 * - **Every contributed component renders inside `kernel.ui.boundary`** (SPEC §6.4),
 *   so a panel that throws is a chip in the sidebar, not a blank application.
 * - **A view id the shell cannot resolve is a message, not an empty pane.** The
 *   router can legitimately select a view before the plugin that provides it has
 *   activated, and `main.view` is live, so the resolution has to happen at render.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { Contribution, Kernel } from "@kernel";

import { POINTS, type MainView, type NavbarItem, type SidebarPanel } from "../../_shared/points.js";

import { BoundedIcon, bounded, usePointEntries, useShell } from "./hooks.js";
import { NoticeBell, SyncIndicator } from "./indicators.js";
import {
  KEYBOARD_STEP,
  SIDEBAR_DEFAULT,
  clampSidebarWidth,
  rememberSidebarWidth,
  sidebarMax,
  storedSidebarWidth,
} from "./resize.js";
import type { ShellState, ViewSelection } from "./state.js";

export interface ShellProps {
  readonly kernel: Kernel;
  readonly state: ShellState;
}

export function Shell({ kernel, state }: ShellProps): ReactNode {
  const shell = useShell(state);
  const views = usePointEntries<MainView>(kernel, POINTS.mainView);
  const panels = usePointEntries<SidebarPanel>(kernel, POINTS.sidebarPanel);
  const items = usePointEntries<NavbarItem>(kernel, POINTS.navbarItem);

  const main = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const drawer = shell.compact && shell.sidebarOpen;

  // Sidebar width: user-draggable on a desktop layout (the drawer sizes itself).
  // State holds the applied width; storage remembers it per device (resize.ts).
  const [sidebarWidth, setSidebarWidth] = useState<number | undefined>(() => {
    const stored = storedSidebarWidth();
    return stored === undefined
      ? undefined
      : clampSidebarWidth(stored, globalThis.innerWidth ?? SIDEBAR_DEFAULT * 4);
  });
  const applyWidth = useCallback((px: number | undefined) => {
    setSidebarWidth(px);
    rememberSidebarWidth(px);
  }, []);
  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Primary button only; a touch drag scrolls, and compact mode has no resizer.
      if (event.button !== 0) return;
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth = sidebar.current?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT;
      handle.setPointerCapture(event.pointerId);
      handle.dataset["dragging"] = "";
      const onMove = (move: PointerEvent): void => {
        setSidebarWidth(clampSidebarWidth(startWidth + (move.clientX - startX), innerWidth));
      };
      const onUp = (up: PointerEvent): void => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        delete handle.dataset["dragging"];
        rememberSidebarWidth(clampSidebarWidth(startWidth + (up.clientX - startX), innerWidth));
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [],
  );
  const onResizeKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current = sidebar.current?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const delta = event.key === "ArrowLeft" ? -KEYBOARD_STEP : KEYBOARD_STEP;
        applyWidth(clampSidebarWidth(current + delta, innerWidth));
        event.preventDefault();
      } else if (event.key === "Home") {
        applyWidth(undefined); // back to the stylesheet's default
        event.preventDefault();
      }
    },
    [applyWidth],
  );

  const active = views.find((entry) => entry.value.id === shell.view?.id);

  useEffect(() => {
    const title = active?.value.title;
    document.title = title ? `${title} · Life Manager` : "Life Manager";
  }, [active]);

  // The drawer is modal-ish: Escape closes it and focus goes back where it came from.
  useEffect(() => {
    if (!drawer) return;
    sidebar.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      state.toggleSidebar(false);
      toggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer, state]);

  const hasSidebar = panels.length > 0;

  return (
    <div className="shell-root" data-compact={shell.compact ? "" : undefined}>
      {/*
        A real anchor so it is the first tab stop and announces as a link — but the
        click is handled here: `href="#shell-main"` would rewrite `location.hash`,
        which is the router's address space (`#/doc/…`), and skipping to the content
        would navigate away from it.
      */}
      <a
        className="shell-skip"
        href="#shell-main"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>

      <header className="shell-navbar">
        {hasSidebar ? (
          <button
            ref={toggle}
            type="button"
            className="shell-sidebar-toggle"
            aria-expanded={shell.sidebarOpen}
            aria-controls="shell-sidebar"
            onClick={() => state.toggleSidebar()}
          >
            <span aria-hidden="true">☰</span>
            <span className="shell-visually-hidden">
              {shell.sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
            </span>
          </button>
        ) : null}

        <span className="shell-brand">Life Manager</span>

        <nav className="shell-nav" aria-label="Main">
          <ul className="shell-nav-list" data-side="start">
            {items
              .filter((entry) => (entry.value.side ?? "start") === "start")
              .map((entry) => (
                <NavItem key={entry.value.id} kernel={kernel} entry={entry} />
              ))}
          </ul>
          <ul className="shell-nav-list" data-side="end">
            {items
              .filter((entry) => entry.value.side === "end")
              .map((entry) => (
                <NavItem key={entry.value.id} kernel={kernel} entry={entry} />
              ))}
            <li>
              <NoticeBell kernel={kernel} />
            </li>
            <li>
              <SyncIndicator kernel={kernel} />
            </li>
          </ul>
        </nav>
      </header>

      <div className="shell-body">
        {hasSidebar ? (
          <aside
            id="shell-sidebar"
            ref={sidebar}
            className="shell-sidebar"
            aria-label="Sidebar"
            tabIndex={-1}
            hidden={!shell.sidebarOpen}
            data-drawer={drawer ? "" : undefined}
            style={
              !drawer && sidebarWidth !== undefined ? { width: `${sidebarWidth}px` } : undefined
            }
          >
            {panels.map((entry) => (
              <Panel key={entry.value.id} kernel={kernel} entry={entry} state={state} />
            ))}
          </aside>
        ) : null}

        {hasSidebar && shell.sidebarOpen && !shell.compact ? (
          <div
            className="shell-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the sidebar (arrow keys; Home resets)"
            aria-valuenow={sidebarWidth ?? SIDEBAR_DEFAULT}
            aria-valuemin={192}
            aria-valuemax={sidebarMax(globalThis.innerWidth ?? SIDEBAR_DEFAULT * 4)}
            tabIndex={0}
            onPointerDown={onResizeStart}
            onKeyDown={onResizeKey}
            onDoubleClick={() => applyWidth(undefined)}
            title="Drag to resize. Double-click to reset."
          />
        ) : null}

        {drawer ? (
          <div
            className="shell-scrim"
            // Decoration: Escape and the toggle are the accessible ways out, and a
            // focusable overlay would just be a tab stop that does nothing.
            aria-hidden="true"
            onClick={() => {
              state.toggleSidebar(false);
              toggle.current?.focus();
            }}
          />
        ) : null}

        <main id="shell-main" ref={main} className="shell-main" tabIndex={-1}>
          {active ? (
            <ActiveView kernel={kernel} entry={active} view={shell.view} />
          ) : (
            <MissingView view={shell.view} registered={views.length} />
          )}
        </main>
      </div>
    </div>
  );
}

function NavItem({
  kernel,
  entry,
}: {
  readonly kernel: Kernel;
  readonly entry: Contribution<NavbarItem>;
}): ReactNode {
  const item = entry.value;
  if (item.component) {
    const Rendered = bounded(kernel, item.component, POINTS.navbarItem, entry.pluginId);
    return (
      // `data-kind` is what lets the stylesheet tell a plugin's own widget (a search
      // box, which wants to grow) from a label the shell renders itself (a command
      // button, which wants its whole label or nothing). Without it the mobile navbar
      // shrank both in proportion and "New document" read "New docu…".
      <li className="shell-nav-item" data-kind="component" data-plugin={entry.pluginId}>
        <Rendered />
      </li>
    );
  }
  return (
    <li className="shell-nav-item" data-kind="button" data-plugin={entry.pluginId}>
      {item.onSelect ? (
        <button type="button" className="shell-nav-button" onClick={() => item.onSelect?.()}>
          <BoundedIcon
            kernel={kernel}
            node={item.icon}
            point={POINTS.navbarItem}
            pluginId={entry.pluginId}
            className="shell-nav-icon"
          />
          <span className="shell-nav-label">{item.label}</span>
        </button>
      ) : (
        <span className="shell-nav-static">{item.label}</span>
      )}
    </li>
  );
}

function Panel({
  kernel,
  entry,
  state,
}: {
  readonly kernel: Kernel;
  readonly entry: Contribution<SidebarPanel>;
  readonly state: ShellState;
}): ReactNode {
  const panel = entry.value;
  const open = state.panelOpen(panel.id, panel.defaultOpen ?? true);
  const bodyId = `shell-panel-${panel.id}`;
  const Rendered = bounded(kernel, panel.component, POINTS.sidebarPanel, entry.pluginId);

  return (
    <section className="shell-panel" data-plugin={entry.pluginId}>
      <h2 className="shell-panel-heading">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => state.setPanelOpen(panel.id, !open)}
        >
          <span className="shell-panel-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <BoundedIcon
            kernel={kernel}
            node={panel.icon}
            point={POINTS.sidebarPanel}
            pluginId={entry.pluginId}
            className="shell-panel-icon"
          />
          <span className="shell-panel-title">{panel.title}</span>
        </button>
      </h2>
      {/* `hidden`, not unmounted: collapsing a panel must not throw away its state. */}
      <div id={bodyId} className="shell-panel-body" hidden={!open}>
        <Rendered />
      </div>
    </section>
  );
}

function ActiveView({
  kernel,
  entry,
  view,
}: {
  readonly kernel: Kernel;
  readonly entry: Contribution<MainView>;
  readonly view: ViewSelection | undefined;
}): ReactNode {
  const Rendered = bounded(kernel, entry.value.component, POINTS.mainView, entry.pluginId);
  return <Rendered params={view?.params ?? {}} />;
}

function MissingView({
  view,
  registered,
}: {
  readonly view: ViewSelection | undefined;
  readonly registered: number;
}): ReactNode {
  if (!view) {
    return (
      <div className="shell-empty">
        <h1>Nothing open</h1>
        <p>
          {registered === 0
            ? "No plugin has contributed a view yet."
            : // "the sidebar" is behind ☰ on a phone; "the menu" is true on both.
              "Pick a view from the menu."}
        </p>
      </div>
    );
  }
  return (
    <div className="shell-empty" role="status">
      <h1>That view is not available</h1>
      <p>
        Nothing provides this view. Check the notices for a plugin that failed to load.
      </p>
      <p>
        <code>{view.id}</code>
      </p>
    </div>
  );
}
