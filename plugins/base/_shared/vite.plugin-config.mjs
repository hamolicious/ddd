import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { tailwindPrefix, tailwindPreset } from "./tailwind-preset.mjs";

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

export const PLUGIN_SPECIFIER = /^plugin:/;

function packageDir(require, name) {
  let dir = dirname(require.resolve(name));
  while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== name) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`x-bundle: cannot find the package directory of ${name}`);
    dir = up;
  }
  return dir;
}

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
    publicDir: false,
    resolve: {
      extensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
      alias: bundled.map((name, i) => ({ find: new RegExp(`^${name}$`), replacement: bundledDirs[i] })),
    },
    esbuild: {
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
          exports: "named",
          chunkFileNames: "frontend/chunks/[name]-[hash].mjs",
          assetFileNames: "frontend/assets/[name]-[hash][extname]",
        },
      },
    },
    plugins: [
      {
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
