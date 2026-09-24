import { defineConfig, devices } from "@playwright/test";

/**
 * The M3 end-to-end suite: the real PWA, the real server, the real plugin registry.
 *
 * Separate from `playwright.config.ts` on purpose. That one drives the M2 **demo**
 * page through a Vite dev server and is the SPEC §8 smoke; this one drives
 * `web/app/` through the Rust binary, because everything M3 added — the injected
 * import map, the CSP nonce, `/plugins/:id/:version/*`, the service worker — exists
 * only there (SPEC §6.4, §8). Two surfaces, two servers, two configs; merging them
 * would mean one of the two ran against the wrong host.
 *
 * `app/e2e/server.mjs` drops the test database before starting, so "register as the
 * first user" is repeatable. Prerequisites it checks and names: a built binary
 * (`cargo build --bin life-manager`), a built bundle and plugins (`mise run
 * web-build`), and a Mongo from the compose stack.
 *
 * `LM_APP` points the suite at a server you started yourself; `webServer` then
 * reuses it rather than starting another.
 */

const port = process.env["LM_E2E_PORT"] ?? "8121";
const baseURL = process.env["LM_APP"] ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./app/e2e",
  // The journeys share one workspace and one first-user account, and several of them
  // assert on workspace-wide state (the document list, Trash, the audit log). Running
  // them in parallel would make each one's setup another one's flake.
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    // A fresh context per test means a fresh HTTP cache, which matters more here than
    // it looks: plugin URLs are `immutable` (SPEC §8), so a reused profile can serve a
    // plugin build from an earlier run for as long as the version number stays put.
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node app/e2e/server.mjs",
    url: `${baseURL}/healthz`,
    reuseExistingServer: true,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
