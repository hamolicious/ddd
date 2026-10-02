import { defineConfig, devices } from "@playwright/test";

const port = process.env["DDD_E2E_PORT"] ?? "8121";
const baseURL = process.env["DDD_APP"] ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./app/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
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
