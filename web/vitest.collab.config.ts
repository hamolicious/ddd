import { defineConfig } from "vitest/config";

/**
 * The collaboration suite (`collab/`): real devices against a real server, online and
 * offline. Separate from the unit config because every file starts a server binary
 * and a database (`collab/server.ts`), which `npm test` must not need.
 *
 * Files run one after another: each owns a server, and the E2E launcher composes the
 * plugin registry into one shared directory on every start.
 */
export default defineConfig({
  test: {
    root: ".",
    environment: "node",
    include: ["collab/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // A seed that fails must fail again: no retries hiding a one-in-ten divergence.
    retry: 0,
  },
});
