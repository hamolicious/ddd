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

import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { RUNTIME_SPECIFIER_NAMES } from "./app/runtime/specifiers.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where `mise run wasm` writes the generated wasm-bindgen package. */
const wasmPkg = here("./kernel/src/wasm/pkg/life_manager_core.js");

export default defineConfig(({ command }) => ({
  root: here("./app"),
  publicDir: here("./app/public"),
  resolve: {
    alias: [
      { find: "@life-manager/core-wasm", replacement: wasmPkg },
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
      "/api": { target: process.env.LM_SERVER ?? "http://127.0.0.1:8080", ws: true, changeOrigin: false },
      "/plugins": { target: process.env.LM_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
      "/importmap.json": { target: process.env.LM_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
      "/kernel.d.ts": { target: process.env.LM_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
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
