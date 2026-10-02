import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

const registry =
  process.env["DDD_E2E_PLUGINS"] ?? join(process.cwd(), "app", "e2e", ".plugins", "default");
const brokenModule = join(registry, "extra-task-states", "1.0.0", "frontend", "index.mjs");
const brokenManifest = join(registry, "extra-task-states", "1.0.0", "manifest.json");

const SABOTAGE = `export default function activate() {
  throw new Error("extra-task-states: deliberately broken by the E2E suite");
}
`;

const RENDER_SABOTAGE = `import { createElement } from "react";

const Boom = () => {
  throw new Error("extra-task-states: deliberately thrown while rendering");
};

import { addItem } from "plugin:toolbar";
import { addSidebarPanel } from "plugin:shell-ui";

export default function activate() {
  addItem({
    id: "extra-task-states.broken-icon",
    label: "Broken icon",
    side: "end",
    // The toolbar renders an item's icon only inside the actionable form, so the item
    // needs an \`onSelect\` for this to be the case under test at all.
    onSelect: () => undefined,
    icon: createElement(Boom),
  });
  addSidebarPanel({
    id: "extra-task-states.broken-panel",
    title: "Broken panel",
    component: Boom,
  });
}
`;

function withHosts(manifest: string): string {
  const parsed = JSON.parse(manifest) as { dependencies?: Record<string, string> };
  parsed.dependencies = { ...parsed.dependencies, toolbar: "*", "shell-ui": "*" };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function rescan(request: APIRequestContext, base: string): Promise<void> {
  const login = await request.post(`${base}/api/auth/login`, { data: ADMIN });
  expect(login.ok(), `POST /api/auth/login -> ${login.status()}`).toBe(true);
  for (const action of ["disable", "enable"]) {
    const response = await request.post(`${base}/api/admin/plugins/extra-task-states/${action}`, { data: {} });
    expect(response.ok(), `${action} -> ${response.status()} ${await response.text()}`).toBe(true);
  }
}

let original: string;
let originalManifest: string;

test.beforeAll(() => {
  original = readFileSync(brokenModule, "utf8");
  originalManifest = readFileSync(brokenManifest, "utf8");
});

test.afterAll(() => {
  writeFileSync(brokenModule, original);
  writeFileSync(brokenManifest, originalManifest);
});

async function expectWelcomeDocument(page: Page): Promise<void> {
  const search = page.getByRole("searchbox", { name: "Search documents" });
  await expect(search).toBeVisible();
  await search.fill("Welcome to ddd");
  await expect(
    page.locator("#shell-main").getByRole("button", { name: "Welcome to ddd", exact: true }),
  ).toBeVisible();
}

async function freshPage(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  return { context, page: await context.newPage() };
}

test("a broken plugin fails alone, and safe mode boots past it", async ({ browser, baseURL }) => {
  const base = baseURL as string;

  writeFileSync(brokenModule, SABOTAGE);

  {
    const { context, page } = await freshPage(browser, base);
    try {
      await signIn(page, ADMIN);

      await expect(page.getByRole("banner")).toBeVisible();
      await expectWelcomeDocument(page);

      const notice = page.getByText(/1 plugin failed to load/i).first();
      await expect(notice).toBeVisible();
      await expect(page.getByRole("button", { name: /open admin/i }).first()).toBeVisible();

      await expect(page.getByText(/1 plugin failed to load/i)).toHaveCount(1);

      const details = page
        .getByText(/1 plugin failed to load/i)
        .first()
        .locator("xpath=ancestor::li[1]")
        .locator("details");
      await details.first().evaluate((element: HTMLDetailsElement) => {
        element.open = true;
      });
      await expect(details.first()).toContainText("extra-task-states");
      await expect(details.first()).toContainText("deliberately broken");
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage(browser, base);
    try {
      await signIn(page, ADMIN, { path: "/?safe=1" });
      await expect(page.getByRole("banner")).toBeVisible();
      await expectWelcomeDocument(page);
      await expect(page.getByText(/plugin[s]? failed to load/i)).toHaveCount(0);
      await expect(page.getByText(/extra-task-states/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage(browser, base);
    try {
      await page.addInitScript(() => {
        const storage = navigator.storage as unknown as Record<string, unknown>;
        storage["persist"] = () => Promise.resolve(false);
        storage["persisted"] = () => Promise.resolve(false);
      });
      await page.goto("/?safe=bare");
      await page.locator("#email").fill(ADMIN.email);
      await page.locator("#password").fill(ADMIN.password);
      await page.locator("form.ddd-auth-form button[type=submit]").click();

      await expect(page.getByText(/safe mode|plugin manager/i).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator(".ddd-bare")).toBeVisible();
      await expect(page.getByText("shell-ui").first()).toBeVisible();
      await expect(page.getByText("extra-task-states").first()).toBeVisible();
      await expect(page.locator(".shell-root")).toHaveCount(0);
      await expect(page.locator(".doclist")).toHaveCount(0);

      await expect(page.locator(".ddd-notices")).toBeVisible();
      await expect(page.getByText(/may delete this workspace's offline copy/i)).toBeVisible();
    } finally {
      await context.close();
    }
  }

  writeFileSync(brokenModule, original);

  {
    const { context, page } = await freshPage(browser, base);
    try {
      await signIn(page, ADMIN);
      await expectWelcomeDocument(page);
      await expect(page.getByText(/plugin[s]? failed to load/i)).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

test("a plugin that throws while rendering costs a chip, not the application", async ({
  browser,
  baseURL,
  request,
}) => {
  const base = baseURL as string;
  writeFileSync(brokenModule, RENDER_SABOTAGE);
  writeFileSync(brokenManifest, withHosts(originalManifest));
  await rescan(request, base);
  const { context, page } = await freshPage(browser, base);
  try {
    await signIn(page, ADMIN);

    await expect(page.getByRole("banner")).toBeVisible();
    await expectWelcomeDocument(page);

    const chips = page.locator(".ddd-plugin-failed");
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toContainText("extra-task-states");

    const notice = page.getByText(/plugin problem/i).first();
    await expect(notice).toBeVisible();
    await expect(page.getByRole("button", { name: /open admin/i }).first()).toBeVisible();
  } finally {
    await context.close();
    writeFileSync(brokenModule, original);
    writeFileSync(brokenManifest, originalManifest);
    await rescan(request, base);
  }
});

test("an admin enables a disabled plugin from the bare manager", async ({
  browser,
  baseURL,
  request,
}) => {
  const base = baseURL as string;
  writeFileSync(brokenModule, original);

  const login = await request.post(`${base}/api/auth/login`, { data: ADMIN });
  expect(login.ok(), `POST /api/auth/login -> ${login.status()}`).toBe(true);
  const disabled = await request.post(`${base}/api/admin/plugins/extra-task-states/disable`, {
    data: {},
  });
  expect(disabled.ok(), `disable -> ${disabled.status()} ${await disabled.text()}`).toBe(true);

  {
    const { context, page } = await freshPage(browser, base);
    try {
      await page.goto("/?safe=bare");
      await page.locator("#email").fill(ADMIN.email);
      await page.locator("#password").fill(ADMIN.password);
      await page.locator("form.ddd-auth-form button[type=submit]").click();
      await expect(page.locator(".ddd-bare")).toBeVisible({ timeout: 30_000 });

      const row = page
        .locator(".ddd-bare-table tr")
        .filter({ has: page.getByRole("rowheader", { name: "extra-task-states", exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.locator("td").last()).toContainText("no —");

      await expect(page.locator(".ddd-bare footer")).toContainText("Kernel contract");

      const reloaded = page.waitForEvent("load");
      await row.getByRole("button", { name: "Enable extra-task-states" }).click();
      await reloaded;
      const after = page
        .locator(".ddd-bare-table tr")
        .filter({ has: page.getByRole("rowheader", { name: "extra-task-states", exact: true }) });
      await expect(after.locator("td").last()).toHaveText("yes", { timeout: 30_000 });
      await expect(after.getByRole("button", { name: /^Enable/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage(browser, base);
    try {
      await signIn(page, ADMIN);
      await page.goto("/#/admin/plugins");
      await expect(page.getByRole("button", { name: "Disable Extra task states" })).toBeVisible();
    } finally {
      await context.close();
    }
  }
});
