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

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

import {
  RUNTIME_MANIFEST_FILE,
  RUNTIME_SPECIFIERS,
  packageOf,
} from "./app/runtime/specifiers.js";

const require = createRequire(import.meta.url);

/**
 * Specifier → the version of the package this build actually resolved.
 *
 * Recorded so the server can check a plugin's `peerLibraries` *range* against it rather than
 * only checking that the specifier exists (HOST-ABI.md §7.1 step 4). Read from the resolved
 * package's own `package.json`, not from this repo's dependency ranges: a `^18.0.0` in
 * `package.json` is what was asked for, and what is in the chunk is what the browser gets.
 *
 * A package whose version cannot be read is left out rather than guessed at — the server
 * degrades to the presence check for that one library and says so.
 */
function resolveVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const specifier of Object.keys(RUNTIME_SPECIFIERS)) {
    const pkg = packageOf(specifier);
    if (!pkg) continue;
    const version = versionOf(pkg);
    if (version) versions[specifier] = version;
  }
  return versions;
}

/** The `version` in a package's own `package.json`, or `undefined`. */
function versionOf(pkg: string): string | undefined {
  // The direct route, when the package exports its manifest.
  try {
    return readVersion(require.resolve(`${pkg}/package.json`));
  } catch {
    // Most of the runtime layer (`@codemirror/*`, `@lezer/*`, `unified`, the `remark` set)
    // ships an `exports` map with no `./package.json` entry, which makes the direct resolve
    // throw. Resolving the package's *entry point* and walking up to the nearest
    // `package.json` whose `name` matches is what works for those.
  }
  let dir: string;
  try {
    dir = dirname(require.resolve(pkg));
  } catch {
    return undefined;
  }
  while (true) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      // Stop only at the package's *own* manifest: a nested one (a bundled dependency, a
      // `dist/package.json` with `{"type":"module"}` and nothing else) would report the wrong
      // version, which is worse than reporting none.
      if (raw.name === pkg) return typeof raw.version === "string" ? raw.version : undefined;
    }
    const parent = dirname(dir);
    if (parent === dir || !dir.includes(`node_modules${sep}`)) return undefined;
    dir = parent;
  }
}

function readVersion(manifest: string): string | undefined {
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

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
    const versions = resolveVersions();
    writeFileSync(
      join(outDir, RUNTIME_MANIFEST_FILE),
      `${JSON.stringify({ imports, versions }, null, 2)}\n`,
    );
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
