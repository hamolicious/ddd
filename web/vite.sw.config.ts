/**
 * The service-worker build. Runs **last**, after the app and runtime bundles exist,
 * because its precache list is read from what they emitted.
 *
 * Workbox is bundled into the worker (a service worker cannot use an import map), and
 * the output is a single `dist/sw.js` at the scope root — a worker served from
 * `/assets/` could only control `/assets/`.
 */

import { readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const outDir = here("./app/dist");

/** Extensions worth precaching: the app shell, its assets, the runtime layer. */
const PRECACHE = new Set([".html", ".js", ".css", ".svg", ".webmanifest", ".woff2"]);

/**
 * Files that must never be precached: the worker itself, build metadata, and
 * **`index.html`** — the server rewrites it per request (import map + CSP nonce), so the
 * shell is a network-first runtime cache instead. See the navigation route in `sw.ts`.
 */
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

/**
 * `virtual:lm-precache`. Every URL is either content-hashed or `index.html`, so only
 * the latter needs a revision — and it gets the build's own timestamp, which is what
 * makes a new deploy produce a new worker.
 */
const precachePlugin: Plugin = {
  name: "lm-precache",
  resolveId(id) {
    return id === "virtual:lm-precache" ? "\0virtual:lm-precache" : undefined;
  },
  load(id) {
    if (id !== "\0virtual:lm-precache") return undefined;
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
