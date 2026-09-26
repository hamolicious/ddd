/**
 * The base distribution's extension points: **names, payload types, and shape
 * validators, in one place**.
 *
 * This file is not part of `@kernel` and never will be. The kernel knows point
 * names only as opaque strings — it has no idea what a navbar or a document mode is
 * (SPEC §2) — and the moment it did, replacing `shell-ui` would mean a kernel change.
 * What the base distribution *does* need is for its fourteen plugins to agree on
 * these shapes without importing each other, which is exactly what a shared
 * declaration file is for.
 *
 * A third-party plugin contributing to `navbar.item` can copy the type from here, or
 * simply pass an object with the right fields — the runtime validation is the
 * contract, the TypeScript type is a convenience.
 *
 * **FROZEN for M3** (`web/CONTRACTS.md` lists the owners). Adding an optional field
 * is allowed and announced; renaming a point or making a field required is not.
 */

import { s, type Shape } from "@kernel";
import type { ComponentType, ReactNode } from "react";
import type { Extension } from "@codemirror/state";
import type { DocumentId, DocumentRow, OpenDocument, SearchHit } from "@kernel";

/** Every point name in the base distribution, grouped by its owner. */
export const POINTS = {
  /** `shell-ui` */
  shellHeader: "shell.header",
  shellOverlay: "shell.overlay",
  sidebarPanel: "sidebar.panel",
  mainView: "main.view",
  /** `header` */
  navbarItem: "navbar.item",
  /** `router` */
  route: "router.route",
  /** `commands` */
  command: "commands.command",
  keybinding: "keybindings.default",
  /** `themes` */
  theme: "themes.theme",
  /** `search` */
  searchProvider: "search.provider",
  /** `document-surface` */
  documentMode: "document.mode",
  /** `editor` */
  editorExtension: "editor.extension",
  /** `settings` */
  settingsSection: "settings.section",
  /** `markdown` */
  markdownDirective: "markdown.directive",
  markdownFence: "markdown.fence",
  markdownRemark: "markdown.remark",
  markdownComponent: "markdown.component",
  markdownTaskState: "markdown.taskState",
} as const;

// ---------------------------------------------------------------------------
// shell-ui
// ---------------------------------------------------------------------------

/**
 * The spot above the sidebar and main region. The shell renders one contribution here:
 * the lowest `order` wins, so a replacement header only has to undercut the base one
 * (which uses the default, 100). The component owns its whole row, `<header>` included.
 */
export interface ShellHeader {
  readonly id: string;
  readonly component: ComponentType<Record<string, never>>;
  /** Lower wins; default 100. */
  readonly order?: number;
}

export const shellHeaderShape: Shape<ShellHeader> = s.object({
  id: s.string(),
  component: s.component(),
  order: s.optional(s.number()),
});

/**
 * A component that is always mounted, outside the header, sidebar and main region: a
 * command palette, a toast stack, a sheet. `shell-ui` holds the only
 * `kernel.ui.mount` (SPEC §6.4), so this is how a plugin gets a persistent React
 * presence that is not part of the layout. It should render nothing until it has
 * something to show, and anything modal should portal or position itself.
 */
export interface ShellOverlay {
  readonly id: string;
  readonly component: ComponentType<Record<string, never>>;
}

export const shellOverlayShape: Shape<ShellOverlay> = s.object({
  id: s.string(),
  component: s.component(),
});

/** A panel in the sidebar (folders, tags, outline). Collapsible, orderable. */
export interface SidebarPanel {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<Record<string, never>>;
  readonly icon?: ReactNode;
  readonly order?: number;
  /** `true` ⇒ the panel starts open on first run. */
  readonly defaultOpen?: boolean;
}

export const sidebarPanelShape: Shape<SidebarPanel> = s.object({
  id: s.string(),
  title: s.string(),
  component: s.component(),
  icon: s.optional(s.any()),
  order: s.optional(s.number()),
  defaultOpen: s.optional(s.boolean()),
});

/**
 * A full-pane view, addressed by id. `router.route` maps a URL to one of these, so a
 * view and its URL are contributed independently — a view can be opened by the
 * router, by a command, or in a split.
 */
export interface MainView {
  readonly id: string;
  readonly component: ComponentType<{ readonly params?: Readonly<Record<string, string>> }>;
  /** Shown in window/tab titles. */
  readonly title?: string;
}

export const mainViewShape: Shape<MainView> = s.object({
  id: s.string(),
  component: s.component(),
  title: s.optional(s.string()),
});

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

/**
 * One item in the navigation bar. `component` renders it; `onSelect` is the
 * shorthand for the common case (a button that runs a command).
 */
