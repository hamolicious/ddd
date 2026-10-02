# `plugins/base/` — the base distribution

The visible app: 38 plugins that ship with the server. They are
[installed like any other plugin](../../SPEC.md#62-package-manifest-capabilities), can each be
replaced or removed, and get no privilege the kernel does not give every plugin.

This directory is also the reference for writing a plugin. To scaffold a new standalone
plugin project, use the `ddd` CLI (`ddd plugin new`, see [`cli/`](../../cli/README.md)).

## Layout

```
<id>/manifest.json                id, version, kernel range, `dependencies`, `optionalDependencies`
<id>/src/index.tsx                `activate(kernel)`, plus the named exports other plugins
                                  import as `plugin:<id>`
<id>/src/style.css                linked on activation; classes prefixed per plugin
_shared/                          helpers several plugins compile in (see below)
_shared/vite.plugin-config.mjs    the reference build config
_shared/vite.config.example.mjs   how a standalone plugin uses it
_shared/vite.config.tailwind.example.mjs  the same, with Tailwind
dist/<id>/<version>/              build output, in the installed layout the server serves;
                                  includes `frontend/index.d.ts` with the exports' types
```

## The plugins

| Plugin | Responsibility | Exports (`plugin:<id>`) |
|---|---|---|
| `shell-ui` | layout, mobile breakpoint, a spot for the top bar and one for the bottom bar, the altbar opposite the sidebar, always-mounted overlays | `addView`, `addOverlay`, `addSidebarPanel`, `addAltbarPanel`, `setHeader`, `setFooter`, `toggleSidebar`, `toggleAltbar`, `layout`… |
| `toolbar` | the top and bottom bars: header and status footer on desktop, a thin top bar and a bottom icon toolbar on a phone; items pick a bar and side (`bar`, `side`, `mobile`); Settings → Toolbar has a per-device layout | `addItem` |
| `context-menu` | menus, sheets and modals: a popover beside a button, a bottom sheet on a phone; `modal` and `confirm`. Also the right-click / long-press / menu-key menu for anything marked with a target type (`data-ddd-target`, `_shared/target.ts`), built from every plugin's actions for that type. Plugins never draw a menu of their own | `addAction`, `open`, `modal`, `confirm`… |
| `notices` | the notice bell in the top bar | — |
| `sync-status` | the sync pill in the top bar | — |
| `router` | URL ↔ view (hash-based) | `addRoute`, `navigate`, `Link`, `href`… |
| `commands` | command registry, palette, keybindings; draws each command's `icon` through `icons` when present | `addCommand`, `addKeybinding`, `run`, `list`, `openPalette`… |
| `themes` | theme registry and picker; overrides kernel tokens | `addTheme`, `select`… |
| `doc-list` | the all-documents page (`table`'s `TablePage`, with search and columns in the URL), new document, Trash | `createDocument`, `newDocument` |
| `search` | search for every view: providers (local index first, then the server), a search as one query string (text, filter, sort), live and one-shot resolution, the `SearchShell` controls, and `SavedSearch` for saved-search notes ("Update saved search"); an Actions button over the results | `addProvider`, `useResults`, `resolve`, `SearchShell`, `SavedSearch`… |
| `table` | a saved search as a table (`type: table`, or no type): title plus chosen columns, paged rows, a "Match" column; "New table" | `TablePage`, `save` |
| `kanban` | a saved search as a board (`type: kanban`): columns from a field (`fm.status` by default). Dragging a card or "Move to" sets the field, records when it entered the column (`<field>-since`), and its rank in the card's `%%% kanban` section (or follows the search's sort). Cards show their title, any property, or the rendered body (ticking a task writes to the note). Filter bar, optional swimlanes (`lanes`), a **+** per column and lane. "New board" makes one note that is a saved search of its own children | — |
| `calendar` | a saved search as a month calendar (`type: calendar`), dated by a chosen field, optionally to an end field; "New calendar" | — |
| `timeline` | a saved search on a time axis (`type: timeline`): start and optional end fields, optional lanes, days/weeks/months; "New timeline" | — |
| `folders` | drag-and-drop tree of notes (see [The folder tree](#the-folder-tree)); context actions New note inside, New search inside, Duplicate, Copy, Paste inside, Rename, Move to…, Delete; Duplicate / Copy / Paste note as commands (copies the note without its children; the clipboard is in-app) | `addDecoration`, `file`, `fileNew`, `parentOf`, `childrenOf`, `look`… |
| `folder-style` | a background colour and icon for any note in the tree ("Color and icon…"), text colour by contrast; defaults and rules in Settings; a note's own look always wins; per user | — |
| `local-folder` | mirrors every note as a Markdown file in a folder on this device (`kernel.capabilities.folder`), both ways, while the app runs; asks once in the desktop shell, offered in Settings in Chromium browsers | — |
| `auto-fm` | adds the frontmatter properties listed in Settings to notes you create (or also edit) on this device, only where the key is missing; can be limited by conditions; values may use `{{date}}`, `{{time}}`, `{{now}}`; per user, client-side, works offline | — |
| `icons` | the Tabler icon set, packed at build time from a pinned npm tarball and fetched one shard at a time | `Icon`, `Picker`, `search`, `has` |
| `markdown` | the unified/remark → React pipeline | `addDirective`, `addFence`, `addCodeBlockRenderer`, `addRemarkPlugin`, `addComponent`, `addTaskState`, `addAttachmentRenderer`, `render`… |
| `attachments` | paste-to-upload in the editor; shows embedded files through a viewer per file type; resumable `upload` | `addViewer`, `upload` |
| `native-preview` | viewers for what a browser shows natively: images, PDF, audio, video, text | — |
| `slash-commands` | the `/` menu in any editor | `addSlashCommand` |
| `document-surface` | the document route and mode registry | `addMode`, `currentDocument`, `setMode`… |
| `viewer` | read mode, with child notes listed under the note (when `folders` is present), and the file page (`#/file/<id>`) | — (adds the `read` mode) |
| `editor` | edit mode (CodeMirror 6 + `y-codemirror.next`) | `addExtension`, `addPasteHandler`, `addSurface`, `surfaces`, `focus` |
| `changes` | the open document's history in the altbar: changes and snapshots, view, revert, restore | — |
| `syntax-highlight` | fenced code highlighted with tree-sitter in read mode and the editor; install catalog languages as needed, or upload a grammar + `highlights.scm` | `addLanguage` |
| `wikilinks` | `[[` links a note and `![[` embeds one, stored as ordinary `doc://` links (also in frontmatter); the editor shows each linked note's title | — |
| `emoji` | `:tada:` renders as 🎉 (GitHub's gemoji set, packed at build time); typing `:ta` suggests shortcodes | — |
| `fm-autocomplete` | suggests frontmatter keys in use, then the key's values, from `indexer` | — |
| `indexer` | workspace stats, every frontmatter field and its values, each note's incoming and outgoing links; rebuilt locally on every edit | `fmFields`, `fmValues`, `documents`, `connections`, `stats`, `subscribe`… |
| `doc-events` | "a note was just made": note-creating views call `notifyCreated`, the folder tree listens with `onCreated` | `notifyCreated`, `onCreated` |
| `graph` | notes and their links as a live force-directed graph: the whole workspace at `#/graph`, the open note's neighbourhood in the altbar | — |
| `settings` | the settings shell | `addSection`, `open` |
| `admin` | users, invites, audit log, plugins (with dependencies, dependents and `provides` conflicts) | `open`, `isAdmin` |
| `db-health` | Settings → Database health, for admins: orphan files, duplicate files and notes with each copy's reference count | — |
| `welcome` | fills a new, empty workspace with a short tour, one note per base feature | — |

Every base plugin is frontend-only. Plugins can also have a `backend.wasm` half; see
`plugins/examples/hello-backend` and `mise run wasm-plugins`.

### Saved searches and their views

A saved search is a note with `saved-search:` in its frontmatter. Its `type` picks the
views, each shown as a tab beside Read and Edit:

```yaml
saved-search: where=…
type: kanban              # one view
type: [kanban, calendar]  # several: a tab each, opens in the first
```

| `type` | Plugin | Settings kept in |
|---|---|---|
| `table` (or none) | `table` | `%%% table` |
| `kanban` | `kanban` | `%%% kanban` |
| `calendar` | `calendar` | `%%% calendar` |
| `timeline` | `timeline` | `%%% timeline` |

- Create one from the palette ("New board", "New table", …) or the folder tree ("New board inside", "… at the root"). It starts as a search for the notes inside it.
- View settings (the View panel, or on the board itself) save immediately. The search itself changes only on "Update saved search".
- A view plugin is a `document-surface` mode that answers to its type and renders inside `search`'s `SavedSearch` (`_shared/saved-view-mode.tsx`).

## How the base plugins relate

An arrow means **"imports"**: solid for a dependency, dotted for an optional one. Every
plugin also uses `@kernel` (not drawn). The **frame** (`shell-ui`, `router`,
`context-menu`, `settings`, `commands`) is drawn with its own arrows only, since nearly
everything depends on it; `doc-events` is also left out.

```mermaid
flowchart TD
    subgraph frame ["frame"]
        router --> shell-ui
        context-menu --> shell-ui
        settings --> router & shell-ui
        commands --> settings & shell-ui
        commands -.-> icons & toolbar
    end

    subgraph bar ["bars"]
        toolbar -.-> icons
        notices --> toolbar
        sync-status --> toolbar
        admin --> toolbar
        admin -.-> icons
    end

    subgraph documents ["document experience"]
        editor --> document-surface
        viewer --> document-surface & markdown
        viewer -.-> folders
        markdown -.-> document-surface & folders
        slash-commands --> editor
        attachments --> editor & markdown & slash-commands
        attachments -.-> folders
        native-preview --> attachments
        syntax-highlight --> editor & markdown
        emoji --> editor & markdown
        wikilinks --> editor & indexer
        fm-autocomplete --> editor & indexer
        changes --> markdown
    end

    subgraph browse ["browse & find"]
        search --> indexer
        search -.-> icons
        table --> search & document-surface
        timeline --> search & document-surface
        calendar --> search & document-surface
        calendar -.-> folders
        kanban --> search & document-surface & markdown
        kanban -.-> folders
        doc-list --> search & table
        folders --> doc-list
        folders -.-> search
        folder-style --> folders & indexer
        folder-style -.-> icons & search
        graph --> indexer & toolbar
    end

    auto-fm --> indexer
    auto-fm -.-> search
    local-folder -.-> folders & attachments
    welcome -.-> folders
```

`themes` and `db-health` depend on the frame only.

The loader activates a plugin after everything it points at. A plugin whose required
dependency is missing, out of range or failed is skipped, and so is everything that
requires it. Activation order (each row depends only on rows above it):

| | |
|---|---|
| 0 | `shell-ui`, `icons`, `indexer`, `doc-events` |
| 1 | `router`, `context-menu` |
| 2 | `settings` |
| 3 | `toolbar` |
| 4 | `commands`, `notices`, `sync-status` |
| 5 | `document-surface`, `search`, `themes`, `graph`, `admin`, `db-health` |
| 6 | `editor`, `table`, `timeline`, `auto-fm` |
| 7 | `doc-list`, `slash-commands`, `fm-autocomplete`, `wikilinks` |
| 8 | `folders` |
| 9 | `markdown`, `calendar`, `folder-style`, `welcome` |
| 10 | `viewer`, `kanban`, `attachments`, `syntax-highlight`, `emoji`, `changes` |
| 11 | `native-preview`, `local-folder` |

**The contributor depends on the host.** `toolbar` knows nothing of `notices` or `graph`;
they import its `addItem`. `editor` and `viewer` are modes added to `document-surface`;
`markdown` takes renderers from `emoji`, `syntax-highlight` and `attachments`; `editor`
publishes text surfaces that `slash-commands`, `fm-autocomplete`, `wikilinks` and `emoji`
read. Disabling a contributor removes its own feature and nothing else.

The one message going the other way is **"a note was just made"**: views that create notes
(`doc-list`, `search`, `table`, `calendar`, `kanban`, `timeline`) call `doc-events`'
`notifyCreated` with a `parent` hint, and `folders` files the note from `onCreated`.
`doc-events` has no dependencies, which avoids a cycle (`folders` already depends on
`doc-list`). Row colours and icons reach the tree through `folders`' `addDecoration`, so
`folders` never needs to know `folder-style` exists.

**Replacing a plugin** means exporting what its dependents import: the stand-in declares
`"provides": "<id>@<version>"`, dependents' ranges are checked against that version, and
only one of the two can be enabled (see `plugins/examples/alt-editor`).

## Dependencies and exports

A plugin's API is its **named exports** from `src/index.tsx`. Another plugin imports them
by id and declares that id in its manifest:

```ts
import { addItem } from "plugin:toolbar";          // "dependencies": { "toolbar": "^1.0" }
const folders = await kernel.plugins.optional<typeof import("plugin:folders")>("folders");
                                                   // "optionalDependencies": { "folders": "^4.0" }
```

- **A static `plugin:` import is a required dependency.** Reach an optional one only
  through `kernel.plugins.optional(id)` (returns `undefined` when inactive); a static
  import of an absent plugin fails the whole module.
- **Hosts take contributions through a registry.** Keep a `createRegistry` (from `@kernel`)
  at module scope and export its `add` as `addX`, which returns a remover. It must be at
  module scope because dependents call `addX` from their own `activate`. Render the items
  with `useRegistry` and `bounded` from `_shared/boundary.tsx`, so a component that throws
  is reported against the plugin that added it (e.g. `toolbar.item`).
- **Events are exports too:** `onX(listener) → unsubscribe` and `notifyX(payload)`.
- **Validation is opt-in.** A registry can take a `shape`, and an exported function can be
  wrapped in `checked(s.fn([…], ret?), impl)`; a mismatch throws `ContractViolationError`
  at the caller.
- **No cycles**, and `_shared` files count: if a `_shared` file imports a type from
  `plugin:x`, every plugin that compiles that file in must list `x` in `dependencies`.

In this repository `plugin:*` resolves to `plugins/base/*/src/index.tsx` (tsconfig and
vitest). At runtime the server's import map resolves it to the enabled plugin's
`frontend/index.mjs`. Check the graph with:

```bash
cd web && npm run check:plugins     # also part of `mise run web-check`
```

It fails on a missing or out-of-range dependency, a cycle, a `plugin:` import (including
type-only ones and those reached through `_shared`) not listed in `dependencies`, and a
static import of an optional dependency.

## Machine-owned documents

`doc-list`, `folders` and `search` hide any document with `machine: true` in its
frontmatter (mainly the kernel's per-user settings documents). The rule lives in one place,
`_shared/machine-docs.ts`, so the three agree.

- It is a convention between these plugins, not a kernel concept. The server, the local
  index and `kernel.documents` return these documents as usual, and they stay readable,
  editable and linkable.
- `doc-list`'s filter bar and `search`'s results page have a toggle to show them.
  `folders` has none.
- A plugin that wants machine-owned documents of its own just sets `machine: true`.
- **Hiding is not protection.** `folders` can be asked to write from places that never ran
  the filtered query (a URL, a drop's `text/plain`, its exported `file`), so it checks the
  stored frontmatter before every write (`refuseMachine`). Any new write path in `folders`
  must do the same; `EXCLUDE_MACHINE_DOCUMENTS` on a subscription is not enough.

## `_shared/`

Code several base plugins compile in because they must agree exactly — a rule each runs
itself rather than a value one plugin hands another. Among them:

- **`machine-docs.ts`** — what to hide (above).
- **`fm-display.ts`** — what kind of thing an `fm` value is (`inferKind`, `isDateKey`,
  `PREFERRED_KEY_ORDER`) and how to display it (`fmDisplayRows`, `formatDateValue`). Used
  by `viewer`'s properties header and `indexer`'s field types.
- **`regions.ts`** — where the frontmatter, body and `%%%` sections are in a text, so
  `markdown` and `indexer` agree on what counts as body (otherwise backlinks go missing).
  `editor` has its own copy.
- **`compact.ts`** — the phone breakpoint and the hooks that read it.
- **`boundary.tsx`** — `useRegistry` and `bounded`, for drawing contributed components.

Types that plugins pass to each other (registry items, service functions) are exported by
the owning plugin and imported from `plugin:<id>`. A `_shared` file may import them too;
`check:plugins` follows relative imports to make sure the compiling plugin declares the
dependency.

## The folder tree

A folder is a note. Its children are listed, in order, in its own `%%% folders` section
under `children`, one id per line. Any note can hold children; a note nobody lists is at
the root.

- **Every move is a list splice** (`kernel.documents.splice.sectionList`): one line added
  to the new parent, one removed from the old; the moved note is not written. This lets two
  devices file notes into one folder at once without conflicts.
- The new parent is written first, so an interrupted move leaves a note in two lists (drawn
  once, under the parent with the smaller id, and fixed by its next move) rather than none.
  A loop is cut at its smallest id so nothing disappears.
- Per user, in settings: collapsed notes, root order (`rootOrder`), and where new notes and
  files go ("New notes go to", "Files go to").
- Everything you can do by drag is also available via long-press, right-click, the row's
  `⋯`, or `M`, because HTML5 drag and drop does not fire from touch.

## Building

```bash
mise run plugins                                           # all, into plugins/base/dist
cd web && node scripts/build-plugins.mjs editor markdown   # only these
cd web && npm run check:plugins                            # dependency graph
mise run web-check                                         # typecheck + unit tests
```

- The build runs from `web/`, where `vite` and the type declarations live. There is no
  `node_modules` in this directory and none is needed.
- Each plugin becomes one ES module with the runtime layer (`react`, `yjs`, `@kernel`, the
  CodeMirror and remark families) and every `plugin:<id>` **externalized**; they resolve
  through the server's import map. Never bundle them: a plugin with its own React breaks
  hooks and context across the boundary, and one that bundles another plugin gets a second
  copy of its registries.
- Next to the module the build writes `frontend/index.d.ts`, the exports' types as
  `declare module "plugin:<id>"`.
- `mise run plugin-package <id>` packages a built plugin as an installable `.zip`.

## Writing one

Two plugins: `shelf` hosts a list other plugins add to; `hello` adds to it and puts a
button in the top bar.

```json
{ "id": "shelf", "version": "1.0.0", "kernel": "^3.0",
  "frontend": { "module": "frontend/index.mjs" } }
```

```tsx
// shelf/src/index.tsx
import type { Kernel } from "@kernel";
import { createRegistry } from "@kernel";

export interface ShelfItem { readonly id: string; readonly title: string; readonly order?: number }

const items = createRegistry<ShelfItem>({ key: (i) => i.id, order: (i) => i.order ?? 100 });

/** Put an item (or several) on the shelf. Returns the function that takes it off again. */
export const addItem = items.add;
export const list = (): readonly ShelfItem[] => items.get();

export default function activate(kernel: Kernel): void {
  items.subscribe((all) => kernel.log.info(`${all.length} on the shelf`));
}
```

```json
{ "id": "hello", "version": "1.0.0", "kernel": "^3.0",
  "dependencies": { "shelf": "^1.0", "toolbar": "^1.0" },
  "optionalDependencies": { "router": "^2.0" },
  "frontend": { "module": "frontend/index.mjs" } }
```

```tsx
// hello/src/index.tsx
import type { Kernel } from "@kernel";
import { addItem as addToBar } from "plugin:toolbar";
import { addItem as addToShelf } from "plugin:shelf";

type Router = typeof import("plugin:router");      // type-only: erased, so fine for an optional one

export default function activate(kernel: Kernel): void {
  addToShelf({ id: "hello.greeting", title: "Hello" });
  addToBar({
    id: "hello", label: "Hello", side: "end",
    onSelect: async () => (await kernel.plugins.optional<Router>("router"))?.navigate("/hello"),
  });
}
```

Before you start:

1. **The `kernel` you are handed is yours.** Settings, your `%%%` section, log lines and
   registry items are attributed to your plugin id automatically. You cannot act as
   another plugin.
2. **Exports are your API; dependencies are declared.** Everything you import as
   `plugin:<id>` is in `dependencies`, and has activated before your `activate` runs.
   Changing an export's signature is a major version bump.
3. **Throwing from `activate` fails your plugin** and skips every plugin that requires it,
   with one aggregated notice; the items it added are withdrawn. Fail early rather than
   half-registering.
4. **Nothing reloads in place.** Installing, updating, enabling or disabling any plugin
   reloads every open client. Still release what you create outside the kernel (window
   listeners, timers) in `export function deactivate()`.
5. **Never rewrite frontmatter or another plugin's `%%%` section directly.**
   `kernel.documents.splice` is the only sanctioned write path for metadata. And **read
   locally**: `kernel.documents.query/subscribe/search` run against the local replica,
   online or offline; don't call `/api/documents` to browse.

Types: `import type { Kernel } from "@kernel"`, and other plugins' from `plugin:<id>`.
Outside this repository, fetch `/kernel.d.ts` from your server (or run `ddd plugin types`)
and use each dependency's `frontend/index.d.ts` from its installed package.

## Trust

Installing a plugin runs its frontend code **unsandboxed** in every user's session: full
DOM, full workspace, the user's credentials. Manifest `capabilities` gate server host
functions and native bridge calls only. Only install plugins you trust.

Recovery, from least to most drastic:

| | |
|---|---|
| `?safe=1` | load base plugins only |
| `?safe=bare` | load no plugins; the kernel's built-in plugin manager |
| `DISABLE_PLUGINS=1` (server env) | serve no frontend plugins |
