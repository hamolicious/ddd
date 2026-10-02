import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Browser } from "@playwright/test";

import { ADMIN } from "./helpers.js";

const web = process.cwd();
const repo = resolve(web, "..");
const PORT = process.env["DDD_E2E_ALT_PORT"] ?? "8122";
const ORIGIN = `http://localhost:${PORT}`;
const REGISTRY = join(web, "app", "e2e", ".plugins", "alt-editor");

let server: ChildProcess | undefined;

test.beforeAll(async () => {
  const compose = spawnSync(
    process.execPath,
    [
      join(web, "scripts", "compose-plugins.mjs"),
      REGISTRY,
      "--exclude=editor",
      "--include-examples=alt-editor",
    ],
    { cwd: repo, encoding: "utf8" },
  );
  expect(compose.status, `compose-plugins: ${compose.stderr ?? ""}`).toBe(0);
  expect(existsSync(join(REGISTRY, "alt-editor", "1.0.0", "manifest.json"))).toBe(true);
  expect(existsSync(join(REGISTRY, "editor"))).toBe(false);

  server = spawn(process.execPath, [join(web, "app", "e2e", "server.mjs")], {
    cwd: web,
    stdio: "inherit",
    env: {
      ...process.env,
      DDD_E2E_PORT: PORT,
      DDD_E2E_DB: "ddd_e2e_alt",
      DDD_E2E_PLUGINS: REGISTRY,
    },
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${ORIGIN}/readyz`);
      if (response.ok) break;
    } catch {
    }
    if (Date.now() > deadline) throw new Error(`the alt-editor server never became ready on ${PORT}`);
    await new Promise((done) => setTimeout(done, 300));
  }
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

async function boot(browser: Browser) {
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  await page.goto("/");
  await page.locator("#email").fill(ADMIN.email);
  await page.locator("#password").fill(ADMIN.password);
  await page.getByRole("button", { name: /create account|sign in/i }).click();
  await expect(
    page.getByRole("status", { name: /everything is saved to the server/i }),
  ).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

test("the built-in editor is replaced by a separately-authored editor plugin", async ({
  browser,
}) => {
  const listed = await (await fetch(`${ORIGIN}/api/plugins`, { headers: {} })).status;
  expect(listed).toBe(401);

  const { context, page } = await boot(browser);
  try {
    const registry = await page.evaluate(async () => {
      const response = await fetch("/api/plugins", { credentials: "include" });
      return (await response.json()) as {
        plugins: { manifest: { id: string } }[];
        problems: unknown[];
      };
    });
    const ids = registry.plugins.map((plugin) => plugin.manifest.id);
    expect(registry.problems).toHaveLength(0);
    expect(ids).toContain("alt-editor");
    expect(ids).not.toContain("editor");

    await expect(page.getByRole("banner")).toBeVisible();
    const welcome = page.getByRole("button", { name: "Tasks and lists", exact: true });
    await expect(welcome).toBeVisible();
    await welcome.click();

    const tabs = page.getByRole("tablist", { name: /document mode/i });
    await expect(tabs.getByRole("tab", { name: "Read" })).toBeVisible();
    const editTab = tabs.getByRole("tab", { name: /^Edit/ });
    await expect(editTab).toBeVisible();
    await editTab.click();

    const area = page.getByTestId("alt-editor-area");
    await expect(area).toBeVisible();
    await expect(page.locator(".cm-editor")).toHaveCount(0);

    await area.click();
    await area.press("ControlOrMeta+a");
    await area.fill("---\ntitle: Written by alt-editor\n---\n\nreplacement editor body\n");
    await expect(
      page.getByRole("status", { name: /everything is saved to the server/i }),
    ).toBeVisible({ timeout: 30_000 });

    await expect(page.getByRole("heading", { level: 1, name: "Written by alt-editor" })).toBeVisible(
      { timeout: 20_000 },
    );

    await tabs.getByRole("tab", { name: "Read" }).click();
    await expect(page.getByText("replacement editor body")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+p");
    const palette = page.getByRole("combobox", { name: /command/i });
    await expect(palette).toBeVisible();
    await palette.fill("Show document as: Edit");
    await page.getByRole("option", { name: /Show document as: Edit/ }).first().click();
    await expect(page.getByTestId("alt-editor-area")).toBeVisible();
  } finally {
    await context.close();
  }
});
