import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./demo/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.DDD_WEB ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: process.env.DDD_WEB ?? "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
