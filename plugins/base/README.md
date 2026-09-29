# `plugins/base/` — the base distribution

The visible app. Twenty-eight plugins that happen to ship with the server and are
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
_shared/vite.plugin-config.mjs    the reference build config (SPEC §6.4)
_shared/vite.config.example.mjs   how a standalone plugin uses it
_shared/vite.config.tailwind.example.mjs  Tailwind-enabled standalone build
<id>/manifest.json                SPEC §6.2: `provides` and `consumes` name the plugin's ports
<id>/protocols/<name>/shape.mjs   a protocol the plugin owns; the rest of the package is generated
<id>/src/index.tsx                `export default function activate(kernel) { … }`
<id>/src/style.css                linked on activation; classes prefixed per plugin
dist/<id>/<version>/              build output = the installed layout the server serves
```

| Plugin | Responsibility | Defines |
|---|---|---|
| `shell-ui` | layout, mobile breakpoint, a spot for the top bar, the altbar opposite the sidebar, always-mounted overlays | `shell.header`, `shell.overlay`, `sidebar.panel`, `altbar.panel`, `main.view` |
| `header` | the top bar: `start`/`end` seats (the ☰ is `shell-ui`'s item), the "Top bar" ordering setting | `navbar.item` |
| `context-menu` | the menu / sheet / modal service: popover beside a button, bottom sheet on a phone; `modal` and `confirm` | — |
| `notices` | the notice bell, in the header's `end` seat | — |
| `sync-status` | the sync pill, in the header's `end` seat | — |
| `router` | URL ↔ view (hash-based) | `router.route` |
| `commands` | command registry, palette, keybindings; draws each command's `icon` name through `lm/icons`; serves `lm/commands` so other plugins can list and run commands | `commands`, `commands.command`, `keybindings.default` |
| `themes` | theme registry + picker; overrides kernel tokens | `themes.theme` |
| `doc-list` | browse/search/sort/filter (conditions shared with `folder-style` from `_shared/conditions.ts`, including "is inside note", "contains note", "list contains any of" and document values; properties and values suggested by the indexer when wired), new document, Trash; local index is the default search provider; an Actions button runs every command that `takes: "documents"` on the results listed | `search.provider` |
| `folders` | drag-and-drop tree of notes: a folder is a note, its children listed in its own `%%% folders` section, and every move is a list splice; serves `lm/folders` so other plugins can file notes; hosts other plugins' colours and icons for rows and entries in a row's menu | `folders`, `folders.decoration`, `folders.menu-item` |
| `folder-style` | a background and an icon for any note in the tree, from "Color and icon…" in its menu, with black or white text by contrast; defaults and rules (the same conditions as the document list's filters) for the rest, in Settings — a note's own look always wins; per-user, in settings, by note id | — |
| `icons` | the Tabler icon set, packed at build time from a pinned npm tarball (`tabler.json`, `build.mjs`) and fetched a shard at a time; serves `lm/icons`: `Icon`, `Picker`, search | — |
| `markdown` | the unified/remark → React pipeline | `markdown.directive/fence/codeBlock/remark/component/taskState/attachment` |
| `attachments` | paste-to-upload in the editor; shows embedded files through a viewer per file type; serves its resumable upload service (`lm/attachments`) | `attachments.viewer` |
| `slash-commands` | the `/` menu in any editor, over editor-neutral text surfaces | `text.surface`, `slash.command` |
| `native-preview` | viewers for what a browser shows natively: images, PDF, audio, video, text | — |
| `document-surface` | the document route + mode registry | `document.mode` |
| `viewer` | read mode, and the file page (`#/file/<id>`) | contributes `read` |
| `changes` | the open document's history in the altbar: changes and snapshots, view, revert, restore | — |
| `syntax-highlight` | fenced code highlighted with tree-sitter, in read mode and the editor; users install catalog languages as needed, or upload their own grammar + `highlights.scm` | `syntax.language` |
| `editor` | edit mode (CodeMirror 6 + `y-codemirror.next`) | `editor.extension`, `editor.paste` |
| `settings` | the settings shell | `settings.section` |
| `admin` | users, invites, audit, orphans, plugins, and the wiring editor as its Wiring tab (`#/admin/wiring`): every plugin's ports and wires, drafts over the live wiring, Apply, history and rollback through the admin-only wiring routes | — |
| `welcome` | fills a new, empty workspace with a short tour: one note per base feature | — |
| `indexer` | workspace stats, every frontmatter field and its values, each note's incoming and outgoing connections — rebuilt locally on every edit, read through its service | — |
| `fm-autocomplete` | while typing frontmatter in an editor, suggests the keys in use and then the typed key's values, from `indexer` | — |
| `graph` | every note and its links as a live force-directed graph: the whole workspace at `#/graph`, the open note's neighbourhood in the altbar; built from `indexer`'s documents and outgoing connections | — |
| `emoji` | `:tada:` reads as 🎉 (GitHub's gemoji set, packed at build time from a pinned npm tarball); typing `:ta` in an editor suggests shortcodes | — |

That is the whole table. `calendar` and `agenda` — M4's proof plugins, which shipped here
and were never in `BASE_PLUGIN_IDS` — were **removed** on 2026-09-24 at the owner's
direction. They are in git history; nothing here depends on them, and nothing in the
server was written for them. The one thing that went with them is the only base plugin
that had a backend half, so **every plugin in this directory is now frontend-only**; a
`backend.wasm` still builds and installs exactly as before (`mise run wasm-plugins`,
`plugins/examples/hello-backend`), there is simply nothing in the base set using it.

## How the base plugins relate

Drawn from the service ports in the manifests' `consumes`: an arrow reads **"uses a
service of"**, solid for a required port and dotted for an optional one. These wires are
all the resolver orders activation by (PLUGIN-PROTOCOLS §6): a provider activates before
the plugins that use it, and one that does not activate takes down every plugin that
requires it. Every plugin additionally uses `@kernel`, which is not drawn.

```mermaid
flowchart TD
    subgraph documents ["document experience"]
        viewer --> markdown
        document-surface
    end

    subgraph browse ["browse & find"]
        folders --> doc-list
        fm-autocomplete --> indexer
        graph --> indexer
    end

    subgraph config ["configuration"]
        themes -.-> settings
        admin
    end

    subgraph foundation ["foundation"]
        router --> shell-ui
        context-menu
    end

    markdown -.-> router
    document-surface --> router
    doc-list --> router & context-menu
    folders --> router & context-menu
    graph --> router & shell-ui
    settings --> router
    admin --> router & shell-ui & context-menu
    changes --> markdown & router & shell-ui & context-menu
    folder-style --> context-menu
    folder-style -.-> icons
    commands -.-> icons
    doc-list -.-> commands & icons
```

`attachments`, `editor`, `header`, `native-preview`, `notices`,
`slash-commands`, `sync-status`, `syntax-highlight` and `welcome` are not drawn because
they use no service: everything they do goes through **slots**, which never order
activation. A slot is many-to-one — providers offer items on a provided port, a host
collects them on a consumed port in seat order — and the wiring seats them wherever both
ends are running, whichever activated first. `header` hosts `navbar.item` and seven plugins
put items in the bar without either side naming the other; `commands` hosts every
`commands.command` and `keybindings.default`; `editor` offers a `text.surface` that
`slash-commands` and `fm-autocomplete` host. `attachments` serves `lm/attachments` (the
`obsidian-importer` example uses it) and puts a handler on `editor.paste`, a renderer on
`markdown.attachment` and `/attach` on `slash.command`; `native-preview` puts viewers on
`attachments.viewer`; `syntax-highlight` puts a renderer on `markdown.codeBlock`, a
decoration on `editor.extension` and a section on `settings.section`. Turning any one of
them off costs its own feature and nothing downstream.

The one message that points the other way is an **event**: `doc-list` announces every
document it creates on `lm/document-browser.created`, with the caller's `parent` hint, and
`folders` files it — under that parent, or its "new notes go to" note. An event because
`folders` already uses `doc-list`'s `lm/document-browser`, and a service the other way
round would be a cycle. A row's look reaches the tree through the `folders.decoration`
slot and the "Color and icon…" entry through `folders.menu-item`, both keyed by note id,
so `folders` never learns `folder-style` exists. `welcome` and the `obsidian-importer`
example file their notes through `folders`' `lm/folders` service, optionally.

Reading it bottom-up: `shell-ui` owns the frame everyone renders into and serves the
layout (`lm/shell`); `router` turns URLs into views and is the service almost everything
uses; the document experience stacks `viewer` and `editor` as peer *modes* offered to
`document-surface`, with `markdown`'s renderer the one service `viewer` needs; `indexer`
serves the workspace index that `graph` and `fm-autocomplete` read; and `folders` is the
one browse plugin built on another (`doc-list`). Replacing any node means serving the
protocols on its incoming arrows — which plugin does is a wiring decision, made in the
wiring editor (the admin plugin's Wiring tab), not in the consumer.

## Protocols and ports

Every contract between base plugins is a **protocol package** inside the plugin that owns
it (`dev-docs/todo/PLUGIN-PROTOCOLS.html` §3): `header/protocols/navbar.item/`,
`indexer/protocols/workspace-index/`, and so on, 39 in all (9 services, 28 slots, 2 events).
Each package has one hand-written file, `shape.mjs`; `protocol.json`, `index.d.ts` and
`README.md` are generated from it, and it is where a protocol's meaning is written down:

```
cd web && npm run generate          # after editing a shape.mjs or schema/manifest.schema.json
cd web && npm run check:generated   # what `mise run web-check` runs: fails on stale output
```

A plugin compiles against a protocol with `import type { NavbarItem } from
"@protocols/lm/navbar.item"`, never against another plugin's sources. The build copies the
generated files into `dist/<id>/<version>/protocols/`, the installer admits exactly those,
and the server registers them when it scans the served plugins, keeps them after their
owner is gone, and serves each one's types at `/protocols/<id>/<version>/index.d.ts`.

Each manifest names its **ports**: `provides` (a protocol at the exact version it
implements, with an optional `order` hint for default seats) and `consumes` (a range, with
`needs` listing the members it reads, `optional` for a service it can live without, and
`seats: 1` for a host that shows one provider). Port names are local to the plugin and
never change once published, because wiring refers to them. There is no other way for two
plugins to reach each other: since `@kernel` 2.0 the manifest has no `dependencies`, and
the kernel no `extensions` or `services`.

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
reads `text/plain` off a `DataTransfer` any plugin may have filled in, and the
`lm/folders` service files whatever it is given. So `folders` checks the document's
*stored* frontmatter before every write (`refuseMachine`), for the note being filed and
for the note it is filed into. Anyone adding a write here inherits that obligation;
`EXCLUDE_MACHINE_DOCUMENTS` on a subscription is not it.

## The shared files, and why each is not a protocol

`_shared/` holds what several base plugins must agree about *exactly*, where a protocol
would be the wrong shape of agreement: a rule or a helper each of them runs itself, not a
value one plugin hands another.

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

The types of what plugins *do* hand each other — every slot item and every service — are
in the protocol packages, never here.

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
```

The build runs from `web/` (that is where `vite` and the type declarations live) and each
plugin becomes one ES module with the **blessed runtime layer externalized** — `react`,
`yjs`, `@kernel`, the CodeMirror and remark families stay bare specifiers and resolve
through the server's import map at load time. A plugin that bundled its own React would
get its own React, and hooks and context would break across the boundary in ways that look
like a kernel bug.

Typechecking happens through `web/tsconfig.json` (`mise run web-check`), which includes
this directory. There is no `node_modules` here and there does not need to be: everything
a base plugin imports is either relative or external.

## Writing one

```json
{
  "id": "hello",
  "version": "1.0.0",
  "kernel": "^2.0",
  "hot": true,
  "consumes": { "router": { "protocol": "lm/router@^1.0", "needs": ["navigate"] } },
  "provides": {
    "nav": { "protocol": "lm/navbar.item@1.0.0" },
    "greeter": { "protocol": "acme/greeter@1.0.0" }
  },
  "frontend": { "module": "frontend/index.mjs" }
}
```

```tsx
import type { Kernel } from "@kernel";
import type { Router } from "@protocols/lm/router";

export default function activate(kernel: Kernel) {
  const router = kernel.ports.use<Router>("router");          // whatever the wiring bound
  kernel.ports.offer("nav", { id: "hello", label: "Hello", onSelect: () => router.navigate("/hello") });
  kernel.ports.serve("greeter", { greet: () => "hi" });       // for whoever consumes acme/greeter
}
```

Five things worth knowing before the first line:

1. **The `kernel` you are handed is yours.** Offers, settings, your `%%%` section, your
   log lines and your ports are all attributed to your plugin id without you passing one.
   You cannot act as another plugin, and it cannot act as you.
2. **Ports are the only way out, and they are checked.** `use`, `offer`, `serve`,
   `collect`, `emit` and `on` take your own port names; an undeclared one throws, an item
   or service that does not match its protocol throws at you, and a service handle
   refuses any member outside the port's `needs`. By the time your `activate` runs, every
   service you require has been served; which plugin serves it is the wiring's choice.
3. **Throwing from `activate` fails your plugin and skips every plugin that requires a
   service you provide**, with one aggregated notice. Fail loudly and early rather than
   half-registering. Whatever you built outside the kernel (window listeners, timers) is
   your `export function deactivate()`'s to release; it runs on every stop, and `"hot":
   true` is your promise that it does.
4. **Never rewrite frontmatter or another plugin's `%%%` section.** `kernel.documents.splice`
   is the only sanctioned write path for metadata (SPEC §3.3), and it is mandatory
   discipline, not a convenience.
5. **Read locally.** `kernel.documents.query/subscribe/search` run against the replicated
   projection, online or offline. Reaching for `/api/documents` to browse is a bug.

Types: `import type { Kernel } from "@kernel"`. Outside this repository, fetch
`/kernel.d.ts` from your server — it is generated from the contract that server
implements, which is the one that matters when a workspace is behind.

## Trust, stated plainly

Installing a plugin runs its frontend code **unsandboxed** in every user's session: full
DOM, full workspace, the user's credentials. `capabilities` in the manifest gate *server*
host functions and native bridge calls, not this. Frontend isolation is v2 research
(SPEC §6.1, §10). The recovery paths, in order of severity: `?safe=1` (base plugins only),
`?safe=bare` (no plugins, built-in manager), `DISABLE_PLUGINS=1` on the server.
