/**
 * The layout: a header spot, sidebar, one main region, and the altbar opposite the
 * sidebar. Everything inside them belongs
 * to another plugin, which is what makes this shell replaceable — a different shell
 * defines the same three points and nothing else has to change (SPEC §6.1).
 *
 * The properties that are requirements rather than styling:
 *
 * - **Landmarks and a skip link** (SPEC §8): `<aside>`, `<main>`, and a first-tab-stop
 *   link that moves focus into the main region. The `<header>` and its `<nav>` are the
 *   header contribution's to render.
 * - **The mobile breakpoint** (SPEC §6.5): below it the sidebar (and the altbar, from
 *   the other edge) is a drawer over a single pane, Escape closes it, focus moves into it when it opens and back to
 *   whatever opened it when it closes, and every control is at least
 *   `--lm-tap-target` tall.
 * - **Every contributed component renders inside `kernel.ui.boundary`** (SPEC §6.4),
 *   so a panel that throws is a chip in the sidebar, not a blank application.
 * - **A view id the shell cannot resolve is a message, not an empty pane.** The
 *   router can legitimately select a view before the plugin that provides it has
 *   activated, and `main.view` is live, so the resolution has to happen at render.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { Contribution, Kernel } from "@kernel";

import { BoundedIcon, bounded, usePointEntries } from "../../_shared/boundary.js";
import {
  POINTS,
  type AltbarPanel,
  type MainView,
  type ShellHeader,
  type ShellOverlay,
  type ShownView,
  type SidebarPanel,
} from "../../_shared/points.js";

import { useShell } from "./hooks.js";
import {
  ALTBAR_WIDTH_KEY,
  KEYBOARD_STEP,
  SIDEBAR_DEFAULT,
  clampSidebarWidth,
  rememberSidebarWidth,
  sidebarMax,
  storedSidebarWidth,
} from "./resize.js";
import type { ShellState, ViewSelection } from "./state.js";

/** The sidebar element's id — `ShellUiApi.sidebarId`, for a toggle's `aria-controls`. */
export const SIDEBAR_ID = "shell-sidebar";
/** The altbar element's id — `ShellUiApi.altbarId`. */
export const ALTBAR_ID = "shell-altbar";

const NO_VIEW: ShownView = { id: "", params: {} };

export interface ShellProps {
  readonly kernel: Kernel;
  readonly state: ShellState;
}

