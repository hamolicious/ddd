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

function versionOf(pkg: string): string | undefined {
  try {
    return readVersion(require.resolve(`${pkg}/package.json`));
  } catch {
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

const input: Record<string, string> = {};
const specifierOf = new Map<string, string>();
for (const [specifier, file] of Object.entries(RUNTIME_SPECIFIERS)) {
  const name = file.replace(/\.(?:ts|js)$/, "");
  input[name] = here(`./app/runtime/${file}`);
  specifierOf.set(name, specifier);
}

const manifestPlugin: Plugin = {
  name: "ddd-runtime-manifest",
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
