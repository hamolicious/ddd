import type { ComponentType, ReactNode } from "react";

import { createRegistry, s, type Unsubscribe } from "@kernel";

export interface ShownView {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface MainView {
  readonly id: string;
  readonly component: ComponentType<{ readonly params?: Readonly<Record<string, string>> }>;
  readonly title?: string;
}

export interface ShellOverlay {
  readonly id: string;
  readonly component: ComponentType<Record<string, never>>;
}

export interface SidebarPanel {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<Record<string, never>>;
  readonly icon?: ReactNode;
  readonly order?: number;
  readonly defaultOpen?: boolean;
  readonly target?: {
    readonly type: string;
    readonly id?: string;
  };
}

export interface AltbarPanel {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<{ readonly view: ShownView }>;
  readonly icon?: ReactNode;
  readonly order?: number;
  readonly defaultOpen?: boolean;
  readonly when?: (view: ShownView) => boolean;
}

export type ShellHeaderComponent = ComponentType<Record<string, never>>;

export type ShellFooterComponent = ComponentType<Record<string, never>>;

export interface ShellLayout {
  readonly compact: boolean;
  readonly sidebarOpen: boolean;
  readonly hasSidebar: boolean;
  readonly altbarOpen: boolean;
  readonly hasAltbar: boolean;
}

export interface Shell {
  readonly isCompact: () => boolean;
  readonly onLayoutChange: (listener: (compact: boolean) => void) => Unsubscribe;
  readonly layout: () => ShellLayout;
  readonly subscribeLayout: (listener: () => void) => Unsubscribe;
  readonly sidebarId: string;
  readonly toggleSidebar: (open?: boolean) => void;
  readonly altbarId: string;
  readonly toggleAltbar: (open?: boolean) => void;
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

export const headers = createRegistry<{ readonly component: ShellHeaderComponent }>({
  shape: s.object({ component: s.component() }),
});

export const footers = createRegistry<{ readonly component: ShellFooterComponent }>({
  shape: s.object({ component: s.component() }),
});
