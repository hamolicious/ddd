/**
 * **SPEC §9 M3 acceptance: "the built-in editor replaced by a separately-authored
 * editor plugin."**
 *
 * This is the milestone's gate, so it is worth being precise about what it claims.
 *
 * - The replacement is `plugins/examples/alt-editor`. It lives outside
 *   `plugins/base/`, it imports nothing from any other plugin, and it typechecks
 *   against `web/kernel-api/dist/kernel.d.ts` and nothing else
 *   (`plugins/examples/tsconfig.json` enforces that, not a comment).
 * - "Disabled in the registry" means what it can mean in M3: **the registry is the
 *   directory** the server scans. Enable/disable endpoints and the approval flow are
 *   M4, and `DISABLE_PLUGINS` is all-or-nothing (SPEC §6.1). So this spec composes a
 *   registry containing the thirteen other base plugins plus `alt-editor`, and starts
 *   a second server over it.
 * - The proof is that `document.mode` **has no built-in favourite** (SPEC §6.5): the
 *   `edit` tab is still there, still reachable by the same command and the same
 *   keybinding, and the thing behind it is now a textarea — CodeMirror is not in the
 *   page at all.
 *
 * A second server rather than a restart of the first: the journeys' workspace is
 * still needed, and a spec that reconfigured the shared server would make every other
 * spec's ordering load-bearing.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Browser } from "@playwright/test";

import { ADMIN } from "./helpers.js";

const web = process.cwd(); // Playwright runs with `web/` as the cwd.
const repo = resolve(web, "..");
const PORT = process.env["DDD_E2E_ALT_PORT"] ?? "8122";
const ORIGIN = `http://localhost:${PORT}`;
const REGISTRY = join(web, "app", "e2e", ".plugins", "alt-editor");

let server: ChildProcess | undefined;

test.beforeAll(async () => {
  // The registry: base minus `editor`, plus `alt-editor`.
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

  // Wait for readiness rather than sleeping: a server that is slow to migrate is not
  // a failing server, and a server that never comes up should say so here.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${ORIGIN}/readyz`);
      if (response.ok) break;
    } catch {
      /* not listening yet */
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
  // A fresh database, so this registers the first user.
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
  // The registry says so: `alt-editor` is installed and `editor` is not.
  const listed = await (await fetch(`${ORIGIN}/api/plugins`, { headers: {} })).status;
  expect(listed).toBe(401); // unauthenticated; the UI reads it with a session

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

    // The app works: nothing about removing the built-in editor breaks the shell, the
    // list, or the documents.
    await expect(page.getByRole("banner")).toBeVisible();
    const welcome = page.getByRole("button", { name: "Tasks and lists", exact: true });
    await expect(welcome).toBeVisible();
    await welcome.click();

    // `document.mode` still offers both modes, in the same place, with the same
    // command and the same keybinding — because the surface names neither of them.
    const tabs = page.getByRole("tablist", { name: /document mode/i });
    await expect(tabs.getByRole("tab", { name: "Read" })).toBeVisible();
    const editTab = tabs.getByRole("tab", { name: /^Edit/ });
    await expect(editTab).toBeVisible();
    await editTab.click();

    // And behind it: the replacement, not CodeMirror.
    const area = page.getByTestId("alt-editor-area");
    await expect(area).toBeVisible();
    await expect(page.locator(".cm-editor")).toHaveCount(0);

    // It is a real editor, not a preview: a keystroke reaches the Y.Text, syncs, and
    // comes back materialized as the document's title.
    await area.click();
    await area.press("ControlOrMeta+a");
    await area.fill("---\ntitle: Written by alt-editor\n---\n\nreplacement editor body\n");
    // The textarea commits on input; give the socket the round trip.
    await expect(
      page.getByRole("status", { name: /everything is saved to the server/i }),
    ).toBeVisible({ timeout: 30_000 });

    await expect(page.getByRole("heading", { level: 1, name: "Written by alt-editor" })).toBeVisible(
      { timeout: 20_000 },
    );

    // Read mode still renders it, which is the symmetry claim: the two modes know
    // nothing about each other.
    await tabs.getByRole("tab", { name: "Read" }).click();
    await expect(page.getByText("replacement editor body")).toBeVisible();

    // The mode is reachable by command too (`document.mode.edit` is maintained by the
    // surface for whatever is registered, so it followed the swap).
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("combobox", { name: /command/i });
    await expect(palette).toBeVisible();
    await palette.fill("Show document as: Edit");
    await page.getByRole("option", { name: /Show document as: Edit/ }).first().click();
    await expect(page.getByTestId("alt-editor-area")).toBeVisible();
  } finally {
    await context.close();
  }
});