export interface NavbarItem {
  readonly id: string;
  readonly label: string;
  /** Any renderable node — an inline SVG, a character, a component's output. */
  readonly icon?: ReactNode;
  readonly order?: number;
  /** Placement hint; the shell decides what it can honour. */
  readonly side?: "start" | "end";
  readonly onSelect?: () => void;
  /** Takes over rendering entirely (a sync indicator, a search box). */
  readonly component?: ComponentType<Record<string, never>>;
}

export const navbarItemShape: Shape<NavbarItem> = s.object({
  id: s.string(),
  label: s.string(),
  icon: s.optional(s.any()),
  order: s.optional(s.number()),
  side: s.optional(s.literal("start", "end")),
  onSelect: s.optional(s.func()),
  component: s.optional(s.component()),
});

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

/**
 * One route. `path` is a pattern with `:name` segments (`/doc/:id`); matches are
 * passed to the view as `params`. Hash-based, so the app works from `file://` in the
 * Flutter shell (SPEC §7) with no server rewrites.
 */
export interface Route {
  readonly path: string;
  /** The `main.view` id to render. */
  readonly view: string;
  /** Lower numbers match first; default 100. */
  readonly order?: number;
}

export const routeShape: Shape<Route> = s.object({
  path: s.string(),
  view: s.string(),
  order: s.optional(s.number()),
});

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/** A command: one id, one title, one function. The palette lists them; keybindings run them. */
export interface Command {
  readonly id: string;
  readonly title: string;
  readonly run: (argument?: unknown) => void | Promise<void>;
  /** Grouping in the palette. */
  readonly category?: string;
  readonly icon?: ReactNode;
  /** Return `false` to hide/disable the command in the current context. */
  readonly when?: () => boolean;
}

export const commandShape: Shape<Command> = s.object({
  id: s.string(),
  title: s.string(),
  run: s.func(),
  category: s.optional(s.string()),
  icon: s.optional(s.any()),
  when: s.optional(s.func()),
});

/**
 * A *suggested* default binding (SPEC §6.5). The user's own configuration wins;
 * between plugins, **first registration wins** and conflicts are listed rather than
 * silently resolved.
 *
 * `keys` is a chord in the canonical spelling: `Mod+K` (`Mod` = Cmd on Apple, Ctrl
 * elsewhere), `Shift+Alt+F`, or a sequence like `g d`.
 */
export interface KeybindingDefault {
  readonly command: string;
  readonly keys: string;
  readonly when?: string;
}

export const keybindingDefaultShape: Shape<KeybindingDefault> = s.object({
  command: s.string(),
  keys: s.string(),
  when: s.optional(s.string()),
});

// ---------------------------------------------------------------------------
// themes
// ---------------------------------------------------------------------------

/**
 * A theme: token overrides on top of the kernel defaults (SPEC §6.5 — `themes`
 * *overrides*, it does not own the palette). A theme need only name the tokens it
 * changes; everything else stays legible.
 */
export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly scheme: "light" | "dark";
  /** Partial `ThemeTokens`: token name → CSS value. */
  readonly tokens: Readonly<Record<string, string>>;
}

