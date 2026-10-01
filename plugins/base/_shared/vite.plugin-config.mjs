/**
 * The reference Vite config for a frontend plugin (SPEC §6.4: "a reference Vite config
 * lives in `plugins/base/*`").
 *
 * Every base plugin is built with this function, and a third-party plugin can use it
 * verbatim — that is the point of it being a function in a file rather than sixteen
 * copies of a config. See `vite.config.example.mjs` next to it for standalone use.
 *
 * Three decisions, all of them consequences of how plugins are loaded:
 *
 * 1. **Library mode, one ES module.** The loader does `import("plugin:<id>")` and reads
 *    the default export (`activate`); the named exports are what other plugins import.
 *    There is no HTML, no CSS injection and no chunking, because a plugin is a module,
 *    not an app.
 * 2. **The blessed runtime layer is external, and so is every other plugin.** `react`,
 *    `react-dom`, `yjs`, `@kernel`, the extension-point-coupled libraries and every
 *    `plugin:<id>` stay bare specifiers in the output and resolve through the server's
 *    import map at load time. Bundling any of them would give the plugin its own React,
 *    its own Yjs or its own copy of a dependency's registries, and the failure would look
 *    like a kernel bug (SPEC §6.4).
 * 3. **`style.css` is a sibling file, not a module import.** The kernel links it on
 *    activation. It is copied normally, or compiled with the opt-in Tailwind preset.
 *
 * A plugin that needs a library *outside* the runtime layer bundles it normally. That
 * is allowed and sometimes right — the cost is bundle size, not correctness. A base
 * plugin has no `node_modules`, so it names such a library in its manifest's `x-bundle`
 * and the library resolves from `resolveFrom` (`web/node_modules`); anything else still
 * resolves from nothing.
 *
 * A plugin that needs more than a module and a stylesheet in its package (a `.wasm`, data
 * files) has a `build.mjs` next to its manifest: its default export runs after the build
 * with `{ root, outDir, resolveFrom }` and writes whatever it needs under `frontend/`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { tailwindPrefix, tailwindPreset } from "./tailwind-preset.mjs";

/**
 * Compile a plugin stylesheet using Tailwind from `resolveFrom`.
 *
 * The virtual `from` path is deliberately inside Tailwind's node_modules: Tailwind
 * resolves its granular CSS imports from that path, while base plugins themselves
 * intentionally have no node_modules directory. The preset omits preflight and does
 * not put utilities in a layer: both would conflict with app-shell CSS.
 */
async function compileWithTailwind({ root, prefix, styleSource, out, resolveFrom }) {
  const require = createRequire(join(resolveFrom, "noop.cjs"));
  const { default: postcss } = await import(require.resolve("postcss"));
  const { default: tailwind } = await import(require.resolve("@tailwindcss/postcss"));
  const nodeModules = join(require.resolve("tailwindcss/package.json"), "..", "..");
  const from = join(nodeModules, ".ddd-plugin-entry.css");
  const entry = [
    tailwindPreset(prefix),
    `@source ${JSON.stringify(join(root, "src"))};`,
    existsSync(styleSource) ? `@import ${JSON.stringify(styleSource)};` : "",
  ].join("\n");
  const result = await postcss([tailwind()]).process(entry, { from, to: out, map: false });

  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, result.css);
}

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

/** Other plugins' public modules (`import { addItem } from "plugin:toolbar"`): never bundled. */
export const PLUGIN_SPECIFIER = /^plugin:/;

/** The directory of package `name`, as resolved from `require`'s location. */
function packageDir(require, name) {
  let dir = dirname(require.resolve(name));
  while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== name) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`x-bundle: cannot find the package directory of ${name}`);
    dir = up;
  }
  return dir;
}

/**
 * @param {object} options
 * @param {string} options.root       The plugin directory (contains manifest.json).
 * @param {string} [options.outDir]   Where to write; default `<root>/dist`.
 * @param {string} [options.entry]    Default `<root>/src/index.tsx`.
 * @param {boolean} [options.tailwind] Compile `style.css` with the Tailwind preset, under
 *   the manifest's class prefix (`tailwindPrefix`). Default: the manifest's `x-tailwind`.
 * @param {string} [options.resolveFrom] Directory from which Tailwind resolves.
 * @returns {import("vite").InlineConfig}
 */
export function pluginConfig({ root, outDir, entry, tailwind, resolveFrom = root }) {
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const out = outDir ?? join(root, "dist");
  const moduleName = manifest.frontend?.module ?? "frontend/index.mjs";
  const stylePath = manifest.frontend?.style;
  const useTailwind = tailwind ?? Boolean(manifest["x-tailwind"]);
  const prefix = useTailwind ? tailwindPrefix(manifest) : "";
  const bundled = manifest["x-bundle"] ?? [];
  const requireFrom = createRequire(join(resolveFrom, "noop.cjs"));
  const bundledDirs = bundled.map((name) => packageDir(requireFrom, name));

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
      // The package directory, not `require.resolve`'s file: Vite then picks the
      // package's browser/ESM entry itself, where `require` would hand it the CommonJS one.
      alias: bundled.map((name, i) => ({ find: new RegExp(`^${name}$`), replacement: bundledDirs[i] })),
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
        external: [...RUNTIME_EXTERNALS, PLUGIN_SPECIFIER],
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
        // Library mode inlines every `new URL("x.wasm", import.meta.url)` as base64, so a
        // bundled library's own wasm would ride along in the module whether it is used or
        // not. Hide the pattern from Vite: the URL still resolves at runtime, and the
        // plugin ships (or points the library at) the file itself, from its `build.mjs`.
        name: "ddd-bundled-assets",
        enforce: "pre",
        transform(code, id) {
          if (!bundledDirs.some((dir) => id.startsWith(`${dir}/`))) return null;
          const out = code.replace(
            /new URL\((\s*(["'`])[^"'`]+\2\s*),\s*import\.meta\.url\s*\)/g,
            "new URL($1, String(import.meta.url))",
          );
          return out === code ? null : { code: out, map: null };
        },
      },
      {
        name: "ddd-plugin-package",
        async closeBundle() {
          // The manifest travels with the build — the server serves this directory as
          // the installed plugin, so the copy here is what `/api/plugins` reads.
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
          if (stylePath) {
            const source = resolve(root, "src", basename(stylePath));
            const target = join(out, stylePath);
            if (useTailwind) {
              await compileWithTailwind({ root, prefix, styleSource: source, out: target, resolveFrom });
            } else if (existsSync(source)) {
              mkdirSync(join(target, ".."), { recursive: true });
              copyFileSync(source, target);
            } else {
              this.warn(`manifest declares ${stylePath} but ${source} does not exist`);
            }
          }
          const step = join(root, "build.mjs");
          if (existsSync(step)) {
            const { default: run } = await import(pathToFileURL(step).href);
            await run({ root, outDir: out, resolveFrom });
          }
        },
      },
    ],
  };
}
