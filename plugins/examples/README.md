# `plugins/examples/` — third-party plugins

Plugins that are **not** part of the base distribution. Each one exercises something the
base distribution cannot, and several are driven by the end-to-end and host test suites.

They use the same tooling and install layout as base plugins; the server cannot tell them
apart. The difference is what they compile against, which is exactly what an author outside
this repository has:

- `@kernel` → `web/kernel-api/dist/kernel.d.ts` (the file the server serves at `/kernel.d.ts`)
- `plugin:<id>` → each built base plugin's generated `frontend/index.d.ts`, not
  `plugins/base/*/src`

So a type the generators drop fails the typecheck here.

## The plugins

| Plugin | What it is | Uses |
|---|---|---|
| `alt-editor` | A replacement for `editor` (`"provides": "editor@2.0.0"`): a plain `<textarea>` bound to the document's `Y.Text`. Adds its `edit` mode via `document-surface`'s `addMode` and exports `editor`'s whole API (`addSurface`, `addPasteHandler`, `addExtension`, `onSurfacesChange`, …) so every dependent of `editor` still loads; CodeMirror extensions and folding are accepted and ignored. Tested by `web/app/e2e/acceptance.spec.ts`. | `plugin:document-surface` |
| `source-view` | A third document mode: the whole text, read-only, including frontmatter and `%%%` sections. Offered only on documents that have something Read mode hides. Tested by `web/app/e2e/modes.spec.ts`. | `addMode` from `plugin:document-surface` |
| `extra-task-states` | Adds `[/]`, `[-]` and `[?]` task markers to the markdown task-state registry. Also the non-base plugin the safe-mode tests break on purpose. | `addTaskState` from `plugin:markdown` |
| `obsidian-importer` | An **Import an Obsidian vault** command and top-bar action. Reads a vault ZIP, imports Markdown as documents, uploads binary files, creates wrapper documents for vault folders, and rewrites wikilinks and local Markdown links to `doc://` / `attachment://` IDs. Progress is checkpointed: selecting the same archive after a refresh resumes instead of duplicating. Obsidian config directories are skipped. | `upload` from `plugin:attachments`, `addCommand` from `plugin:commands`, `addItem` from `plugin:toolbar`; `folders` optionally, via `kernel.plugins.optional("folders")` |
| `hello-backend` | The backend (Wasm) test fixture, Rust only: a `Cargo.toml` and `src/`, no manifest or frontend. Exports a cron handler, a `document.changed` hook, HTTP routes, a call dispatcher (`ddd_call`), and paths that exist only for host tests (a trap, a spin, a log flood, a capability probe). Driven by the `pluginhost_smoke`, `pluginhost_runtime`, `pluginhost_http` and `pluginhost_routes` suites. It is the only backend plugin in the repository; add behaviour a host test needs here. | — |

## Building

Build the kernel types and the base plugins first; the typecheck needs their `.d.ts` files
(third-party authors need the same order):

```bash
cd web && npm run kernel:dts && cd ..
mise run plugins
```

Then:

```bash
node web/scripts/build-examples.mjs            # frontend halves -> plugins/examples/dist/<id>/<version>/
npx --prefix web tsc --noEmit -p plugins/examples/tsconfig.json
mise run wasm-plugins                          # backend halves (hello-backend)
```

`build-examples.mjs` skips any directory without a `manifest.json`, so `hello-backend` is
only built by `wasm-plugins`.

## Running them

**Compose a plugin directory** and point the server at it with `PLUGINS_DIR`:

```bash
node web/scripts/compose-plugins.mjs /tmp/registry \
  --exclude=editor --include-examples=alt-editor
PLUGINS_DIR=/tmp/registry cargo run --manifest-path backend/Cargo.toml --bin ddd -- serve
```

With no flags, `compose-plugins.mjs` copies the base distribution. It copies rather than
symlinks, because the server refuses symlinked plugin paths.

**Or install through the UI:** package the plugin, then upload the `.zip` in Admin →
Plugins and approve it:

```bash
node web/scripts/package-plugin.mjs <id> --examples   # -> dist-packages/<id>-<version>.zip
```

Notes:

- `alt-editor` and `editor` cannot both be enabled (`provides`); enabling one disables the
  other.
- `?safe=1` loads base plugins only, so none of these load in safe mode. Use it to recover
  from a broken example.
