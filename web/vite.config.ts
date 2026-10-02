import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const wasmPkg = here("./kernel/src/wasm/pkg/ddd_core.js");

export default defineConfig({
  root: here("./demo"),
  resolve: {
    alias: [
      { find: "@ddd/core-wasm", replacement: wasmPkg },
      { find: /^@kernel$/, replacement: here("./kernel-api/src/index.ts") },
      { find: /^@kernel\//, replacement: `${here("./kernel/src")}/` },
      { find: /^plugin:(.*)$/, replacement: `${here("../plugins/base")}/$1/src/index.tsx` },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.DDD_SERVER ?? "http://127.0.0.1:8080",
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
      "kernel-api/src/**/*.test.ts",
      "harness/src/**/*.test.ts",
      "app/src/**/*.test.ts",
      "../plugins/base/**/*.test.ts",
      "../plugins/base/**/*.test.tsx",
      "../plugins/examples/**/*.test.ts",
      "../plugins/examples/**/*.test.tsx",
    ],
  },
});
