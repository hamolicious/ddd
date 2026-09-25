# `plugins/base/` — the base distribution

The visible app. Fourteen plugins that happen to ship with the server and are
[installed like any other](../SPEC.md#62-package-manifest-capabilities) — individually
replaceable, individually removable, and holding no privilege the kernel does not give
every plugin.

That is the whole point of the microkernel: **if the base distribution needed a special
case anywhere in the kernel, the kernel would be wrong.** This directory is also the
reference for writing a plugin — there is deliberately no scaffolding CLI (SPEC §10).

```
_shared/points.ts                 the extension points: names, types, shape validators
_shared/machine-docs.ts           the one rule three plugins share about hiding documents
_shared/vite.plugin-config.mjs    the reference build config (SPEC §6.4)
_shared/vite.config.example.mjs   how a standalone plugin uses it
<id>/manifest.json                SPEC §6.2
<id>/src/index.tsx                `export default function activate(kernel) { … }`
<id>/src/style.css                linked on activation; classes prefixed per plugin
dist/<id>/<version>/              build output = the installed layout the server serves
```

| Plugin | Responsibility | Defines |
|---|---|---|
| `shell-ui` | layout, mobile breakpoint, sync-status indicator | `navbar.item`, `sidebar.panel`, `main.view` |
| `router` | URL ↔ view (hash-based) | `router.route` |
| `commands` | command registry, palette, keybindings | `commands.command`, `keybindings.default` |
| `themes` | theme registry + picker; overrides kernel tokens | `themes.theme` |
| `search` | search UI; local index is the default provider | `search.provider` |
| `doc-list` | browse/sort/filter, new document, Trash | — |
| `folders` | tree over `fm.path`; moves are splices | — |
| `markdown` | the unified/remark → React pipeline | `markdown.directive/fence/remark/component/taskState` |
| `document-surface` | the document route + mode registry | `document.mode` |
| `viewer` | read mode | contributes `read` |
| `editor` | edit mode (CodeMirror 6 + `y-codemirror.next`) | `editor.extension` |
| `properties` | typed frontmatter editing, via splices | `properties.editor` |
| `settings` | the settings shell | `settings.section` |
| `admin` | users, invites, audit, orphans, snapshots, plugins | — |

That is the whole table. `calendar` and `agenda` — M4's proof plugins, which shipped here
and were never in `BASE_PLUGIN_IDS` — were **removed** on 2026-09-24 at the owner's
direction. They are in git history; nothing here depends on them, and nothing in the
server was written for them. The one thing that went with them is the only base plugin
that had a backend half, so **every plugin in this directory is now frontend-only**; a
`backend.wasm` still builds and installs exactly as before (`mise run wasm-plugins`,
`plugins/examples/hello-backend`), there is simply nothing in the base set using it.

## How the base plugins relate

Generated from the fourteen `manifest.json` `dependencies` fields — an arrow reads
**"depends on"**, and the loader's activation order is precisely a topological order of
this graph (a dependency always activates first; a failed dependency skips its whole
subtree). Every plugin additionally depends on `@kernel`, which is not drawn.

```mermaid
flowchart TD
    subgraph documents ["document experience"]
        viewer --> markdown
        viewer --> document-surface
        editor --> document-surface
        properties --> document-surface
    end

    subgraph browse ["browse & find"]
        folders --> doc-list
        search
    end

    subgraph config ["configuration"]
        themes --> settings
        admin --> settings
    end

    subgraph foundation ["foundation"]
        router --> shell-ui
        commands --> shell-ui
    end

    markdown --> commands & router
    document-surface --> commands & router & shell-ui
    editor --> commands
    properties --> commands
    doc-list --> commands & router & shell-ui
    folders --> commands & router & shell-ui
    search --> commands & router & shell-ui
    settings --> commands & router & shell-ui
    admin --> commands & router & shell-ui
    themes --> commands
```

Reading it bottom-up: `shell-ui` owns the frame everyone renders into; `router` and
`commands` are the two services almost everything consumes (URLs and actions); the
document experience stacks `viewer`/`editor`/`properties` as peer *modes* on
`document-surface`, with `markdown` as the rendering pipeline `viewer` consumes; and
`folders` is the one browse plugin built on top of another (`doc-list`). Replacing any
node means satisfying its incoming arrows — nothing else.

## Machine-owned documents

`doc-list`, `folders` and `search` leave out any document whose `fm.path` starts with
`.` — the kernel's per-user settings documents (SPEC §6.4) are the ones that exist
today. The rule, the predicate and the DSL clause live in one place,
`_shared/machine-docs.ts`, precisely so the three cannot drift about what they are
hiding: a sidebar counting twelve above a list of eleven is the bug this replaced.

It is **a convention three plugins share, not a kernel concept.** The kernel knows one
domain model — a document is text — and "machine-owned" is not part of it (SPEC §2).
Nothing changes about what the server returns, what the local index holds or what
`kernel.documents` answers, every one of these documents stays readable, editable and
linkable, and `doc-list`'s filter bar and `search`'s results page each carry a toggle
that brings them back. A plugin that wants machine-owned documents of its own gets the
same treatment by filing them under a dotted path — there is no list of special paths
for anyone to keep up to date.

`folders` has no toggle, deliberately: a hidden folder in a tree is a row that looks
like every other folder and behaves differently, and a rename there would splice
`fm.path` on documents the kernel authors.

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

```tsx
import type { Kernel } from "@kernel";

export default function activate(kernel: Kernel) {
  kernel.extensions.contribute("navbar.item", { id: "hello", label: "Hello" });
  return { greet: () => "hi" };      // this plugin's API, for its declared dependents
}
```

Five things worth knowing before the first line:

1. **The `kernel` you are handed is yours.** Contributions, settings, your `%%%` section,
   your log lines and your service access are all attributed to your plugin id without you
   passing one. You cannot act as another plugin, and it cannot act as you.
2. **Activation is reload-only, in topological order.** By the time your `activate` runs,
   every declared dependency has returned its API; `kernel.services.require("markdown")`
   is synchronous and cannot be undeclared.
3. **Throwing from `activate` fails your plugin and skips everything that depends on it**,
   with one aggregated notice. Fail loudly and early rather than half-registering.
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
