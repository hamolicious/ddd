/**
 * The runtime layer build: one chunk per blessed specifier (SPEC §6.4).
 *
 * Every entry is a one-line re-export module (`app/runtime/*.ts`). Rollup gives the
 * shared dependencies one copy each — `react-dom` and `react` end up pointing at the
 * *same* React chunk — which is the whole reason this build exists: the import map
 * can then hand the kernel and every plugin the identical module instance.
 *
 * `runtime-manifest.json` records specifier → emitted URL. The server reads it to
 * build `/importmap.json` and the inline map in `index.html`; without it the server
 * falls back to a built-in default and says so.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

import { RUNTIME_MANIFEST_FILE, RUNTIME_SPECIFIERS } from "./app/runtime/specifiers.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const outDir = here("./app/dist");

/** Entry name → source file, and entry name → the specifier it serves. */
const input: Record<string, string> = {};
const specifierOf = new Map<string, string>();
for (const [specifier, file] of Object.entries(RUNTIME_SPECIFIERS)) {
  const name = file.replace(/\.(?:ts|js)$/, "");
  input[name] = here(`./app/runtime/${file}`);
  specifierOf.set(name, specifier);
}

/** Write `runtime-manifest.json` from what Rollup actually emitted. */
const manifestPlugin: Plugin = {
  name: "lm-runtime-manifest",
  writeBundle(_options, bundle) {
    const imports: Record<string, string> = {};
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== "chunk" || !chunk.isEntry || !chunk.name) continue;
      const specifier = specifierOf.get(chunk.name);
      if (specifier) imports[specifier] = `/${chunk.fileName}`;
    }
    const missing = [...specifierOf.values()].filter((specifier) => !imports[specifier]);
    if (missing.length > 0) {
      this.error(`runtime layer: no chunk emitted for ${missing.join(", ")}`);
    }
    writeFileSync(join(outDir, RUNTIME_MANIFEST_FILE), `${JSON.stringify({ imports }, null, 2)}\n`);
  },
};

export default defineConfig({
  root: here("./app"),
  // No `public/` copy here; the app build owns that.
  publicDir: false,
  resolve: {
    alias: [{ find: /^@kernel$/, replacement: here("./kernel-api/src/index.ts") }],
  },
  plugins: [manifestPlugin],
  build: {
    outDir,
    emptyOutDir: false,
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input,
      // Entry signatures must survive: these modules exist to be re-exported.
      preserveEntrySignatures: "allow-extension",
      output: {
        format: "es",
        entryFileNames: "runtime/[name]-[hash].js",
        chunkFileNames: "runtime/shared/[name]-[hash].js",
        assetFileNames: "runtime/[name]-[hash][extname]",
      },
    },
  },
});
