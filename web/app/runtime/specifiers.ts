/**
 * The **blessed runtime layer** (SPEC §6.4): the libraries the kernel and every
 * plugin must share one copy of, and the specifiers the server's import map
 * resolves.
 *
 * Why an import map at all: two copies of React means hooks and context break
 * across a plugin boundary; two copies of Yjs means two CRDT type registries; two
 * copies of `@codemirror/state` means an editor extension silently does nothing.
 * Import maps cannot change after load, which is why the *server* resolves every
 * installed plugin's `peerLibraries` ranges to single versions at install time and
 * serves one map to everybody.
 *
 * Honest consequence, restated from SPEC §6.4: the list below is part of the kernel
 * contract. Replacing the `editor` row means another *CodeMirror-based* editor, and
 * swapping the runtime layer itself is a kernel-major event.
 *
 * Each entry maps a specifier to the entry module that re-exports it. Those entries
 * are plain `.js` on purpose: `@types/react` uses `export =`, which cannot be
 * re-exported with `export *` from a TypeScript file, and a one-line runtime shim is
 * not worth an `@ts-expect-error` apiece. Vite bundles them either way. The build
 * (`vite.runtime.config.ts`) turns them into hashed chunks under `dist/runtime/`
 * and writes `dist/runtime-manifest.json`; the server reads that and serves
 * `/importmap.json` plus the inline map in `index.html`.
 */

export const RUNTIME_SPECIFIERS = {
  // The kernel contract itself: one copy, so `instanceof` works across plugins.
  "@kernel": "kernel.js",

  // React 18 — the UI runtime.
  react: "react.js",
  "react/jsx-runtime": "react-jsx-runtime.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",

  // The CRDT. `documents.open()` hands out `Y.Doc`s; a second Yjs cannot read them.
  yjs: "yjs.js",

  // Extension-point-coupled: the `editor` point takes CodeMirror extensions.
  "@codemirror/state": "codemirror-state.js",
  "@codemirror/view": "codemirror-view.js",
  "@codemirror/commands": "codemirror-commands.js",
  "@codemirror/language": "codemirror-language.js",
  "@lezer/common": "lezer-common.js",
  "@lezer/highlight": "lezer-highlight.js",
  "y-codemirror.next": "y-codemirror.js",

  // Extension-point-coupled: `markdown.remark` takes unified plugins.
  unified: "unified.js",
  "remark-parse": "remark-parse.js",
  "remark-gfm": "remark-gfm.js",
  "remark-directive": "remark-directive.js",
} as const satisfies Record<string, string>;

export type RuntimeSpecifier = keyof typeof RUNTIME_SPECIFIERS;

/** Every specifier, sorted — the app build externalizes exactly this set. */
export const RUNTIME_SPECIFIER_NAMES: readonly string[] = Object.keys(RUNTIME_SPECIFIERS).sort();

/** Where the build records specifier → hashed chunk URL, for the server. */
export const RUNTIME_MANIFEST_FILE = "runtime-manifest.json";

/**
 * The npm package a specifier's version comes from, or `undefined` when there is not one.
 *
 * The build records specifier → **version** alongside specifier → URL, because the server
 * cannot otherwise enforce the half of HOST-ABI.md §7.1 step 4 that matters: that a declared
 * `peerLibraries` range *intersects what the bundle provides*. Without a version it could only
 * check that the specifier exists, so a plugin declaring `"@codemirror/view": "^7"` installed
 * and activated cleanly on a server shipping 6.x and failed in the browser, against an API
 * that had changed under it.
 *
 * A subpath specifier resolves to its package (`react/jsx-runtime` → `react`); `@kernel` has
 * none — it is this repo's own contract, versioned by `KERNEL_API_VERSION` and already checked
 * through a manifest's `kernel` range.
 */
export function packageOf(specifier: string): string | undefined {
  if (specifier === "@kernel") return undefined;
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}