export const themeShape: Shape<Theme> = s.object({
  id: s.string(),
  name: s.string(),
  scheme: s.literal("light", "dark"),
  tokens: s.record(s.string()),
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * A search backend. The **default provider is the local index** (SPEC §6.5); a
 * server provider exists as a fallback and for integrations, and a plugin may add
 * its own (a semantic index, an external wiki).
 */
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  /** Lower runs first; the local index is 0. */
  readonly order?: number;
  search(
    query: string,
    options: { readonly limit?: number; readonly includeDeleted?: boolean },
  ): Promise<readonly SearchHit[]>;
}

export const searchProviderShape: Shape<SearchProvider> = s.object({
  id: s.string(),
  label: s.string(),
  order: s.optional(s.number()),
  search: s.func(),
});

// ---------------------------------------------------------------------------
// document-surface
// ---------------------------------------------------------------------------

/**
 * A way of showing one document. `viewer` (read) and `editor` (edit) are **symmetric
 * contributions** (SPEC §6.5): the surface owns the route and the mode registry, and
 * has no built-in favourite.
 */
export interface DocumentMode {
  readonly id: string;
  readonly label: string;
  readonly component: ComponentType<DocumentModeProps>;
  readonly icon?: ReactNode;
  readonly order?: number;
  /** `false` ⇒ hidden for this document (a mode that only handles attachments). */
  readonly when?: (row: DocumentRow) => boolean;
}

export interface DocumentModeProps {
  readonly id: DocumentId;
  readonly row: DocumentRow;
  /** Present once hydrated; read modes can render from `row.content` alone. */
  readonly open?: OpenDocument;
  /**
   * A **1-based line** the mode should reveal: `#/doc/<id>?line=42`.
   *
   * Optional and additive. The surface parses the query and hands the number over
   * rather than each mode re-reading the URL, because the surface is the thing that
   * knows when the document actually arrived — a mode that read `location.hash` on
   * mount would scroll before the text existed.
   *
   * Honouring it is *best effort and a mode's own business*: `editor` puts the cursor
   * on the line and scrolls it into view, a rendered mode has no lines to scroll to and
   * may ignore it entirely. A number past the end of the document is clamped, never an
   * error. It is a deep link, not a state: a mode must render correctly without it.
   */
  readonly line?: number;
}

export const documentModeShape: Shape<DocumentMode> = s.object({
  id: s.string(),
  label: s.string(),
  component: s.component(),
  icon: s.optional(s.any()),
  order: s.optional(s.number()),
  when: s.optional(s.func()),
});

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------

/**
 * A CodeMirror 6 extension. This is the point that pins the runtime layer: a
 * contribution here is a `@codemirror/state` `Extension` from the *shared* copy, so
 * replacing `editor` means another CodeMirror-based editor (SPEC §6.4, risk 6).
 *
 * A plugin that adds markdown syntax should pair its renderer contribution with an
 * extension here, or the syntax is invisible while editing (SPEC §6.6).
 */
export interface EditorExtension {
  readonly id: string;
  readonly extension: Extension;
  readonly order?: number;
}

export const editorExtensionShape: Shape<EditorExtension> = s.object({
  id: s.string(),
  extension: s.any(),
  order: s.optional(s.number()),
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** One section of the settings screen. */
export interface SettingsSection {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<Record<string, never>>;
  readonly order?: number;
  readonly description?: string;
}

export const settingsSectionShape: Shape<SettingsSection> = s.object({
  id: s.string(),
  title: s.string(),
  component: s.component(),
  order: s.optional(s.number()),
  description: s.optional(s.string()),
});

// ---------------------------------------------------------------------------
// markdown (SPEC §6.6)
// ---------------------------------------------------------------------------

/**
 * A directive: `:::name` (container), `::name` (leaf), `:name[text]{attrs}` (inline).
 * Directives and fences are the **blessed syntaxes** — named, collision-free, and
 * they degrade to literal text when the plugin is absent.
 */
export interface MarkdownDirective {
  readonly name: string;
  readonly kind: "container" | "leaf" | "text";
  readonly component: ComponentType<MarkdownDirectiveProps>;
}

export interface MarkdownDirectiveProps {
  readonly attributes: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly children?: ReactNode;
  readonly documentId?: DocumentId;
}

export const markdownDirectiveShape: Shape<MarkdownDirective> = s.object({
  name: s.string(),
  kind: s.literal("container", "leaf", "text"),
  component: s.component(),
});

/** A renderer for a fenced code block of one language (```mermaid, ```chart). */
export interface MarkdownFence {
  readonly language: string;
  readonly component: ComponentType<MarkdownFenceProps>;
}

export interface MarkdownFenceProps {
  readonly code: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}

export const markdownFenceShape: Shape<MarkdownFence> = s.object({
  language: s.string(),
  component: s.component(),
});

/**
 * A raw remark/unified plugin — **the escalated path** (SPEC §6.6). It can change
 * the meaning of the whole document, so it is the last resort, not the first.
 */
export interface MarkdownRemark {
  readonly id: string;
  /** A unified `Pluggable`; typed loosely so the point does not pin unified's types. */
  readonly plugin: unknown;
  readonly options?: unknown;
  readonly order?: number;
}

export const markdownRemarkShape: Shape<MarkdownRemark> = s.object({
  id: s.string(),
  plugin: s.any(),
  options: s.optional(s.any()),
  order: s.optional(s.number()),
});

/** Override the React component for one mdast node type (`link`, `heading`, `table`). */
export interface MarkdownComponent {
  readonly node: string;
  readonly component: ComponentType<Record<string, unknown>>;
  readonly order?: number;
}

export const markdownComponentShape: Shape<MarkdownComponent> = s.object({
  node: s.string(),
  component: s.component(),
  order: s.optional(s.number()),
});

/**
 * A task marker (SPEC §6.6). `[ ]` and `[x]` are default contributions from
 * `markdown` itself; a plugin may add `[/]`, `[-]`, `[?]`.
 *
 * Documented consequence: marker semantics come from the *client* registry, so a
 * client without the contributing plugin renders the marker as literal text and can
 * count tasks differently. Moot while every client shares one plugin set.
 */
export interface MarkdownTaskState {
  /** The single character inside the brackets; `" "` for unchecked. */
  readonly marker: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Position in the right-click / long-press state menu. */
  readonly order?: number;
  /** `true` ⇒ counts as completed. */
  readonly done?: boolean;
}

export const markdownTaskStateShape: Shape<MarkdownTaskState> = s.object({
  marker: s.string(),
  label: s.string(),
  icon: s.any(),
  order: s.optional(s.number()),
  done: s.optional(s.boolean()),
});
