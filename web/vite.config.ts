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
    // Array form, because M3 added a specifier that *ends* where another one
    // begins: bare `@kernel` is the public plugin contract (`kernel-api/`), while
    // `@kernel/…` is kernel internals. The exact-match regex has to be tried
    // first — object-form aliases are prefix matches and would swallow it.
    alias: [
      { find: "@life-manager/core-wasm", replacement: wasmPkg },
      { find: /^@kernel$/, replacement: here("./kernel-api/src/index.ts") },
      { find: /^@kernel\//, replacement: `${here("./kernel/src")}/` },
    ],
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
    include: [
      "kernel/src/**/*.test.ts",
      "harness/src/**/*.test.ts",
      // M3: the loader's ordering rules are pure functions and unit-tested.
      "app/src/**/*.test.ts",
      // M3: the base distribution lives outside `web/` (SPEC §8 layout) but is
      // checked and tested by this one config — the `resolve.alias` above is what
      // gives those suites one `@kernel`, and `test.root` is `web/`, so the glob
      // has to climb out. Without this line `npm run test` collects **zero**
      // plugin tests and every base plugin's suite is stranded.
      "../plugins/base/**/*.test.ts",
      "../plugins/base/**/*.test.tsx",
      "../plugins/examples/**/*.test.ts",
      "../plugins/examples/**/*.test.tsx",
    ],
  },
});
