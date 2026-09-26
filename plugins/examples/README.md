# `plugins/examples/` — third-party plugins

Plugins that are **not** part of the base distribution, kept in the repository because
each one proves something the base distribution structurally cannot.

They are built with the same tooling and land in the same layout, so the server cannot
tell them apart from a base plugin — which is the point. What separates them is the
contract they compile against: `tsconfig.json` here maps `@kernel` to
**`web/kernel-api/dist/kernel.d.ts`**, the single generated file served at `/kernel.d.ts`,
rather than to `kernel-api/src`. A plugin author outside this repository has exactly that
file and nothing else, so these plugins have exactly that too. If the generator ever drops
a type they need, this config fails and `web/tsconfig.json` does not — the claim "written
against the published contract" is checked rather than asserted.

| Plugin | Why it exists |
|---|---|
| `alt-editor` | **SPEC §9 M3's acceptance criterion**: "the built-in editor replaced by a separately-authored editor plugin". A replacement `edit` mode — a plain `<textarea>` bound to the document's `Y.Text`, deliberately *not* CodeMirror, so what it proves is that `document.mode` has no built-in favourite rather than that two plugins can share a library. Driven by `web/app/e2e/acceptance.spec.ts`. |
| `extra-task-states` | Adds `[/]`, `[-]` and `[?]` to the markdown task-state registry (SPEC §6.6). It is the only way to test the registry-driven half of the task contract: `[ ]` and `[x]` are `markdown`'s own default contributions *and* the only two markers remark-gfm recognises, so clicking those cannot distinguish "the registry decides marker semantics" from "GFM does". It also doubles as the non-base plugin the safe-mode suite breaks on purpose. |
| `source-view` | A **third** `document.mode`: the whole text, read-only, frontmatter and `%%%` sections included. It proves the surface takes any number of modes (the header's icon switch and the phone's floating button make room without being told) and that a mode decides for itself where it applies — its `when` offers it only on documents that have something Read mode hides. Driven by `web/app/e2e/modes.spec.ts`. |
| `hello-backend` | **The backend half's fixture** (SPEC §6.3, `backend/HOST-ABI.md`). Rust only — a `Cargo.toml` and a `src/`, no manifest and no frontend half — and it is what every host suite actually drives: `pluginhost_smoke` (the ABI end to end), `pluginhost_runtime` (limits, ownership, the breaker, pooling, safe mode), `pluginhost_http` (the SSRF policy) and `pluginhost_routes` (inbound routes, credential stripping). It exports a cron handler, a `document.changed` hook, HTTP routes, a call dispatcher, and a set of paths that exist purely so a host test can reach them — a trap, a spin, a log flood, a capability probe. Since `calendar` was removed (2026-09-24) it is the **only** backend plugin in the repository, and it is the right place to add any behaviour a host test needs. |

## Building

```bash
node web/scripts/build-examples.mjs            # -> plugins/examples/dist/<id>/<version>/
npx --prefix web tsc --noEmit -p plugins/examples/tsconfig.json
mise run wasm-plugins                          # the backend halves (hello-backend)
```

`build-examples.mjs` builds the **frontend** halves: it skips any directory with no
`manifest.json`, which is how `hello-backend` stays out of it.

The typecheck needs `web/kernel-api/dist/kernel.d.ts`, so run `npm run kernel:dts` (or
`mise run web-build`) first. That ordering is real for third parties too, so it is not
hidden.

## Serving them

In M3 the plugin registry **is** the directory the server scans (`PLUGINS_DIR`);
enable/disable, the approval flow and the zip installer are M4. So an example plugin is
"installed" by composing a directory that contains it:

```bash
node web/scripts/compose-plugins.mjs /tmp/registry \
  --exclude=editor --include-examples=alt-editor
PLUGINS_DIR=/tmp/registry  cargo run --manifest-path backend/Cargo.toml -- serve
```

`?safe=1` boots the base distribution only, so nothing here loads in safe mode — which is
what makes it the right place to put a plugin you intend to break.
