import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { Kernel, RegistryEntry } from "@kernel";

import { BoundedIcon, bounded, useRegistry } from "../../_shared/boundary.js";
import { target as mark } from "../../_shared/target.js";

import {
  altbarPanels,
  footers as footerSeat,
  headers as headerSeat,
  overlays as overlayRegistry,
  sidebarPanels,
  views as viewRegistry,
  type AltbarPanel,
  type MainView,
  type ShellFooterComponent,
  type ShellHeaderComponent,
  type ShellOverlay,
  type ShownView,
  type SidebarPanel,
} from "./api.js";
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

export const SIDEBAR_ID = "shell-sidebar";
export const ALTBAR_ID = "shell-altbar";

const NO_VIEW: ShownView = { id: "", params: {} };

const POINT = {
  header: "shell-ui.header",
  footer: "shell-ui.footer",
  overlay: "shell-ui.overlay",
  sidebar: "shell-ui.sidebar",
  altbar: "shell-ui.altbar",
  view: "shell-ui.view",
} as const;

export interface ShellProps {
  readonly kernel: Kernel;
  readonly state: ShellState;
}

export function Shell({ kernel, state }: ShellProps): ReactNode {
  const shell = useShell(state);
  const views = useRegistry(viewRegistry);
  const panels = useRegistry(sidebarPanels);
  const altbarEntries = useRegistry(altbarPanels);
  const headers = useRegistry(headerSeat);
  const footers = useRegistry(footerSeat);
  const overlays = useRegistry(overlayRegistry);

  const main = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const altbar = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drawer = shell.compact && shell.sidebarOpen;
  const altDrawer = shell.compact && shell.altbarOpen;
  const hasSidebar = panels.length > 0;
  const shown: ShownView = shell.view ?? NO_VIEW;
  const altPanels = altbarEntries.filter((entry) => accepts(kernel, entry, shown));
  const hasAltbar = altPanels.length > 0;

  useEffect(() => state.setHasSidebar(hasSidebar), [state, hasSidebar]);
  useEffect(() => state.setHasAltbar(hasAltbar), [state, hasAltbar]);

  const closeDrawer = useCallback(() => {
    state.toggleSidebar(false);
    state.toggleAltbar(false);
    opener.current?.focus();
    opener.current = null;
  }, [state]);

  const sidebarSize = useColumnWidth(sidebar, 1);
  const altbarSize = useColumnWidth(altbar, -1, ALTBAR_WIDTH_KEY);

  const active = views.find((entry) => entry.value.id === shell.view?.id);

  useEffect(() => {
    const title = active?.value.title;
    document.title = title ? `${title} · ddd` : "ddd";
  }, [active]);

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

  const header = headers[headers.length - 1];
  const footer = footers[footers.length - 1];
  const root = useRef<HTMLDivElement>(null);
  const footerBox = useRef<HTMLDivElement>(null);
  useFooterHeight(root, footerBox, footer !== undefined);

  return (
    <div ref={root} className="shell-root shellui:relative shellui:flex shellui:h-full shellui:overflow-hidden shellui:min-h-0 shellui:flex-col shellui:font-sans shellui:text-text" data-compact={shell.compact ? "" : undefined}>
      <a
        className="shellui:tap-h shellui:absolute shellui:left-[calc(var(--ddd-space)*0.5+var(--ddd-safe-left))] shellui:top-[calc(var(--ddd-space)*0.5+var(--ddd-safe-top))] shellui:z-30 shellui:inline-flex shellui:-translate-y-[200%] shellui:items-center shellui:rounded shellui:bg-bg-raised shellui:px-2 shellui:py-1.5 shellui:shadow-2 shellui:focus:translate-y-0"
        href="#shell-main"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>

      {header ? <HeaderSlot kernel={kernel} entry={header} /> : null}

      <div className="shellui:relative shellui:flex shellui:min-h-0 shellui:flex-1 shellui:overflow-hidden">
        {hasSidebar ? (
          <aside
            id={SIDEBAR_ID}
            ref={sidebar}
            className="shellui:@container shellui:relative shellui:w-[min(18rem,32vw)] shellui:shrink-0 shellui:overflow-y-auto shellui:overscroll-contain shellui:border-r shellui:border-border shellui:bg-bg-subtle shellui:p-1 shellui:pb-[calc(var(--ddd-space)*0.5+var(--ddd-safe-bottom))] shellui:compact:absolute shellui:compact:inset-y-0 shellui:compact:left-0 shellui:compact:z-20 shellui:compact:w-[min(20rem,86vw)] shellui:compact:border-border-strong shellui:compact:shadow-2"
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
            aria-hidden="true"
            onClick={closeDrawer}
          />
        ) : null}

        <main id="shell-main" ref={main} className="shellui:relative shellui:min-h-0 shellui:min-w-0 shellui:flex-1 shellui:overflow-auto shellui:focus:outline-none shellui:focus-visible:outline-2 shellui:focus-visible:outline-offset-[-2px] shellui:focus-visible:outline-focus" tabIndex={-1}>
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
            className="shellui:@container shellui:relative shellui:w-[min(20rem,32vw)] shellui:shrink-0 shellui:overflow-y-auto shellui:overscroll-contain shellui:border-l shellui:border-border shellui:bg-bg-subtle shellui:p-1 shellui:pb-[calc(var(--ddd-space)*0.5+var(--ddd-safe-bottom))] shellui:compact:absolute shellui:compact:inset-y-0 shellui:compact:right-0 shellui:compact:z-20 shellui:compact:w-[min(22rem,90vw)] shellui:compact:border-border-strong shellui:compact:shadow-2"
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

      {footer ? (
        <div ref={footerBox} className="shellui:shrink-0">
          <FooterSlot kernel={kernel} entry={footer} />
        </div>
      ) : null}

      {overlays.map((entry) => (
        <OverlaySlot key={entry.value.id} kernel={kernel} entry={entry} />
      ))}
    </div>
  );
}

