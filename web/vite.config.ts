import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where `mise run wasm` writes the generated wasm-bindgen package. */
const wasmPkg = here("./kernel/src/wasm/pkg/life_manager_core.js");

/**
 * M2 dev setup: the demo page is the app, the kernel is a plain source
 * directory (no build step, no React — that is M3), and `/api` is proxied to the
 * Rust server so cookies, the Origin check and the WebSocket all behave the way
 * they will in production.
 */
export default defineConfig({
  root: here("./demo"),
  resolve: {
    alias: {
      "@life-manager/core-wasm": wasmPkg,
      "@kernel": here("./kernel/src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.LM_SERVER ?? "http://127.0.0.1:8080",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: here("./dist"),
    emptyOutDir: true,
    target: "es2022",
  },
  test: {
    root: here("."),
    environment: "node",
    include: ["kernel/src/**/*.test.ts", "harness/src/**/*.test.ts"],
  },
});
