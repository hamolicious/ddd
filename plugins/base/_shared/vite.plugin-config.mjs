/**
 * The reference Vite config for a frontend plugin (SPEC §6.4: "a reference Vite config
 * lives in `plugins/base/*`").
 *
 * Every base plugin is built with this function, and a third-party plugin can use it
 * verbatim — that is the point of it being a function in a file rather than fourteen
 * copies of a config. See `vite.config.example.mjs` next to it for standalone use.
 *
 * Three decisions, all of them consequences of how plugins are loaded:
 *
 * 1. **Library mode, one ES module.** The loader does `import(url)` and reads the
 *    default export; there is no HTML, no CSS injection and no chunking, because a
 *    plugin is a module, not an app.
 * 2. **The blessed runtime layer is external.** `react`, `react-dom`, `yjs`, `@kernel`
 *    and the extension-point-coupled libraries stay bare specifiers in the output and
 *    resolve through the server's import map at load time. Bundling any of them would
 *    give the plugin its own React or its own Yjs, and the failure would look like a
 *    kernel bug (SPEC §6.4).
 * 3. **`style.css` is copied, not imported.** The kernel links it on activation, so it
 *    must be a sibling file rather than something injected by the module.
 *
 * A plugin that needs a library *outside* the runtime layer bundles it normally. That
 * is allowed and sometimes right — the cost is bundle size, not correctness.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Specifiers a plugin must never bundle. Kept in sync with
 * `web/app/runtime/specifiers.ts` — one list, two consumers, and a mismatch shows up as
 * a duplicated library rather than an error, so it is worth checking when either moves.
 */
export const RUNTIME_EXTERNALS = [
  "@kernel",
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "yjs",
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/commands",
  "@codemirror/language",
  "@lezer/common",
  "@lezer/highlight",
  "y-codemirror.next",
  "unified",
  "remark-parse",
  "remark-gfm",
  "remark-directive",
];

/**
 * @param {object} options
 * @param {string} options.root       The plugin directory (contains manifest.json).
 * @param {string} [options.outDir]   Where to write; default `<root>/dist`.
 * @param {string} [options.entry]    Default `<root>/src/index.tsx`.
 * @returns {import("vite").InlineConfig}
 */
export function pluginConfig({ root, outDir, entry }) {
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const out = outDir ?? join(root, "dist");
  const moduleName = manifest.frontend?.module ?? "frontend/index.mjs";
  const stylePath = manifest.frontend?.style;

  return {
    root,
    configFile: false,
    logLevel: "warn",
    // A plugin is not an app: no public dir, no index.html, no dev server.
    publicDir: false,
    resolve: {
      // The base plugins live outside `web/`, and everything they import is either
      // relative or external — so there is nothing to resolve from node_modules here.
      extensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
    },
    esbuild: {
      // The plugins are TSX with the automatic JSX runtime, resolved through the import
      // map to the same React the kernel uses.
      jsx: "automatic",
    },
    build: {
      outDir: out,
      emptyOutDir: true,
      target: "es2022",
      minify: false,
      sourcemap: true,
      cssCodeSplit: false,
      lib: {
        entry: entry ?? join(root, "src", "index.tsx"),
        formats: ["es"],
        fileName: () => moduleName,
      },
      rollupOptions: {
        external: RUNTIME_EXTERNALS,
        output: {
          // Keep the module's exports as written: the loader reads `default`.
          exports: "named",
          // Any code split out lands next to the entry, still inside `frontend/`.
          chunkFileNames: "frontend/chunks/[name]-[hash].mjs",
          assetFileNames: "frontend/assets/[name]-[hash][extname]",
        },
      },
    },
    plugins: [
      {
        name: "lm-plugin-package",
        closeBundle() {
          // The manifest travels with the build — the server serves this directory as
          // the installed plugin, so the copy here is what `/api/plugins` reads.
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
          if (!stylePath) return;
          const source = resolve(root, "src", basename(stylePath));
          if (!existsSync(source)) {
            this.warn(`manifest declares ${stylePath} but ${source} does not exist`);
            return;
          }
          const target = join(out, stylePath);
          mkdirSync(join(target, ".."), { recursive: true });
          copyFileSync(source, target);
        },
      },
    ],
  };
}
