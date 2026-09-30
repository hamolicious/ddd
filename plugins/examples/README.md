# `plugins/examples/` — third-party plugins

Plugins that are **not** part of the base distribution, kept in the repository because
each one proves something the base distribution structurally cannot.

They are built with the same tooling and land in the same layout, so the server cannot
tell them apart from a base plugin — which is the point. What separates them is the
contract they compile against: `tsconfig.json` here maps `@kernel` to
**`web/kernel-api/dist/kernel.d.ts`** (the file served at `/kernel.d.ts`), and resolves
`plugin:<id>` through each built base plugin's generated `frontend/index.d.ts` (the
`declare module "plugin:<id>"` shipped with it) — not through `plugins/base/*/src`. A
plugin author outside this repository has exactly those files, so these plugins have
exactly that too, and a type the generators drop fails here.

Each one uses the kernel 3.0 model: it lists the plugins it calls under `dependencies`
(or `optionalDependencies`) and calls their exports directly:

- `alt-editor`: `"provides": "editor@2.0.0"`, a stand-in for `editor`. It adds its `edit`
  mode with `document-surface`'s `addMode` and exports `editor`'s whole API
  (`addSurface`, `addPasteHandler`, `addExtension`, `onSurfacesChange`, …), so every
  plugin that depends on `editor` keeps loading. CodeMirror extensions and folding are
  accepted and ignored.
- `source-view`: `addMode` from `plugin:document-surface`.
- `extra-task-states`: `addTaskState` from `plugin:markdown`.
- `obsidian-importer`: `upload` from `plugin:attachments`, `addCommand` from
  `plugin:commands`, `addItem` from `plugin:header`; `folders` is optional and reached
  with `kernel.plugins.optional("folders")`.

| Plugin | Why it exists |
|---|---|
| `alt-editor` | **SPEC §9 M3's acceptance criterion**: "the built-in editor replaced by a separately-authored editor plugin". A stand-in for `editor` (`provides`): a plain `<textarea>` bound to the document's `Y.Text`, deliberately *not* CodeMirror, so what it proves is that the document surface has no built-in favourite and that a plugin can replace another one its dependents rely on, rather than that two plugins can share a library. Driven by `web/app/e2e/acceptance.spec.ts`. |
| `extra-task-states` | Adds `[/]`, `[-]` and `[?]` to the markdown task-state registry (SPEC §6.6). It is the only way to test the registry-driven half of the task contract: `[ ]` and `[x]` are `markdown`'s own default contributions *and* the only two markers remark-gfm recognises, so clicking those cannot distinguish "the registry decides marker semantics" from "GFM does". It also doubles as the non-base plugin the safe-mode suite breaks on purpose. |
| `source-view` | A **third** document mode: the whole text, read-only, frontmatter and `%%%` sections included. It proves the surface takes any number of modes (the header's icon switch and the phone's floating button make room without being told) and that a mode decides for itself where it applies — its `when` offers it only on documents that have something Read mode hides. Driven by `web/app/e2e/modes.spec.ts`. |
| `obsidian-importer` | Adds an **Import an Obsidian vault** command and top-bar action. It reads a vault ZIP through `kernel.capabilities.filesystem`, imports Markdown through `kernel.documents`, uploads binary files through `attachments`' `upload`, creates ordinary wrapper documents in their vault folders, and resolves Obsidian wikilinks plus local Markdown links to stable `doc://` / `attachment://` IDs. Source paths and in-flight upload sessions are checkpointed, so selecting the same archive after a refresh resumes instead of duplicating work. Obsidian configuration directories are skipped. |
| `hello-backend` | **The backend half's fixture** (SPEC §6.3, `backend/HOST-ABI.md`). Rust only — a `Cargo.toml` and a `src/`, no manifest and no frontend half — and it is what every host suite actually drives: `pluginhost_smoke` (the ABI end to end), `pluginhost_runtime` (limits, ownership, the breaker, pooling, safe mode), `pluginhost_http` (the SSRF policy) and `pluginhost_routes` (inbound routes, credential stripping). It exports a cron handler, a `document.changed` hook, HTTP routes, a call dispatcher (`lm_call`; a test that calls another plugin through `call_plugin` gives the caller's record the callee under `dependencies` and the function under the callee's `backend.exports`, HOST-ABI §3.10), and a set of paths that exist purely so a host test can reach them — a trap, a spin, a log flood, a capability probe. Since `calendar` was removed (2026-09-24) it is the **only** backend plugin in the repository, and it is the right place to add any behaviour a host test needs. |

## Building

```bash
node web/scripts/build-examples.mjs            # -> plugins/examples/dist/<id>/<version>/
npx --prefix web tsc --noEmit -p plugins/examples/tsconfig.json
mise run wasm-plugins                          # the backend halves (hello-backend)
```

`build-examples.mjs` builds the **frontend** halves: it skips any directory with no
`manifest.json`, which is how `hello-backend` stays out of it.

The typecheck needs `web/kernel-api/dist/kernel.d.ts` and the built base plugins' `.d.ts`
files, so run `npm run kernel:dts` and `mise run plugins` first. That ordering is real for
third parties too, so it is not hidden.

## Serving them

In M3 the plugin registry **is** the directory the server scans (`PLUGINS_DIR`);
enable/disable, the approval flow and the zip installer are M4. So an example plugin is
"installed" by composing a directory that contains it:

```bash
node web/scripts/compose-plugins.mjs /tmp/registry \
  --exclude=editor --include-examples=alt-editor
PLUGINS_DIR=/tmp/registry  cargo run --manifest-path backend/Cargo.toml -- serve
```

`alt-editor` and `editor` cannot both be enabled (`provides`): enabling one disables the
other.

`?safe=1` boots the base distribution only, so nothing here loads in safe mode — which is
what makes it the right place to put a plugin you intend to break.
