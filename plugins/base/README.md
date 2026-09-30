# `plugins/base/` — the base distribution

The visible app. Thirty-seven plugins that happen to ship with the server and are
[installed like any other](../SPEC.md#62-package-manifest-capabilities) — individually
replaceable, individually removable, and holding no privilege the kernel does not give
every plugin.

That is the whole point of the microkernel: **if the base distribution needed a special
case anywhere in the kernel, the kernel would be wrong.** This directory is also the
reference for writing a plugin — there is deliberately no scaffolding CLI (SPEC §10).

```
_shared/machine-docs.ts           the one rule three plugins share about hiding documents
_shared/fm-display.ts             what kind of thing an fm value is, and how to show one
_shared/regions.ts                where the frontmatter, body and `%%%` sections are in a text
_shared/compact.ts                "this is a phone": the breakpoint, and the hooks that read it
_shared/boundary.tsx              `useRegistry` + `bounded`: how a host draws contributed components
_shared/vite.plugin-config.mjs    the reference build config (SPEC §6.4)
_shared/vite.config.example.mjs   how a standalone plugin uses it
_shared/vite.config.tailwind.example.mjs  Tailwind-enabled standalone build
<id>/manifest.json                SPEC §6.2: `dependencies` and `optionalDependencies` by id and range
<id>/src/index.tsx                `activate(kernel)`, and the named exports other plugins import
                                  as `plugin:<id>`
<id>/src/style.css                linked on activation; classes prefixed per plugin
dist/<id>/<version>/              build output = the installed layout the server serves,
                                  with `frontend/index.d.ts` for the exports' types
```

| Plugin | Responsibility | Exports (`plugin:<id>`) |
|---|---|---|
| `shell-ui` | layout, mobile breakpoint, a spot for the top bar and one for the bottom bar, the altbar opposite the sidebar, always-mounted overlays | `addView`, `addOverlay`, `addSidebarPanel`, `addAltbarPanel`, `setHeader`, `setFooter`, `toggleSidebar`, `toggleAltbar`, `layout`… |
| `toolbar` | the top and bottom bars: a header and a status footer on desktop, a thin top bar and a bottom icon toolbar on a phone; items pick a bar and side (`bar`, `side`, `mobile`), and Settings → Toolbar has a per-device layout | `addItem` |
| `context-menu` | the menu / sheet / modal service: popover beside a button, bottom sheet on a phone; `modal` and `confirm`. Also the right-click / long-press / menu-key menu of anything a plugin marks with a target type (`data-lm-target`, `_shared/target.ts`), built from every plugin's actions for that type. It alone decides popover or sheet: plugins never draw a menu of their own | `addAction`, `open`, `modal`, `confirm`… |
| `notices` | the notice bell, at the end of the top bar | — |
| `sync-status` | the sync pill, at the end of the top bar | — |
| `router` | URL ↔ view (hash-based) | `addRoute`, `navigate`, `Link`, `href`… |
| `commands` | command registry, palette, keybindings; draws each command's `icon` name through `icons` when it is there; other plugins list and run commands through its exports | `addCommand`, `addKeybinding`, `run`, `list`, `openPalette`… |
| `themes` | theme registry + picker; overrides kernel tokens | `addTheme`, `select`… |
| `doc-list` | the all-documents page (`table`'s `TablePage`, the search and the table's columns in the URL), new document, Trash | `createDocument`, `newDocument` |
| `search` | search for every view: the providers (local index first, then the server), a search as one query string (text, filter — conditions shared with `folder-style` from `_shared/conditions.ts` — sort), live and one-shot resolution, and the controls every view is drawn under (`SearchShell`; `SavedSearch` for a saved-search note, with "Update saved search"), with an Actions button over the results | `addProvider`, `useResults`, `resolve`, `SearchShell`, `SavedSearch`… |
| `calendar` | a saved search as a month calendar (`type: calendar`): dated by whichever field it is set to, optionally running to an end field; each note wears its `folders` colour and icon; asks `search` for the weeks on screen (`useResults` with `within`); "New calendar" | — |
| `kanban` | a saved search as a board (`type: kanban`): columns from a field (`fm.status` by default), named ones first; dragging a card — or "Move to" in its menu — sets the field with one splice, when it entered the column (`<field>-since`, a sortable "Entered column"), and its place in the column as a `rank` in the card's own `%%% kanban` section (or off, to follow the search's sort); a filter bar above the board narrows it by any property the cards show, and a card added under a filter is born with its value; optional swimlanes (`lanes`) stack the board in rows by a second field, each with the same columns — a drop into another lane sets that field too, and a lane's **+** makes a card with its value; cards wear their `folders` colour and icon; each column's **+** makes a card already in it (filed where the board looks); "New board" makes one note that is a saved search of its own children: the board, with its tickets inside it | — |
| `timeline` | a saved search along a time axis (`type: timeline`): start and optional end fields (bars, or points), optional lanes by a field, days/weeks/months; asks `search` for the window on screen; "New timeline" | — |
| `table` | a saved search as a table (`type: table`, and any saved search with no type): the title, then the columns you choose, a set number of rows at a time, a "Match" column; "New table"; exports `TablePage` for the all-documents page | `TablePage`, `save` |
| `folders` | drag-and-drop tree of notes: a folder is a note, its children listed in its own `%%% folders` section, and every move is a list splice; other plugins file notes through its exports; hosts other plugins' colours and icons for rows; offers a note's New note inside / New search inside (with `search`) / Duplicate / Copy / Paste inside / Rename / Move to… / Delete and the root's menu (`folders/root`) as context actions, and Duplicate / Copy / Paste note as commands (the copy is the note alone, without its children; the clipboard is in-app) | `addDecoration`, `file`, `fileNew`, `parentOf`, `childrenOf`, `look`… |
| `local-folder` | every note as a Markdown file in a folder on this device (`kernel.capabilities.folder`), both ways while the app runs; asks once in a shell, offered in Settings in a Chromium browser | — |
| `folder-style` | a background and an icon for any note in the tree, from "Color and icon…" in its menu, with black or white text by contrast; defaults and rules (the same conditions as the document list's filters) for the rest, in Settings — a note's own look always wins; per-user, in settings, by note id | — |
| `auto-fm` | adds the frontmatter properties you list in Settings to notes you make (or also edit) on this device, only where the note does not have the key yet; each can be limited to notes matching conditions (the document list's); values can hold `{{date}}`, `{{time}}`, `{{now}}`; per-user, client-side, works offline | — |
| `icons` | the Tabler icon set, packed at build time from a pinned npm tarball (`tabler.json`, `build.mjs`) and fetched a shard at a time | `Icon`, `Picker`, `search`, `has` |
| `markdown` | the unified/remark → React pipeline | `addDirective`, `addFence`, `addCodeBlockRenderer`, `addRemarkPlugin`, `addComponent`, `addTaskState`, `addAttachmentRenderer`, `render`… |
| `attachments` | paste-to-upload in the editor; shows embedded files through a viewer per file type; exports its resumable `upload` | `addViewer`, `upload` |
| `slash-commands` | the `/` menu in any editor, over editor-neutral text surfaces | `addSlashCommand` |
| `native-preview` | viewers for what a browser shows natively: images, PDF, audio, video, text | — |
| `document-surface` | the document route + mode registry | `addMode`, `currentDocument`, `setMode`… |
| `viewer` | read mode, with the notes filed inside a note listed under it (from `folders`, when it is there), and the file page (`#/file/<id>`) | — (adds the `read` mode) |
| `changes` | the open document's history in the altbar: changes and snapshots, view, revert, restore | — |
| `syntax-highlight` | fenced code highlighted with tree-sitter, in read mode and the editor; users install catalog languages as needed, or upload their own grammar + `highlights.scm` | `addLanguage` |
| `editor` | edit mode (CodeMirror 6 + `y-codemirror.next`) | `addExtension`, `addPasteHandler`, `addSurface`, `surfaces`, `focus` |
| `settings` | the settings shell | `addSection`, `open` |
| `admin` | users, invites, audit, orphans, plugins (each one's dependencies, its dependents and any `provides` conflict) | `open`, `isAdmin` |
| `welcome` | fills a new, empty workspace with a short tour: one note per base feature | — |
| `indexer` | workspace stats, every frontmatter field and its values, each note's incoming and outgoing connections — rebuilt locally on every edit | `fmFields`, `fmValues`, `documents`, `connections`, `stats`, `subscribe`… |
| `doc-events` | "a note was just made here": views that make notes call `notifyCreated`, the folder tree listens with `onCreated`; no dependencies, so neither side needs the other | `notifyCreated`, `onCreated` |
| `fm-autocomplete` | while typing frontmatter in an editor, suggests the keys in use and then the typed key's values, from `indexer` | — |
| `graph` | every note and its links as a live force-directed graph: the whole workspace at `#/graph`, the open note's neighbourhood in the altbar; built from `indexer`'s documents and outgoing connections | — |
| `emoji` | `:tada:` reads as 🎉 (GitHub's gemoji set, packed at build time from a pinned npm tarball); typing `:ta` in an editor suggests shortcodes | — |
| `wikilinks` | `[[` links a note and `![[` embeds one, written as ordinary `doc://` links; the editor shows each linked note's title above its link | — |

That is the whole table. The first `calendar` (an ICS feed, not today's saved-search view)
and `agenda` — M4's proof plugins, which shipped here and were never in `BASE_PLUGIN_IDS`
— were **removed** on 2026-09-24 at the owner's
direction. They are in git history; nothing here depends on them, and nothing in the
server was written for them. The one thing that went with them is the only base plugin
that had a backend half, so **every plugin in this directory is now frontend-only**; a
`backend.wasm` still builds and installs exactly as before (`mise run wasm-plugins`,
`plugins/examples/hello-backend`), there is simply nothing in the base set using it.

### Saved searches and their views

A saved search is a note with `saved-search:` in its frontmatter. Its `type` picks the
views, each a tab beside Read and Edit:

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

- New ones come from the palette ("New board", "New table", …) or the folder tree ("New board inside", "… at the root"). Each starts as a search for the notes inside it.
- A view's settings are changed in the search's View panel (or on the board itself) and saved straight away. The search itself changes only on "Update saved search".
- A view plugin is a mode (`document-surface`'s `addMode`) that answers to its type and draws itself inside `search`'s `SavedSearch` (`_shared/saved-view-mode.tsx`).

## How the base plugins relate

Drawn from the manifests' `dependencies` and `optionalDependencies`: an arrow reads
**"imports"**, solid for a dependency and dotted for an optional one. The arrows are all
the loader orders activation by: a plugin activates after everything it points at, and
one whose required dependency is missing, out of range or failed is skipped, and so are
the plugins that require it. Every plugin additionally uses `@kernel`, which is not drawn.

The **frame** — `shell-ui`, `router`, `context-menu`, `settings`, `commands` — is drawn
with its own arrows only; nearly every other plugin depends on some of it, and those
arrows are left out. So is `doc-events` (below).

```mermaid
flowchart TD
    subgraph frame ["frame"]
        router --> shell-ui
        context-menu --> shell-ui
        settings --> router & shell-ui
        commands --> settings & shell-ui
        commands -.-> icons
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
        kanban --> search & document-surface
        kanban -.-> folders
        doc-list --> search & table
        folders --> doc-list
        folder-style --> folders & indexer
        folder-style -.-> icons
        graph --> indexer & header
    end

    subgraph bar ["top bar"]
        header
        notices --> header
        sync-status --> header
        admin --> header
    end

    auto-fm --> indexer
    local-folder -.-> folders & attachments
    welcome -.-> folders
```

`themes` depends on the frame alone. Load order, dependencies first (a plugin only depends
on rows above its own; within a row the order is free):

| | |
|---|---|
| 0 | `shell-ui`, `icons`, `indexer`, `doc-events` |
| 1 | `router`, `context-menu` |
| 2 | `settings` |
| 3 | `commands`, `header`, `auto-fm` |
| 4 | `document-surface`, `search`, `themes`, `notices`, `sync-status`, `graph`, `admin` |
| 5 | `editor`, `table`, `timeline` |
| 6 | `doc-list`, `slash-commands`, `fm-autocomplete`, `wikilinks` |
| 7 | `folders` |
| 8 | `markdown`, `calendar`, `kanban`, `folder-style`, `welcome` |
| 9 | `viewer`, `attachments`, `syntax-highlight`, `emoji`, `changes` |
| 10 | `native-preview`, `local-folder` |

The direction is always **the contributor depends on the host**. `header` knows nothing of
`notices`, `sync-status`, `admin` or `graph`; they import its `addItem`. `editor` and
`viewer` are peer modes added to `document-surface`; `markdown` takes renderers, fences and
remark plugins from `emoji`, `syntax-highlight` and `attachments` the same way; `editor`
publishes text surfaces that `slash-commands`, `fm-autocomplete`, `wikilinks` and `emoji`
read. Turning a contributor off costs its own feature and nothing downstream.

The one message that points the other way is **"a note was just made"**: the views that
make notes (`doc-list`, `search`, `table`, `calendar`, `kanban`, `timeline`) call
`doc-events`' `notifyCreated` with the caller's `parent` hint, and `folders` files it —
under that parent, or its "new notes go to" note — from `onCreated`. `doc-events` is a
leaf with no dependencies, because `folders` already depends on `doc-list` and a direct
call the other way would be a cycle. A row's look reaches the tree through `folders`'
`addDecoration`, keyed by note id, and "Color and icon…" is `folder-style`'s own
`addAction` for any `lm/document`, so `folders` never learns `folder-style` exists.
`welcome`, `local-folder` and the `obsidian-importer` example file their notes through
`folders`, optionally.

Replacing a plugin means exporting what its dependents import: a stand-in declares
`"provides": "<id>@<version>"`, dependents' ranges are checked against that version, and
only one of the two can be enabled.

## Dependencies and exports

A plugin's API is its **named exports** from `src/index.tsx` — functions, components,
types. Another plugin imports them by id and lists that id in its manifest:

```ts
import { addItem } from "plugin:toolbar";          // "dependencies": { "toolbar": "^1.0" }
const folders = await kernel.plugins.optional<typeof import("plugin:folders")>("folders");
                                                   // "optionalDependencies": { "folders": "^4.0" }
```

- **A static `plugin:` import is a required dependency.** An optional one is only reached
  through `kernel.plugins.optional(id)`, which returns `undefined` when it is not active;
  a static import of an absent plugin would fail the whole module.
- **A host takes contributions through a registry.** It keeps a `createRegistry` (from
  `@kernel`) at module scope and exports its `add` as `addX`, which returns the function
  that removes the items again. Module scope matters: a dependent calls `addX` from its own
  `activate`, which runs after the host's. The host draws what it collected with
  `useRegistry` and `bounded` from `_shared/boundary.tsx`, so a component that throws is
  reported against the plugin that added it (`<host>.<point>`, e.g. `toolbar.item`).
- **Events are exports too:** `onX(listener) → unsubscribe` and `notifyX(payload)`.
- **Validation is opt-in.** A registry can take a `shape`, and an exported function can be
  wrapped in `checked(s.fn([…], ret?), impl)`; a mismatch throws `ContractViolationError`
  at the caller.
- **No cycles**, and `_shared` files count: a type a `_shared` file imports from
  `plugin:x` makes `x` a dependency of every plugin that compiles that file in.

In the repository `plugin:*` resolves to `plugins/base/*/src/index.tsx` (tsconfig and
vitest); at runtime the server's import map resolves it to the enabled plugin's
`frontend/index.mjs`, and the build writes the exports' types to `frontend/index.d.ts`
(`declare module "plugin:<id>"`) for plugins built outside the repo. The graph is checked
before anything loads:

```
cd web && npm run check:plugins     # what `mise run web-check` runs
```

It fails on a dependency that does not exist or is out of range, a cycle, a `plugin:`
import (including type-only ones and those reached through `_shared`) that is not in
`dependencies`, and a static import of an optional dependency.

## Machine-owned documents

`doc-list`, `folders` and `search` leave out any document marked `machine: true` in its
frontmatter — the kernel's per-user settings documents (SPEC §6.4) are the main ones.
The rule, the predicate and the DSL clause live in one place,
`_shared/machine-docs.ts`, precisely so the three cannot drift about what they are
hiding: a sidebar counting twelve above a list of eleven is the bug this replaced.

It is **a convention three plugins share, not a kernel concept.** The kernel knows one
domain model — a document is text — and "machine-owned" is not part of it (SPEC §2).
Nothing changes about what the server returns, what the local index holds or what
`kernel.documents` answers, every one of these documents stays readable, editable and
linkable, and `doc-list`'s filter bar and `search`'s results page each carry a toggle
that brings them back. A plugin that wants machine-owned documents of its own writes the
same line — there is no list of special documents for anyone to keep up to date.

`folders` has no toggle, deliberately: a hidden note in a tree is a row that looks like
every other and behaves differently.

**Hiding is a read rule; the write needs its own.** Filtering a query protects what a
view *draws* and nothing else, and `folders` reaches its write path from places that
never ran the query: the "Move this note" command takes an id out of the URL, a drop
reads `text/plain` off a `DataTransfer` any plugin may have filled in, and
`folders`' exported `file` files whatever it is given. So `folders` checks the document's
*stored* frontmatter before every write (`refuseMachine`), for the note being filed and
for the note it is filed into. Anyone adding a write here inherits that obligation;
`EXCLUDE_MACHINE_DOCUMENTS` on a subscription is not it.

## The shared files, and why each is not an export

`_shared/` holds what several base plugins must agree about *exactly*, where one plugin's
export would be the wrong shape of agreement: a rule or a helper each of them runs itself,
not a value one plugin hands another.

- **`machine-docs.ts`** — above. Three plugins, one rule about what to hide.
- **`fm-display.ts`** — what kind of thing an `fm` value is (`inferKind`, `isDateKey`,
  `PREFERRED_KEY_ORDER`) and how to print one for a reader (`fmDisplayRows`,
  `formatDateValue`). `viewer` draws read mode's properties header from it. It was
  shared with the `properties` editing panel, removed on 2026-09-26; it stays in
  `_shared` so the next plugin that shows frontmatter types values the same way.
  `indexer` types the fields it indexes with the same `inferKind`.
- **`regions.ts`** — where the frontmatter, the body and the `%%%` run are in a text.
  `markdown` renders the body and `indexer` counts and scans it; a link that one of them
  treats as body and the other as machine data would be a backlink nobody can see.
  (`editor` still has its own differently-shaped copy; the header of `regions.ts` says
  what would retire both.)

The types of what plugins *do* hand each other — every registry item and every service
function — are exported by the plugin that owns them and imported from `plugin:<id>`.
`_shared` files may import those types too (`boundary.tsx`, `saved-view-mode.tsx`,
`conditions-index.ts`), and a plugin that compiles one of them in lists those plugins
under `dependencies` as if it had imported them itself; `check:plugins` follows the
relative imports to make sure.

## The folder tree

A folder is a note. Its children are listed, in order, in its own `%%% folders` section
under `children`, one id per line; any note can hold children, and one nobody lists is a
row at the root. `folders` draws them as one `role="tree"` (`src/hierarchy.ts` reads the
lists, `src/tree.ts` turns them into rows).

**Every move is a list splice** (`kernel.documents.splice.sectionList`): one line pushed
or inserted into the new parent, one removed from the old; the moved note is not written
at all. Line-sized writes are what let two devices file notes into one folder at once and
keep both. The new parent is written first, so an interrupted move leaves the note in two
lists — drawn once, under the parent with the smaller id, and repaired by its next move —
rather than in none. A loop (a note listed under its own descendant) is cut at its
smallest id so nothing disappears.

Per user, in settings: which notes are **collapsed** (stored as the negative, so an
untouched tree is open), the order of the notes at the root (`rootOrder`; every other
level's order is its parent's list), and where new notes and new file documents are
filed ("New notes go to", "Files go to"). Everything reachable by drag is reachable
without one — a long-press, a right-click, the row's `⋯`, or `M` opens a portalled sheet
with Move to…, New note inside, Rename and Delete — because HTML5 drag and drop does not
fire from touch.

## Building

```bash
mise run plugins                 # all of them, into plugins/base/dist
cd web && node scripts/build-plugins.mjs editor markdown    # just these two
cd web && npm run check:plugins  # the dependency graph (above)
```

The build runs from `web/` (that is where `vite` and the type declarations live) and each
plugin becomes one ES module with the **blessed runtime layer and every `plugin:<id>`
externalized** — `react`, `yjs`, `@kernel`, the CodeMirror and remark families and other
plugins stay bare specifiers and resolve through the server's import map at load time. A
plugin that bundled its own React would get its own React, and hooks and context would
break across the boundary in ways that look like a kernel bug; one that bundled another
plugin would get a second copy of that plugin's registries. Next to the module the build
writes `frontend/index.d.ts`, the types of `src/index.tsx`'s exports as `declare module
"plugin:<id>"`.

Typechecking happens through `web/tsconfig.json` (`mise run web-check`), which includes
this directory and maps `plugin:*` to each plugin's `src/index.tsx`. There is no
`node_modules` here and there does not need to be: everything a base plugin imports is
either relative or external.

## Writing one

Two plugins: `shelf` hosts a list other plugins add to, `hello` adds to it and puts a
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

Five things worth knowing before the first line:

1. **The `kernel` you are handed is yours.** Settings, your `%%%` section, your log lines
   and the items you add to any registry are all attributed to your plugin id without you
   passing one. You cannot act as another plugin, and it cannot act as you.
2. **Your exports are your API, and your dependencies are declared.** Anything another
   plugin should use is a named export of `src/index.tsx`; everything you import as
   `plugin:<id>` is in `dependencies`, and by the time your `activate` runs every one of
   them has activated. Changing an export's signature is a major version of your plugin.
3. **Throwing from `activate` fails your plugin and skips every plugin that requires
   it**, transitively, with one aggregated notice; the items it had added are withdrawn
   from every registry. Fail loudly and early rather than half-registering.
4. **Nothing reloads in place.** Installing, updating, enabling or disabling any plugin
   reloads every open client (`plugins.changed`), so a plugin is activated once per page
   load. Keep what you build outside the kernel (window listeners, timers) releasable in
   `export function deactivate()` all the same.
5. **Never rewrite frontmatter or another plugin's `%%%` section.** `kernel.documents.splice`
   is the only sanctioned write path for metadata (SPEC §3.3), and it is mandatory
   discipline, not a convenience. And **read locally**: `kernel.documents.query/subscribe/search`
   run against the replicated projection, online or offline; reaching for `/api/documents`
   to browse is a bug.

Types: `import type { Kernel } from "@kernel"`, and another plugin's from `plugin:<id>`.
Outside this repository, fetch `/kernel.d.ts` from your server — it is generated from the
contract that server implements, which is the one that matters when a workspace is behind
— and a dependency's `frontend/index.d.ts` from its installed package.

## Trust, stated plainly

Installing a plugin runs its frontend code **unsandboxed** in every user's session: full
DOM, full workspace, the user's credentials. `capabilities` in the manifest gate *server*
host functions and native bridge calls, not this. Frontend isolation is v2 research
(SPEC §6.1, §10). The recovery paths, in order of severity: `?safe=1` (base plugins only),
`?safe=bare` (no plugins, built-in manager), `DISABLE_PLUGINS=1` on the server.
