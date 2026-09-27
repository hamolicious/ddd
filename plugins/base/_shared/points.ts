/**
 * The base distribution's extension points: **names, payload types, and shape
 * validators, in one place**.
 *
 * This file is not part of `@kernel` and never will be. The kernel knows point
 * names only as opaque strings — it has no idea what a navbar or a document mode is
 * (SPEC §2) — and the moment it did, replacing `shell-ui` would mean a kernel change.
 * What the base distribution *does* need is for its sixteen plugins to agree on
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
  altbarPanel: "altbar.panel",
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
  editorPaste: "editor.paste",
  /** `settings` */
  settingsSection: "settings.section",
  /** `markdown` */
  markdownDirective: "markdown.directive",
  markdownFence: "markdown.fence",
  markdownRemark: "markdown.remark",
  markdownComponent: "markdown.component",
  markdownTaskState: "markdown.taskState",
  markdownAttachment: "markdown.attachment",
  /** `attachments` */
  attachmentViewer: "attachments.viewer",
  /** `slash-commands` */
  textSurface: "text.surface",
  slashCommand: "slash.command",
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

/** Which `main.view` is showing, and the route's params: what an altbar panel is about. */
export interface ShownView {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * A panel in the altbar: the column opposite the sidebar, about whatever the main view
 * is showing (a document's snapshots, its outline). The shell draws the ones whose
 * `when` accepts the current view; with none, the altbar and its toggle are absent.
 */
export interface AltbarPanel {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<{ readonly view: ShownView }>;
  readonly icon?: ReactNode;
  readonly order?: number;
  /** `true` ⇒ the panel starts expanded on first run. Default `true`. */
  readonly defaultOpen?: boolean;
  /** Whether this panel has anything to say about `view`. Default: every view. */
  readonly when?: (view: ShownView) => boolean;
}

export const altbarPanelShape: Shape<AltbarPanel> = s.object({
  id: s.string(),
  title: s.string(),
  component: s.component(),
  icon: s.optional(s.any()),
  order: s.optional(s.number()),
  defaultOpen: s.optional(s.boolean()),
  when: s.optional(s.func()),
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
 * One item in the top bar, placed in one of the header's two seats. `component` renders
 * it; `onSelect` is the shorthand for the common case (a button that runs a command).
 */
export interface NavbarItem {
  readonly id: string;
  readonly label: string;
  /** Any renderable node — an inline SVG, a character, a component's output. */
  readonly icon?: ReactNode;
  /** Sort within the seat; lower first. */
  readonly order?: number;
  /**
   * The seat: `start` sits after the sidebar toggle and grows (scrolling sideways when
   * full); `end` is pushed right and never shrinks. Default `start`.
   */
  readonly side?: "start" | "end";
  readonly onSelect?: () => void;
  /** Takes over rendering entirely (the notice bell, the sync pill). */
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
  /**
   * The mode's own rule for whether it applies to this document: `false` ⇒ it is not
   * offered — no tab, no place in the phone's switch, never chosen as the default. Any
   * condition the plugin likes (a mode that only handles attachments, one for documents
   * with a `fm.type`, one only for ones with machine sections). Asked again whenever the
   * row changes, so a mode appears and disappears as the document does; a `when` that
   * throws hides its mode and is reported. Absent ⇒ every document.
   */
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
  /**
   * Set when the document cannot be opened for editing (offline and never opened on
   * this device, say): the surface has already said why, in words. A mode that edits
   * shows the text read-only instead of waiting for a handle that is not coming.
   */
  readonly unavailable?: boolean;
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

/**
 * A paste and drop handler. The editor asks each one in `order` (default 100) when
 * something is pasted or dropped onto it, and the first to return `true` takes it: the
 * editor then does nothing with it. Returning `false` passes it on, and when nobody takes
 * it CodeMirror handles it as usual.
 *
 * `paste` must answer synchronously, since the browser's paste or drop has to be
 * cancelled in the same tick. Slow work (an upload) starts from here and finishes later through the
 * {@link EditorInsertion} it got from `insert`.
 */
export interface EditorPaste {
  readonly id: string;
  readonly order?: number;
  readonly paste: (event: EditorPasteEvent) => boolean;
}

export interface EditorPasteEvent {
  readonly documentId: DocumentId;
  /** A clipboard paste, or a drag dropped onto the text. */
  readonly via: "paste" | "drop";
  /** Files on the clipboard: a screenshot, or files copied in a file manager. */
  readonly files: readonly File[];
  /** The clipboard's plain text; empty when there is none. */
  readonly text: string;
  /**
   * Put text where it was going: a paste replaces the selection, a drop lands where it
   * was dropped. Every call inserts after the previous one, so several files land in the
   * order they were inserted.
   */
  insert(text: string): EditorInsertion;
}

/**
 * Text a paste handler put in, followed through later edits by this client and others.
 * It keeps working after the user leaves Edit mode: it is anchored to the document, not
 * to the editor.
 */
export interface EditorInsertion {
  /**
   * Swap the inserted text for `text`. Returns `false`, and changes nothing, when the
   * inserted text has since been edited or deleted: the user's change wins. Either this
   * or `remove` settles the insertion; later calls return `false`.
   */
  replace(text: string): boolean;
  /** Take the inserted text out again, under the same rule as `replace`. */
  remove(): boolean;
}

export const editorPasteShape: Shape<EditorPaste> = s.object({
  id: s.string(),
  order: s.optional(s.number()),
  paste: s.func(),
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

/**
 * What an embedded file (`![name](attachment://<ulid>)`) renders as. **The lowest `order`
 * wins**, and with none contributed `markdown` draws its own: an inline raster image, or
 * a chip. `attachments` contributes the one that hands the file to a viewer for its type.
 *
 * Also what `viewer` shows for a wrapper document, through `MarkdownApi.renderAttachment`,
 * with `placement: "page"`.
 */
export interface MarkdownAttachment {
  readonly id: string;
  readonly component: ComponentType<MarkdownAttachmentProps>;
  readonly order?: number;
}

export interface MarkdownAttachmentProps {
  /** The attachment's ULID. */
  readonly id: string;
  /** The embed's alt text, when it has one. */
  readonly alt?: string;
  /** `inline`: in the flow of a document. `page`: the whole view (a wrapper document). */
  readonly placement: "inline" | "page";
  /**
   * What `markdown` would have drawn. Render it when this renderer has nothing better:
   * no viewer for the type, or the file could not be loaded.
   */
  readonly fallback: ReactNode;
  /**
   * Wrap what this renderer draws in the caller's file actions (download, promote). Not
   * applied to `fallback`, which carries its own.
   */
  readonly frame: (content: ReactNode) => ReactNode;
}

export const markdownAttachmentShape: Shape<MarkdownAttachment> = s.object({
  id: s.string(),
  component: s.component(),
  order: s.optional(s.number()),
});

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

/**
 * A way of showing files of some types, by extension. Several viewers may claim one
 * extension: the lowest `order` shows it unless the user picked another in
 * Settings → Attachments.
 */
export interface AttachmentViewer {
  readonly id: string;
  /** Shown in Settings → Attachments when viewers compete for a type. */
  readonly label: string;
  /** Lower case, no dot: `["png", "jpg"]`. */
  readonly extensions: readonly string[];
  readonly component: ComponentType<AttachmentViewerProps>;
  readonly order?: number;
}

export interface AttachmentViewerProps {
  readonly file: {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
  };
  /** The bytes, already fetched over the session (bearer token or cookie alike). */
  readonly blob: Blob;
  /** An object URL for `blob`, owned by `attachments`: do not revoke it. */
  readonly url: string;
  readonly placement: "inline" | "page";
}

export const attachmentViewerShape: Shape<AttachmentViewer> = s.object({
  id: s.string(),
  label: s.string(),
  extensions: s.array(s.string()),
  component: s.component(),
  order: s.optional(s.number()),
});

// ---------------------------------------------------------------------------
// slash-commands
// ---------------------------------------------------------------------------

/**
 * A spot in a document to insert at later, anchored in the document rather than the
 * editor (`_shared/text-mark.ts`). Each insert lands after the previous one.
 */
export interface TextMark {
  insert(text: string): EditorInsertion;
}

/**
 * An editor, as the slash menu (and anything else that works at the caret) sees it.
 * **Editor-neutral on purpose**: `editor` (CodeMirror) and `alt-editor` (a textarea) both
 * contribute one while mounted and dispose it on unmount, so the menu works in either.
 */
export interface TextSurface {
  /** Unique per mounted editor. */
  readonly id: string;
  readonly documentId: DocumentId;
  /** Where keys arrive. Listeners here, in the capture phase, run before the editor's. */
  readonly element: HTMLElement;
  hasFocus(): boolean;
  focus(): void;
  /** The caret's line, from its start up to the caret. */
  textBeforeCaret(): string;
  /** The caret on screen, for placing a popup; `null` when it is not visible. */
  caretRect(): { readonly left: number; readonly top: number; readonly bottom: number } | null;
  /** Delete `length` characters before the caret, and mark the spot they were in. */
  takeBeforeCaret(length: number): TextMark;
  /** Fires after every change to the text, the caret or focus. */
  subscribe(listener: () => void): () => void;
}

export const textSurfaceShape: Shape<TextSurface> = s.object({
  id: s.string(),
  documentId: s.string(),
  element: s.any(),
  hasFocus: s.func(),
  focus: s.func(),
  textBeforeCaret: s.func(),
  caretRect: s.func(),
  takeBeforeCaret: s.func(),
  subscribe: s.func(),
});

/** One entry in the `/` menu. Typing `/att` lists the commands whose title or keywords start with it. */
export interface SlashCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  /** Other words it is found by. */
  readonly keywords?: readonly string[];
  /** Position in the menu with nothing typed; default 100. */
  readonly order?: number;
  /** `false` ⇒ not offered in this document. */
  readonly when?: (context: { readonly documentId: DocumentId }) => boolean;
  /**
   * Called with the typed `/command` already removed. Runs inside the key press or tap
   * that chose it, so it may open a file picker or anything else that needs a user
   * gesture.
   */
  readonly run: (context: SlashCommandContext) => void;
}

export interface SlashCommandContext {
  readonly documentId: DocumentId;
  /** Where the `/command` was: insert here, now or after something slow. */
  readonly mark: TextMark;
  /** Give the editor its focus back. */
  focus(): void;
}

export const slashCommandShape: Shape<SlashCommand> = s.object({
  id: s.string(),
  title: s.string(),
  description: s.optional(s.string()),
  icon: s.optional(s.any()),
  keywords: s.optional(s.array(s.string())),
  order: s.optional(s.number()),
  when: s.optional(s.func()),
  run: s.func(),
});
