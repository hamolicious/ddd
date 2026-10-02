import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { RUNTIME_SPECIFIER_NAMES } from "./app/runtime/specifiers.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const wasmPkg = here("./kernel/src/wasm/pkg/ddd_core.js");

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
      { find: /^@kernel$/, replacement: here("./kernel-api/src/index.ts") },
      { find: /^@kernel\//, replacement: `${here("./kernel/src")}/` },
    ],
  },
  server: {
    port: 5174,
    proxy: {
      "/api": { target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080", ws: true, changeOrigin: false },
      "/plugins": { target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
      "/importmap.json": { target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
      "/kernel.d.ts": { target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
  worker: { format: "es" },
  build: {
    outDir: here("./app/dist"),
    emptyOutDir: false,
    target: "es2022",
    manifest: true,
    sourcemap: true,
    rollupOptions: {
      external: command === "build" ? [...RUNTIME_SPECIFIER_NAMES] : [],
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