export function Shell({ kernel, state }: ShellProps): ReactNode {
  const shell = useShell(state);
  const views = usePointEntries<MainView>(kernel, POINTS.mainView);
  const panels = usePointEntries<SidebarPanel>(kernel, POINTS.sidebarPanel);
  const altbarEntries = usePointEntries<AltbarPanel>(kernel, POINTS.altbarPanel);
  const headers = usePointEntries<ShellHeader>(kernel, POINTS.shellHeader);
  const overlays = usePointEntries<ShellOverlay>(kernel, POINTS.shellOverlay);

  const main = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const altbar = useRef<HTMLElement>(null);
  // The toggle is the header's, so the shell cannot hold a ref to it: whatever had
  // focus when the drawer opened is where focus goes back to.
  const opener = useRef<HTMLElement | null>(null);
  const drawer = shell.compact && shell.sidebarOpen;
  const altDrawer = shell.compact && shell.altbarOpen;
  const hasSidebar = panels.length > 0;
  const shown: ShownView = shell.view ?? NO_VIEW;
  const altPanels = altbarEntries
    .filter((entry) => accepts(kernel, entry, shown))
    .sort((a, b) => (a.value.order ?? 100) - (b.value.order ?? 100));
  const hasAltbar = altPanels.length > 0;

  useEffect(() => state.setHasSidebar(hasSidebar), [state, hasSidebar]);
  useEffect(() => state.setHasAltbar(hasAltbar), [state, hasAltbar]);

  const closeDrawer = useCallback(() => {
    state.toggleSidebar(false);
    state.toggleAltbar(false);
    opener.current?.focus();
    opener.current = null;
  }, [state]);

  // Column widths: user-draggable on a desktop layout (drawers size themselves), and
  // remembered per device (resize.ts). The altbar grows leftwards.
  const sidebarSize = useColumnWidth(sidebar, 1);
  const altbarSize = useColumnWidth(altbar, -1, ALTBAR_WIDTH_KEY);

  const active = views.find((entry) => entry.value.id === shell.view?.id);

  useEffect(() => {
    const title = active?.value.title;
    document.title = title ? `${title} · Life Manager` : "Life Manager";
  }, [active]);

  // A drawer is modal-ish: Escape closes it and focus goes back where it came from.
  const anyDrawer = drawer || altDrawer;
  useEffect(() => {
    if (!anyDrawer) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    (drawer ? sidebar : altbar).current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anyDrawer, drawer, closeDrawer]);

  const header = pickHeader(headers);

  return (
    <div className="shell-root shellui:flex shellui:h-full shellui:min-h-0 shellui:flex-col shellui:font-sans shellui:text-text" data-compact={shell.compact ? "" : undefined}>
      {/*
        A real anchor so it is the first tab stop and announces as a link — but the
        click is handled here: `href="#shell-main"` would rewrite `location.hash`,
        which is the router's address space (`#/doc/…`), and skipping to the content
        would navigate away from it.
      */}
      <a
        className="shellui:tap-h shellui:absolute shellui:left-[calc(var(--lm-space)*0.5+var(--lm-safe-left))] shellui:top-[calc(var(--lm-space)*0.5+var(--lm-safe-top))] shellui:z-30 shellui:inline-flex shellui:-translate-y-[200%] shellui:items-center shellui:rounded shellui:bg-bg-raised shellui:px-2 shellui:py-1.5 shellui:shadow-2 shellui:focus:translate-y-0"
        href="#shell-main"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>

      {header ? <HeaderSlot kernel={kernel} entry={header} /> : null}

      <div className="shellui:relative shellui:flex shellui:min-h-0 shellui:flex-1">
        {hasSidebar ? (
          <aside
            id={SIDEBAR_ID}
            ref={sidebar}
            className="shellui:@container shellui:w-[min(18rem,32vw)] shellui:shrink-0 shellui:overflow-y-auto shellui:overscroll-contain shellui:border-r shellui:border-border shellui:bg-bg-subtle shellui:p-1 shellui:pb-[calc(var(--lm-space)*0.5+var(--lm-safe-bottom))] shellui:compact:absolute shellui:compact:inset-y-0 shellui:compact:left-0 shellui:compact:z-20 shellui:compact:w-[min(20rem,86vw)] shellui:compact:border-border-strong shellui:compact:shadow-2"
            aria-label="Sidebar"
            tabIndex={-1}
            hidden={!shell.sidebarOpen}
            data-drawer={drawer ? "" : undefined}
            style={
              !drawer && sidebarSize.width !== undefined ? { width: `${sidebarSize.width}px` } : undefined
            }
          >
            {panels.map((entry) => (
              <Panel key={entry.value.id} kernel={kernel} entry={entry} state={state} />
            ))}
          </aside>
        ) : null}

        {hasSidebar && shell.sidebarOpen && !shell.compact ? (
          <ResizeHandle label="Resize the sidebar (arrow keys; Home resets)" size={sidebarSize} />
        ) : null}

        {anyDrawer ? (
          <div
            className="shellui:absolute shellui:inset-0 shellui:z-15 shellui:bg-bg-overlay"
            // Decoration: Escape and the toggle are the accessible ways out, and a
            // focusable overlay would just be a tab stop that does nothing.
            aria-hidden="true"
            onClick={closeDrawer}
          />
        ) : null}

        <main id="shell-main" ref={main} className="shellui:min-h-0 shellui:min-w-0 shellui:flex-1 shellui:overflow-auto shellui:focus:outline-none shellui:focus-visible:outline-2 shellui:focus-visible:outline-offset-[-2px] shellui:focus-visible:outline-focus" tabIndex={-1}>
          {active ? (
            <ActiveView kernel={kernel} entry={active} view={shell.view} />
          ) : (
            <MissingView view={shell.view} registered={views.length} />
          )}
        </main>

        {hasAltbar && shell.altbarOpen && !shell.compact ? (
          <ResizeHandle label="Resize the side panel (arrow keys; Home resets)" size={altbarSize} />
        ) : null}

        {hasAltbar ? (
          <aside
            id={ALTBAR_ID}
            ref={altbar}
            className="shellui:@container shellui:w-[min(20rem,32vw)] shellui:shrink-0 shellui:overflow-y-auto shellui:overscroll-contain shellui:border-l shellui:border-border shellui:bg-bg-subtle shellui:p-1 shellui:pb-[calc(var(--lm-space)*0.5+var(--lm-safe-bottom))] shellui:compact:absolute shellui:compact:inset-y-0 shellui:compact:right-0 shellui:compact:z-20 shellui:compact:w-[min(22rem,90vw)] shellui:compact:border-border-strong shellui:compact:shadow-2"
            aria-label="Side panel"
            tabIndex={-1}
            hidden={!shell.altbarOpen}
            data-drawer={altDrawer ? "" : undefined}
            style={
              !altDrawer && altbarSize.width !== undefined ? { width: `${altbarSize.width}px` } : undefined
            }
          >
            {altPanels.map((entry) => (
              <AltPanel key={entry.value.id} kernel={kernel} entry={entry} state={state} view={shown} />
            ))}
          </aside>
        ) : null}
      </div>

      {overlays.map((entry) => (
        <OverlaySlot key={entry.value.id} kernel={kernel} entry={entry} />
      ))}
    </div>
  );
}

