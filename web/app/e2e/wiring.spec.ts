/**
 * The wiring editor (PLUGIN-PROTOCOLS §9 step 7, "done when"): an admin unplugs a plugin
 * and reorders two sidebar seats in admin's Wiring tab (`#/admin/wiring`), applies, and a
 * second page that was already open follows each change in place, without a reload. Then
 * everything goes back.
 *
 * The second page's plugin set is read through `window.__lmTest` (`boot/test-hooks.ts`,
 * on when `localStorage["lm:test-hooks"]` is `"1"`), and its screen through the DOM: the
 * sync pill in the header, and the order of the sidebar's panel sections.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { ADMIN, pluginsActivated, showSidebar, signIn } from "./helpers.js";

/** The plugin ids of the sidebar's panels, top to bottom. */
const sidebarOrder = (page: Page): Promise<string[]> =>
  page
    .getByRole("complementary", { name: /sidebar/i })
    .locator("section[data-plugin]")
    .evaluateAll((sections) => sections.map((section) => (section as HTMLElement).dataset["plugin"] ?? ""));

/** The plugins active on a page, from the test hooks. */
const active = (page: Page): Promise<readonly string[]> =>
  page.evaluate(() => (globalThis as unknown as { __lmTest: { resources(): { active: readonly string[] } } }).__lmTest.resources().active);

/** The editor's version pill: "live v12", or "draft v12" while a draft is on top of v12. */
const liveVersion = async (page: Page): Promise<number> => {
  const text = await page.locator(".wiring-toolbar .wiring-pill.live, .wiring-toolbar .wiring-pill.draft").textContent();
  return Number(/v(\d+)/.exec(text ?? "")?.[1] ?? Number.NaN);
};

/**
 * Press Apply and wait for the draft to become the live version. A confirm (the draft adds
 * errors, or stops the editor) is answered; neither is expected here, but a hang would be
 * a worse failure than a click.
 */
async function applyDraft(page: Page): Promise<number> {
  const before = await liveVersion(page);
  const draft = page.getByRole("region", { name: "Draft" });
  await expect(draft).toBeVisible();
  await draft.getByRole("button", { name: "Apply" }).click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: /^Apply v\d+/ });
  await Promise.race([
    expect(draft).toBeHidden({ timeout: 20_000 }),
    confirm.waitFor({ state: "visible", timeout: 20_000 }).then(() => confirm.click()),
  ]);
  await expect(draft).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(".wiring-toolbar .wiring-pill.live")).toHaveText(`live v${before + 1}`);
  return before + 1;
}

/** The seat controls for `plugin` on the selected host port, in the inspector. */
const seatButton = (page: Page, plugin: string, direction: "up" | "down"): Locator =>
  page.getByRole("button", { name: `Move ${plugin} ${direction}` });

test("an admin unplugs and reorders at #/admin/wiring, and an open page follows without a reload", async ({ page, request, baseURL }) => {
  test.setTimeout(180_000);
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
  // Run on its own, the workspace may have no users yet.
  const bootstrap = await request.get(`${baseURL}/api/auth/bootstrap`);
  if (bootstrap.ok() && ((await bootstrap.json()) as { needs_first_user?: boolean }).needs_first_user) {
    await request.post(`${baseURL}/api/auth/register`, { data: ADMIN });
  }
  await signIn(page, ADMIN);

  // The second page: open before anything is applied, on the ordinary app, with the test
  // hooks on so its active plugin set can be read.
  const second = await page.context().newPage();
  await second.goto("/");
  await expect(second.locator("main")).toBeVisible();
  await second.evaluate(() => localStorage.setItem("lm:test-hooks", "1"));
  const secondLoaded = pluginsActivated(second);
  await second.reload();
  await secondLoaded;
  await expect.poll(() => second.evaluate(() => "__lmTest" in globalThis)).toBe(true);
  await showSidebar(second);
  const pill = second.getByRole("status", { name: /everything is saved to the server/i });
  await expect(pill).toBeVisible();
  const initialOrder = await sidebarOrder(second);
  expect(initialOrder).toContain("folders");
  expect(initialOrder).toContain("doc-list");
  expect((await active(second)).includes("sync-status")).toBe(true);
  const reloads: string[] = [];
  second.on("load", () => reloads.push(second.url()));

  // The editor: admin's Wiring tab.
  await page.goto("/#/admin/wiring");
  await expect(page.getByRole("tab", { name: "Wiring" })).toHaveAttribute("aria-selected", "true");
  const graph = page.getByRole("application", { name: "Wiring graph" });
  await expect(graph).toBeVisible();
  await expect(page.locator(".wiring-toolbar .wiring-pill.live")).toBeVisible({ timeout: 30_000 });
  const startVersion = await liveVersion(page);

  // 1. Unplug sync-status: the power button on its box, then Apply.
  await page.getByRole("button", { name: "Unplug sync-status" }).click();
  await expect(page.getByRole("region", { name: "Draft" })).toContainText("1 change");
  const v1 = await applyDraft(page);
  expect(v1).toBe(startVersion + 1);

  // The second page followed in place: no reload, the pill is gone, the plugin is off.
  await expect(pill).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => active(second)).not.toContain("sync-status");
  expect(reloads).toEqual([]);

  // 2. Reorder the sidebar: select shell-ui's sidebar port, move the top one down.
  await page.locator('[data-port="shell-ui:sidebar"]').click();
  const top = initialOrder[0] === "folders" ? "folders" : "doc-list";
  const other = top === "folders" ? "doc-list" : "folders";
  await expect(seatButton(page, top, "down")).toBeVisible();
  await seatButton(page, top, "down").click();
  await expect(page.getByRole("region", { name: "Draft" })).toBeVisible();
  const v2 = await applyDraft(page);
  expect(v2).toBe(v1 + 1);

  await expect.poll(() => sidebarOrder(second)).toEqual([other, top, ...initialOrder.filter((id) => id !== top && id !== other)]);
  expect(reloads).toEqual([]);

  // 3. Put the sidebar back the way it was.
  await page.locator('[data-port="shell-ui:sidebar"]').click();
  await seatButton(page, top, "up").click();
  await expect(page.getByRole("region", { name: "Draft" })).toContainText("1 change");
  const v3 = await applyDraft(page);
  expect(v3).toBe(v2 + 1);
  await expect.poll(() => sidebarOrder(second)).toEqual(initialOrder);
  expect(reloads).toEqual([]);

  // 4. Plug sync-status back in: the second page starts it again, and the pill is back.
  await page.getByRole("button", { name: "Plug in sync-status" }).click();
  await expect(page.getByRole("region", { name: "Draft" })).toContainText("1 change");
  const v4 = await applyDraft(page);
  expect(v4).toBe(v3 + 1);
  await expect.poll(() => active(second), { timeout: 20_000 }).toContain("sync-status");
  await expect(second.getByRole("status", { name: /everything is saved to the server/i })).toBeVisible({ timeout: 20_000 });
  expect(reloads).toEqual([]);

  // The history knows all four, newest first.
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.locator(".wiring-history li").first()).toContainText(`v${v4}`);
});
