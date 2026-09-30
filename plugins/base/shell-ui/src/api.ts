/**
 * What `shell-ui` exports to other plugins (`plugin:shell-ui`): the contribution types,
 * the registries that collect them, and the shapes each contribution is checked against.
 *
 * The registries live at module scope so a dependent can call `addView` & co. from its
 * own `activate`, which always runs after this plugin's.
 */

import type { ComponentType, ReactNode } from "react";

import { createRegistry, s, type Unsubscribe } from "@kernel";

/** Which main view is showing, and the route's params: what an altbar panel is about. */
export interface ShownView {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * A full-pane view, addressed by id. The router maps a URL to one of these, so a view and
 * its URL are provided independently.
 */
export interface MainView {
  readonly id: string;
  readonly component: ComponentType<{ readonly params?: Readonly<Record<string, string>> }>;
  /** Shown in window and tab titles. */
  readonly title?: string;
}

/**
 * A component that is always mounted, outside the header, sidebar and main region: a
 * command palette, a toast stack, a sheet. It should render nothing until it has
 * something to show, and anything modal should portal or position itself.
 */
export interface ShellOverlay {
  readonly id: string;
  readonly component: ComponentType<Record<string, never>>;
}

/** A collapsible panel in the sidebar (folders, the document list, an outline). */
export interface SidebarPanel {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<Record<string, never>>;
  readonly icon?: ReactNode;
  /** Top-to-bottom position; lower first. Default 100. */
  readonly order?: number;
  /** `true` ⇒ the panel starts open on first run. */
  readonly defaultOpen?: boolean;
  /** What the heading stands for, for its context menu: `{ type: "folders/root" }`. */
  readonly target?: {
    readonly type: string;
    readonly id?: string;
  };
}

/**
 * A panel in the altbar: the column opposite the sidebar, about whatever the main view is
 * showing. The shell draws the ones whose `when` accepts the current view; with none, the
 * altbar and its toggle are absent.
 */
export interface AltbarPanel {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<{ readonly view: ShownView }>;
  readonly icon?: ReactNode;
  /** Top-to-bottom position; lower first. Default 100. */
  readonly order?: number;
  /** `true` ⇒ the panel starts expanded on first run. Default `true`. */
  readonly defaultOpen?: boolean;
  /** Whether this panel has anything to say about `view`. Default: every view. */
  readonly when?: (view: ShownView) => boolean;
}

/** The top row's component. It owns its whole row, `<header>` included. */
export type ShellHeaderComponent = ComponentType<Record<string, never>>;

/** The bottom row's component. It owns its whole row, and the bottom safe-area inset under it. */
export type ShellFooterComponent = ComponentType<Record<string, never>>;

/** What a header or toolbar needs to know to drive the shell's sidebar. */
export interface ShellLayout {
  /** Below the mobile breakpoint: drawer sidebar, single pane. */
  readonly compact: boolean;
  /** Desktop: the sidebar column is shown. Compact: the drawer is open. */
  readonly sidebarOpen: boolean;
  /** At least one sidebar panel is contributed; with none there is nothing to toggle. */
  readonly hasSidebar: boolean;
  /** Desktop: the altbar column is shown. Compact: its drawer is open. */
  readonly altbarOpen: boolean;
  /** Some altbar panel accepts the current view; with none there is no altbar. */
  readonly hasAltbar: boolean;
}

/** The shell's service functions, as one object (the named exports of `plugin:shell-ui`). */
export interface Shell {
  /** `true` below the mobile breakpoint: adapt rather than re-measure. */
  readonly isCompact: () => boolean;
  readonly onLayoutChange: (listener: (compact: boolean) => void) => Unsubscribe;
  /** The current layout; the same object until something in it changes, for `useSyncExternalStore`. */
  readonly layout: () => ShellLayout;
  readonly subscribeLayout: (listener: () => void) => Unsubscribe;
  /** The sidebar element's id, for a toggle's `aria-controls`. */
  readonly sidebarId: string;
  /** Open or close the drawer (phone), or collapse the column (desktop). */
  readonly toggleSidebar: (open?: boolean) => void;
  /** The altbar element's id, for a toggle's `aria-controls`. */
  readonly altbarId: string;
  /** Open or close the altbar: a column on a wide screen, a drawer on a phone. */
  readonly toggleAltbar: (open?: boolean) => void;
  /** Which main view is showing; the router sets it. */
  readonly setMainView: (id: string, params?: Readonly<Record<string, string>>) => void;
}

const DEFAULT_ORDER = 100;

export const views = createRegistry<MainView>({
  key: (view) => view.id,
  shape: s.object({
    id: s.string(),
    component: s.component(),
    title: s.optional(s.string()),
  }),
});

export const overlays = createRegistry<ShellOverlay>({
  key: (overlay) => overlay.id,
  shape: s.object({ id: s.string(), component: s.component() }),
});

export const sidebarPanels = createRegistry<SidebarPanel>({
  key: (panel) => panel.id,
  order: (panel) => panel.order ?? DEFAULT_ORDER,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    component: s.component(),
    icon: s.optional(s.any()),
    order: s.optional(s.number()),
    defaultOpen: s.optional(s.boolean()),
    target: s.optional(s.object({ type: s.string(), id: s.optional(s.string()) })),
  }),
});

export const altbarPanels = createRegistry<AltbarPanel>({
  key: (panel) => panel.id,
  order: (panel) => panel.order ?? DEFAULT_ORDER,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    component: s.component(),
    icon: s.optional(s.any()),
    order: s.optional(s.number()),
    defaultOpen: s.optional(s.boolean()),
    when: s.optional(s.func()),
  }),
});

/**
 * The header seat. Each `setHeader` call adds one; the shell shows the most recent that
 * is still in place, so undoing the latest brings back the one it replaced.
 */
export const headers = createRegistry<{ readonly component: ShellHeaderComponent }>({
  shape: s.object({ component: s.component() }),
});

/** The footer seat: the bottom row, under the sidebar and main region. Same rules as `headers`. */
export const footers = createRegistry<{ readonly component: ShellFooterComponent }>({
  shape: s.object({ component: s.component() }),
});
