import { fileURLToPath } from "node:url";

const web = (path: string): string => fileURLToPath(new URL(`../../../web/${path}`, import.meta.url));
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default {
  root: web("."),
  resolve: {
    alias: [
      { find: /^@kernel$/, replacement: web("kernel-api/src/index.ts") },
      { find: /^@kernel\//, replacement: `${web("kernel/src")}/` },
      { find: /^plugin:(.*)$/, replacement: `${here("..")}/$1/src/index.tsx` },
      { find: /^web-tree-sitter$/, replacement: web("node_modules/web-tree-sitter/web-tree-sitter.js") },
    ],
  },
  test: {
    environment: "node",
    include: [here("src/**/*.test.ts")],
  },
};