/** A panel's `when` is another plugin's code: a throw hides that panel, nothing else. */
function accepts(kernel: Kernel, entry: Contribution<AltbarPanel>, view: ShownView): boolean {
  try {
    return entry.value.when?.(view) ?? true;
  } catch (error) {
    kernel.log.error(`altbar panel ${entry.value.id} threw from when(); hiding it`, error);
    return false;
  }
}

interface ColumnSize {
  readonly width: number | undefined;
  readonly apply: (px: number | undefined) => void;
  readonly onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * A column's width. `direction` is which way a rightward drag moves its edge: `1` for
 * the sidebar (its edge is on its right), `-1` for the altbar (its edge is on its left).
 */
function useColumnWidth(
  column: React.RefObject<HTMLElement | null>,
  direction: 1 | -1,
  storageKey?: string,
): ColumnSize {
  const [width, setWidth] = useState<number | undefined>(() => {
    const stored = storedSidebarWidth(storageKey);
    return stored === undefined
      ? undefined
      : clampSidebarWidth(stored, globalThis.innerWidth ?? SIDEBAR_DEFAULT * 4);
  });
  const apply = useCallback(
    (px: number | undefined) => {
      setWidth(px);
      rememberSidebarWidth(px, storageKey);
    },
    [storageKey],
  );
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Primary button only; a touch drag scrolls, and compact mode has no resizer.
      if (event.button !== 0) return;
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth = column.current?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT;
      const widthAt = (x: number): number =>
        clampSidebarWidth(startWidth + direction * (x - startX), innerWidth);
      handle.setPointerCapture(event.pointerId);
      handle.dataset["dragging"] = "";
      const onMove = (move: PointerEvent): void => setWidth(widthAt(move.clientX));
      const onUp = (up: PointerEvent): void => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        delete handle.dataset["dragging"];
        rememberSidebarWidth(widthAt(up.clientX), storageKey);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [column, direction, storageKey],
  );
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current = column.current?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // The arrow points where the edge goes.
        const delta = (event.key === "ArrowLeft" ? -KEYBOARD_STEP : KEYBOARD_STEP) * direction;
        apply(clampSidebarWidth(current + delta, innerWidth));
        event.preventDefault();
      } else if (event.key === "Home") {
        apply(undefined); // back to the stylesheet's default
        event.preventDefault();
      }
    },
    [apply, column, direction],
  );
  return { width, apply, onPointerDown, onKeyDown };
}

function ResizeHandle({ label, size }: { readonly label: string; readonly size: ColumnSize }): ReactNode {
  return (
    <div
      className="shellui:relative shellui:z-[1] shellui:-mx-[5px] shellui:shrink-0 shellui:grow-0 shellui:basis-[10px] shellui:touch-none shellui:cursor-col-resize shellui:hover:bg-[linear-gradient(to_right,transparent_4px,var(--lm-accent)_4px,var(--lm-accent)_6px,transparent_6px)] shellui:focus-visible:bg-[linear-gradient(to_right,transparent_4px,var(--lm-accent)_4px,var(--lm-accent)_6px,transparent_6px)] shellui:focus-visible:outline-none shellui:data-[dragging]:bg-[linear-gradient(to_right,transparent_4px,var(--lm-accent)_4px,var(--lm-accent)_6px,transparent_6px)]"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={size.width ?? SIDEBAR_DEFAULT}
      aria-valuemin={192}
      aria-valuemax={sidebarMax(globalThis.innerWidth ?? SIDEBAR_DEFAULT * 4)}
      tabIndex={0}
      onPointerDown={size.onPointerDown}
      onKeyDown={size.onKeyDown}
      onDoubleClick={() => size.apply(undefined)}
      title="Drag to resize. Double-click to reset."
    />
  );
}

