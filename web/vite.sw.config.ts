import { readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const outDir = here("./app/dist");

const PRECACHE = new Set([".html", ".js", ".css", ".svg", ".webmanifest", ".woff2"]);

const EXCLUDE = new Set(["sw.js", "sw.js.map", "runtime-manifest.json", "index.html"]);

function collect(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full, root));
      continue;
    }
    const url = relative(root, full).split(sep).join(posix.sep);
    if (EXCLUDE.has(url)) continue;
    if (url.endsWith(".map")) continue;
    const dot = url.lastIndexOf(".");
    if (dot < 0 || !PRECACHE.has(url.slice(dot))) continue;
    out.push(`/${url}`);
  }
  return out;
}

const precachePlugin: Plugin = {
  name: "ddd-precache",
  resolveId(id) {
    return id === "virtual:ddd-precache" ? "\0virtual:ddd-precache" : undefined;
  },
  load(id) {
    if (id !== "\0virtual:ddd-precache") return undefined;
    let urls: string[];
    try {
      urls = collect(outDir).sort();
    } catch {
      this.error(
        `no app bundle in ${outDir} — build the app before the service worker (scripts/build-app.mjs does)`,
      );
    }
    const revision = String(Date.now());
    const entries = urls.map((url) => ({
      url,
      revision: /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(url) ? null : revision,
    }));
    return `export const precacheEntries = ${JSON.stringify(entries, null, 2)};\n`;
  },
};

export default defineConfig({
  root: here("./app"),
  publicDir: false,
  plugins: [precachePlugin],
  build: {
    outDir,
    emptyOutDir: false,
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: { sw: here("./app/src/sw.ts") },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "sw-chunks/[name]-[hash].js",
      },
    },
  },
});
