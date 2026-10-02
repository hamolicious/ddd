/**
 * The real app build (M3) — `web/app`, the PWA that replaces the M2 demo as the
 * product. The demo stays where it is as a harness fixture.
 *
 * The one unusual thing here is **`external`**: the app bundle does *not* contain
 * React, Yjs, `@kernel` or the extension-point-coupled libraries. They stay bare
 * specifiers in the output and resolve through the server's import map, to exactly
 * the same chunks plugin bundles resolve to (SPEC §6.4). Bundling them instead would
 * give the kernel one React and every plugin another, which breaks hooks, context and
 * `instanceof` across every plugin boundary — the failure would look like a plugin
 * bug and never be one.
 *
 * In `vite dev` none of that applies: the dev server resolves the app's imports
 * itself, and `app/src/loader/importmap.ts` installs a map over *these* modules
 * before the first plugin loads, so dev has one React too.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { RUNTIME_SPECIFIER_NAMES } from "./app/runtime/specifiers.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where `mise run wasm` writes the generated wasm-bindgen package. */
const wasmPkg = here("./kernel/src/wasm/pkg/ddd_core.js");

/**
 * Dev-only `/sw.js`: a service worker that uninstalls itself.
 *
 * A browser that ever visited the *production* build on this origin (`mise run dev` on
 * :8080, say) still has the Workbox worker registered, and it serves the precached old
 * bundle cache-first — before this dev server sees a single request. "It served me an
 * old build and nothing hot reloads" is that worker, every time. Browsers re-fetch
 * `/sw.js` on navigation; handing them this byte-different worker makes the stale one
 * replace itself with a suicide note: caches gone, registration gone, page reloaded
 * straight from Vite.
 */
const swKillswitch = () => ({
  name: "ddd-dev-sw-killswitch",
  configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/sw.js")) return next();
      res.setHeader("content-type", "text/javascript");
      res.setHeader("cache-control", "no-store");
      res.end(`
        self.addEventListener("install", () => self.skipWaiting());
        self.addEventListener("activate", (event) => {
          event.waitUntil((async () => {
            for (const key of await caches.keys()) await caches.delete(key);
            await self.registration.unregister();
            for (const client of await self.clients.matchAll({ type: "window" })) {
              client.navigate(client.url);
            }
          })());
        });
      `);
    });
  },
});

/**
 * The app icons live in the repository's `brand/` directory, shared by every shell, not
 * in `publicDir`. This serves them at the site root in dev and emits them there in the
 * build, so `/icon.svg` and `/icon-maskable.svg` resolve the same either way.
 */
const BRAND_ICONS = ["icon.svg", "icon-maskable.svg"];
const brandIcons = () => ({
  name: "ddd-brand-icons",
  configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      const name = req.url?.split("?")[0].slice(1);
      if (!name || !BRAND_ICONS.includes(name)) return next();
      res.setHeader("content-type", "image/svg+xml");
      res.end(readFileSync(here(`../brand/${name}`)));
    });
  },
  generateBundle(this: { emitFile: (file: { type: "asset"; fileName: string; source: Buffer }) => void }) {
    for (const name of BRAND_ICONS) {
      this.emitFile({ type: "asset", fileName: name, source: readFileSync(here(`../brand/${name}`)) });
    }
  },
});

export default defineConfig(({ command }) => ({
  plugins: command === "serve" ? [swKillswitch(), brandIcons()] : [brandIcons()],
  root: here("./app"),
  publicDir: here("./app/public"),
  resolve: {
    alias: [
      { find: "@ddd/core-wasm", replacement: wasmPkg },
      // Exact `@kernel` is the public contract; `@kernel/…` is kernel internals.
      { find: /^@kernel$/, replacement: here("./kernel-api/src/index.ts") },
      { find: /^@kernel\//, replacement: `${here("./kernel/src")}/` },
    ],
  },
  server: {
    port: 5174,
    proxy: {
      // `/plugins` too: in dev the plugin modules come from the Rust server, so the
      // page origin is one origin and the import map's URLs stay relative.
      "/api": { target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080", ws: true, changeOrigin: false },
      "/plugins": { target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
      "/importmap.json": { target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
      "/kernel.d.ts": { target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
  // The query worker loads the shared core's wasm with a dynamic import, which needs
  // module output; it is created with `type: "module"` (`kernel/src/query/worker-search.ts`).
  worker: { format: "es" },
  build: {
    outDir: here("./app/dist"),
    // The runtime-layer build writes into the same directory first; the orchestrator
    // (`scripts/build-app.mjs`) is what clears it.
    emptyOutDir: false,
    target: "es2022",
    manifest: true,
    sourcemap: true,
    rollupOptions: {
      // Checked against the *unresolved* specifier, before the aliases above run.
      external: command === "build" ? [...RUNTIME_SPECIFIER_NAMES] : [],
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