/** The lowest `order` wins (default 100); a tie keeps registration order. */
function pickHeader(
  entries: readonly Contribution<ShellHeader>[],
): Contribution<ShellHeader> | undefined {
  let best: Contribution<ShellHeader> | undefined;
  for (const entry of entries) {
    if (!best || (entry.value.order ?? 100) < (best.value.order ?? 100)) best = entry;
  }
  return best;
}

function OverlaySlot({
  kernel,
  entry,
}: {
  readonly kernel: Kernel;
  readonly entry: Contribution<ShellOverlay>;
}): ReactNode {
  const Rendered = bounded(kernel, entry.value.component, POINTS.shellOverlay, entry.pluginId);
  return <Rendered />;
}

function HeaderSlot({
  kernel,
  entry,
}: {
  readonly kernel: Kernel;
  readonly entry: Contribution<ShellHeader>;
}): ReactNode {
  const Rendered = bounded(kernel, entry.value.component, POINTS.shellHeader, entry.pluginId);
  return <Rendered />;
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
  const Rendered = bounded(kernel, panel.component, POINTS.sidebarPanel, entry.pluginId);
  return (
    <PanelFrame
      kernel={kernel}
      pluginId={entry.pluginId}
      point={POINTS.sidebarPanel}
      title={panel.title}
      icon={panel.icon}
      bodyId={`shell-panel-${panel.id}`}
      open={open}
      onToggle={() => state.setPanelOpen(panel.id, !open)}
    >
      <Rendered />
    </PanelFrame>
  );
}

/** A collapsible panel: a heading that toggles it, and its body. */
function PanelFrame({
  kernel,
  pluginId,
  point,
  title,
  icon,
  bodyId,
  open,
  onToggle,
  children,
}: {
  readonly kernel: Kernel;
  readonly pluginId: string;
  readonly point: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly bodyId: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="shellui:mb-1" data-plugin={pluginId}>
      <h2 className="shellui:m-0 shellui:text-sm shellui:font-semibold shellui:uppercase shellui:tracking-[0.04em]">
        <button
          type="button"
          className="shellui:tap-h shellui:flex shellui:w-full shellui:cursor-pointer shellui:items-center shellui:gap-1 shellui:rounded shellui:border-0 shellui:bg-transparent shellui:px-1 shellui:text-left shellui:text-text-muted shellui:hover:bg-bg-raised shellui:hover:text-text"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="shellui:w-[1em]" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <BoundedIcon kernel={kernel} node={icon} point={point} pluginId={pluginId} className="shellui:shrink-0" />
          <span>{title}</span>
        </button>
      </h2>
      {/* `hidden`, not unmounted: collapsing a panel must not throw away its state. */}
      <div id={bodyId} className="shellui:px-1 shellui:pb-1" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function AltPanel({
  kernel,
  entry,
  state,
  view,
}: {
  readonly kernel: Kernel;
  readonly entry: Contribution<AltbarPanel>;
  readonly state: ShellState;
  readonly view: ShownView;
}): ReactNode {
  const panel = entry.value;
  // A key of its own, so a sidebar panel and an altbar panel may share an id.
  const key = `altbar:${panel.id}`;
  const open = state.panelOpen(key, panel.defaultOpen ?? true);
  const Rendered = bounded(kernel, panel.component, POINTS.altbarPanel, entry.pluginId);
  return (
    <PanelFrame
      kernel={kernel}
      pluginId={entry.pluginId}
      point={POINTS.altbarPanel}
      title={panel.title}
      icon={panel.icon}
      bodyId={`shell-altbar-panel-${panel.id}`}
      open={open}
      onToggle={() => state.setPanelOpen(key, !open)}
    >
      <Rendered view={view} />
    </PanelFrame>
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
      <div className="shellui:mx-auto shellui:max-w-[34rem] shellui:px-4 shellui:py-8 shellui:text-text-muted shellui:[&_h1]:mb-2 shellui:[&_h1]:mt-0 shellui:[&_h1]:text-xl shellui:[&_h1]:text-text">
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
    <div className="shellui:mx-auto shellui:max-w-[34rem] shellui:px-4 shellui:py-8 shellui:text-text-muted shellui:[&_h1]:mb-2 shellui:[&_h1]:mt-0 shellui:[&_h1]:text-xl shellui:[&_h1]:text-text" role="status">
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
