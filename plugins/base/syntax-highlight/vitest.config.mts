/**
 * A plugin-local Vitest config, the same shape as `markdown/vitest.config.mts` (read its
 * header for why these exist). From `web/`:
 *
 *     npx vitest run --config ../plugins/base/syntax-highlight/vitest.config.mts
 *
 * `engine.test.ts` also runs real grammars when the plugin has been built
 * (`node scripts/build-plugins.mjs syntax-highlight`), and skips that part otherwise.
 */

import { fileURLToPath } from "node:url";

const web = (path: string): string => fileURLToPath(new URL(`../../../web/${path}`, import.meta.url));
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default {
  root: web("."),
  resolve: {
    alias: [
      { find: /^@kernel$/, replacement: web("kernel-api/src/index.ts") },
      { find: /^@kernel\//, replacement: `${web("kernel/src")}/` },
      { find: /^web-tree-sitter$/, replacement: web("node_modules/web-tree-sitter/web-tree-sitter.js") },
    ],
  },
  test: {
    environment: "node",
    include: [here("src/**/*.test.ts")],
  },
};