function accepts(kernel: Kernel, entry: RegistryEntry<AltbarPanel>, view: ShownView): boolean {
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
        const delta = (event.key === "ArrowLeft" ? -KEYBOARD_STEP : KEYBOARD_STEP) * direction;
        apply(clampSidebarWidth(current + delta, innerWidth));
        event.preventDefault();
      } else if (event.key === "Home") {
        apply(undefined);
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
      className="shellui:relative shellui:z-[1] shellui:-mx-[5px] shellui:shrink-0 shellui:grow-0 shellui:basis-[10px] shellui:touch-none shellui:cursor-col-resize shellui:hover:bg-[linear-gradient(to_right,transparent_4px,var(--ddd-accent)_4px,var(--ddd-accent)_6px,transparent_6px)] shellui:focus-visible:bg-[linear-gradient(to_right,transparent_4px,var(--ddd-accent)_4px,var(--ddd-accent)_6px,transparent_6px)] shellui:focus-visible:outline-none shellui:data-[dragging]:bg-[linear-gradient(to_right,transparent_4px,var(--ddd-accent)_4px,var(--ddd-accent)_6px,transparent_6px)]"
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

function OverlaySlot({
  kernel,
  entry,
}: {
  readonly kernel: Kernel;
  readonly entry: RegistryEntry<ShellOverlay>;
}): ReactNode {
  const Rendered = bounded(kernel, entry.value.component, POINT.overlay, entry.pluginId);
  return <Rendered />;
}

function useFooterHeight(
  root: React.RefObject<HTMLElement | null>,
  footer: React.RefObject<HTMLElement | null>,
  present: boolean,
): void {
  useEffect(() => {
    const shell = root.current;
    const box = footer.current;
    if (!shell) return undefined;
    const publish = (): void => {
      const height = present && box ? box.getBoundingClientRect().height : 0;
      shell.style.setProperty("--shell-footer-height", `${height}px`);
    };
    publish();
    if (!present || !box || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(publish);
    observer.observe(box);
    return () => observer.disconnect();
  }, [root, footer, present]);
}

function FooterSlot({
  kernel,
  entry,
}: {
  readonly kernel: Kernel;
  readonly entry: RegistryEntry<{ readonly component: ShellFooterComponent }>;
}): ReactNode {
  const Rendered = bounded(kernel, entry.value.component, POINT.footer, entry.pluginId);
  return <Rendered />;
}

function HeaderSlot({
  kernel,
  entry,
}: {
  readonly kernel: Kernel;
  readonly entry: RegistryEntry<{ readonly component: ShellHeaderComponent }>;
}): ReactNode {
  const Rendered = bounded(kernel, entry.value.component, POINT.header, entry.pluginId);
  return <Rendered />;
}

function Panel({
  kernel,
  entry,
  state,
}: {
  readonly kernel: Kernel;
  readonly entry: RegistryEntry<SidebarPanel>;
  readonly state: ShellState;
}): ReactNode {
  const panel = entry.value;
  const open = state.panelOpen(panel.id, panel.defaultOpen ?? true);
  const Rendered = bounded(kernel, panel.component, POINT.sidebar, entry.pluginId);
  return (
    <PanelFrame
      kernel={kernel}
      pluginId={entry.pluginId}
      point={POINT.sidebar}
      title={panel.title}
      icon={panel.icon}
      bodyId={`shell-panel-${panel.id}`}
      open={open}
      onToggle={() => state.setPanelOpen(panel.id, !open)}
      {...(panel.target !== undefined ? { target: panel.target } : {})}
    >
      <Rendered />
    </PanelFrame>
  );
}

function PanelFrame({
  kernel,
  pluginId,
  point,
  title,
  icon,
  bodyId,
  open,
  onToggle,
  target,
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
  readonly target?: SidebarPanel["target"];
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
          {...(target !== undefined ? mark(target.type, target.id ?? "", { label: title }) : {})}
        >
          <span className="shellui:w-[1em]" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <BoundedIcon kernel={kernel} node={icon} point={point} pluginId={pluginId} className="shellui:shrink-0" />
          <span>{title}</span>
        </button>
      </h2>
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
  readonly entry: RegistryEntry<AltbarPanel>;
  readonly state: ShellState;
  readonly view: ShownView;
}): ReactNode {
  const panel = entry.value;
  const key = `altbar:${panel.id}`;
  const open = state.panelOpen(key, panel.defaultOpen ?? true);
  const Rendered = bounded(kernel, panel.component, POINT.altbar, entry.pluginId);
  return (
    <PanelFrame
      kernel={kernel}
      pluginId={entry.pluginId}
      point={POINT.altbar}
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
  readonly entry: RegistryEntry<MainView>;
  readonly view: ViewSelection | undefined;
}): ReactNode {
  const Rendered = bounded(kernel, entry.value.component, POINT.view, entry.pluginId);
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
            : "Pick a view from the menu."}
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
