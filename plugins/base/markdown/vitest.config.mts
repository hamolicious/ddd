/**
 * A plugin-local Vitest config, so `markdown`'s suites are runnable **today**.
 *
 * `web/vite.config.ts` is frozen (`web/CONTRACTS.md` rule 3) and its `test.include` lists
 * `kernel/src`, `harness/src` and `app/src` only — `plugins/base/**` is not in it, so
 * `npm run test` from `web/` collects nothing here. Several base-plugin areas have already
 * committed `*.test.ts` files that are in exactly the same position (`commands`, `router`,
 * `themes`, `search`, `document-surface`, `editor`, `viewer`), so the fix belongs in the
 * scaffold, not in fourteen private configs:
 *
 *     // web/vite.config.ts, test.include
 *     "../plugins/base/**\/*.test.ts",
 *
 *     // web/tsconfig.json, compilerOptions.paths — `plugins/base` is outside `web/`, so
 *     // node resolution never reaches `web/node_modules` and `import … from "vitest"`
 *     // does not typecheck in any of those plugins today
 *     "vitest": ["node_modules/vitest"],
 *
 * Until that lands, from `web/`:
 *
 *     npx vitest run --config ../plugins/base/markdown/vitest.config.mts
 *
 * Two deliberate shapes here. `root` is `web/`, because that is where `node_modules` lives
 * — `unified`, `remark-*`, `react` and `vitest` then resolve exactly as they do for the
 * kernel's own suites, and the `@kernel` alias is the same pair `web/vite.config.ts`
 * installs. And there is **no `import { defineConfig } from "vitest/config"`**: this file
 * sits outside `web/`, so that import is the one thing it cannot resolve. A plain default
 * export is all Vitest needs.
 *
 * When the scaffold picks these files up, delete this file — do not keep two ways to run
 * one suite.
 */

import { fileURLToPath } from "node:url";

const web = (path: string): string => fileURLToPath(new URL(`../../../web/${path}`, import.meta.url));
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default {
  root: web("."),
  resolve: {
    alias: [
      // Exact `@kernel` is the public plugin contract; `@kernel/…` is kernel internals.
      { find: /^@kernel$/, replacement: web("kernel-api/src/index.ts") },
      { find: /^@kernel\//, replacement: `${web("kernel/src")}/` },
    ],
  },
  test: {
    // Pure functions and React element trees — no DOM, exactly like the kernel's suites.
    environment: "node",
    include: [here("src/**/*.test.ts")],
  },
};
