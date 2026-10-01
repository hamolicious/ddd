/**
 * `document.mode` takes any number of modes, and each mode decides where it applies.
 *
 * The proof is `plugins/examples/source-view`, a third, read-only mode alongside the
 * base distribution's Read and Edit, whose `when` offers it only on documents with a
 * frontmatter block or a machine section. So one registry gives both cases: a document
 * with frontmatter has three modes, a plain note has two — and the switch fits either,
 * as header icons on a wide screen and as the floating button on a phone (a toggle for
 * two modes, a fan of choices for more).
 *
 * Its own server and database, like `acceptance.spec.ts`: the registry differs from the
 * one every other spec runs against.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

const web = process.cwd(); // Playwright runs with `web/` as the cwd.
const repo = resolve(web, "..");
const PORT = process.env["DDD_E2E_MODES_PORT"] ?? "8127";
const ORIGIN = `http://localhost:${PORT}`;
const REGISTRY = join(web, "app", "e2e", ".plugins", "source-view");

let server: ChildProcess | undefined;

test.beforeAll(async () => {
  const compose = spawnSync(
    process.execPath,
    [join(web, "scripts", "compose-plugins.mjs"), REGISTRY, "--include-examples=source-view"],
    { cwd: repo, encoding: "utf8" },
  );
  expect(compose.status, `compose-plugins: ${compose.stderr ?? ""}`).toBe(0);
  expect(existsSync(join(REGISTRY, "source-view", "1.0.0", "manifest.json"))).toBe(true);

  server = spawn(process.execPath, [join(web, "app", "e2e", "server.mjs")], {
    cwd: web,
    stdio: "inherit",
    env: {
      ...process.env,
      DDD_E2E_PORT: PORT,
      DDD_E2E_DB: "ddd_e2e_modes",
      DDD_E2E_PLUGINS: REGISTRY,
    },
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${ORIGIN}/readyz`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`the modes server never became ready on ${PORT}`);
    await new Promise((done) => setTimeout(done, 300));
  }
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

/** Registers on first use (a fresh database), signs in after that. */
async function boot(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL: ORIGIN, ...(viewport ? { viewport } : {}) });
  const page = await context.newPage();
  // The shared helper, not a hand-rolled gate: it waits for every plugin to activate.
  await signIn(page, ADMIN);
  return { context, page };
}

async function create(page: Page, content: string): Promise<string> {
  return page.evaluate(async (text) => {
    const response = await fetch("/api/documents", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    const body = (await response.json()) as { id?: string; _id?: string };
    return (body.id ?? body._id) as string;
  }, content);
}

const WITH_FRONTMATTER = "---\ntitle: Has frontmatter\nstatus: open\n---\n\nbody text\n";
const PLAIN = "# A plain note\n\nnothing hidden here\n";

test("a wide screen shows one icon per mode, and a mode's own rule decides where it appears", async ({
  browser,
}) => {
  const { context, page } = await boot(browser);
  try {
    const rich = await create(page, WITH_FRONTMATTER);
    const plain = await create(page, PLAIN);

    await page.goto(`/#/doc/${rich}`);
    const tabs = page.getByRole("tablist", { name: /document mode/i });
    await expect(tabs.getByRole("tab")).toHaveCount(3);
    for (const name of ["Read", "Edit", "Source"]) {
      // Icons, named by their labels.
      await expect(tabs.getByRole("tab", { name, exact: true })).toHaveText("");
    }
    await tabs.getByRole("tab", { name: "Source", exact: true }).click();
    await expect(page.getByTestId("source-view")).toContainText("status: open");

    // Source's `when` says a plain note has nothing to show it for.
    await page.goto(`/#/doc/${plain}`);
    await expect(page.locator(".docsurface-title")).toHaveText("A plain note");
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(tabs.getByRole("tab", { name: "Source", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("on a phone, two modes toggle and three fan out", async ({ browser }) => {
  const { context, page } = await boot(browser, { width: 390, height: 844 });
  try {
    const rich = await create(page, WITH_FRONTMATTER);
    const plain = await create(page, PLAIN);

    await page.goto(`/#/doc/${plain}`);
    await expect(page.locator(".docsurface-title")).toHaveText("A plain note");
    await page.getByRole("button", { name: "Switch to Edit" }).click();
    await expect(page.locator(".cm-editor")).toBeVisible();
    await page.getByRole("button", { name: "Switch to Read" }).click();
    await expect(page.locator(".cm-editor")).toHaveCount(0);

    await page.goto(`/#/doc/${rich}`);
    const bubble = page.getByRole("button", { name: /mode\. Choose another$/ });
    await expect(bubble).toHaveAttribute("aria-expanded", "false");
    await bubble.click();
    await expect(page.getByRole("button", { name: "Switch to Edit" })).toBeVisible();
    await page.getByRole("button", { name: "Switch to Source" }).click();
    await expect(page.getByTestId("source-view")).toContainText("status: open");
    await expect(page.getByRole("button", { name: "Switch to Edit" })).toHaveCount(0);

    // Opened again, a tap elsewhere folds the choices away.
    await bubble.click();
    await expect(page.getByRole("button", { name: "Switch to Read" })).toBeVisible();
    await page.mouse.click(40, 300);
    await expect(page.getByRole("button", { name: "Switch to Read" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
