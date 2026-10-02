import { expect, test, type Page } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

const PHONE = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const widest = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > root.clientWidth + 1;
      })
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className)}`)
      .slice(0, 6);
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, widest };
  });
  expect(
    overflow.scrollWidth,
    `the page scrolls sideways; widest offenders: ${overflow.widest.join(", ")}`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

async function mainDoesNotScrollSideways(page: Page): Promise<void> {
  const main = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("main#shell-main");
    return element
      ? { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
      : undefined;
  });
  expect(main, "the shell's main region is on the page").toBeDefined();
  expect(
    main?.scrollWidth ?? 0,
    "main#shell-main scrolls sideways: something inside it is unclipped",
  ).toBeLessThanOrEqual((main?.clientWidth ?? 0) + 1);
}

async function tapTargets(page: Page, selector: string): Promise<void> {
  const small = await page.evaluate((css) => {
    return [...document.querySelectorAll<HTMLElement>(css)]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter((entry) => entry.box.width > 0 && entry.box.height > 0)
      .filter((entry) => entry.box.height < 44 || entry.box.width < 44)
      .map(
        (entry) =>
          `${entry.element.tagName.toLowerCase()} "${(entry.element.textContent ?? "").trim().slice(0, 24)}" ${String(Math.round(entry.box.width))}×${String(Math.round(entry.box.height))}`,
      );
  }, selector);
  expect(small, `controls under 44 px: ${small.join("; ")}`).toEqual([]);
}

async function nothingOffScreen(page: Page): Promise<void> {
  const off = await page.evaluate(() => {
    const width = window.innerWidth;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.children.length === 0)
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter((entry) => entry.box.width > 0 && entry.box.height > 0)
      .filter((entry) => entry.box.right > width + 1 || entry.box.left < -1)
      .map(
        (entry) =>
          `${entry.element.tagName.toLowerCase()}.${String(entry.element.className)} "${(entry.element.textContent ?? "").trim().slice(0, 20)}"`,
      )
      .slice(0, 8);
  });
  expect(off, `off-screen: ${off.join("; ")}`).toEqual([]);
}

test.describe("phone (390 × 844)", () => {
  test.use({ viewport: PHONE });

  test("settings is a list of sections, and opening one gives it the screen", async ({
    page,
  }) => {
    await signIn(page, ADMIN);

    await page.goto("/#/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

    const nav = page.getByRole("navigation", { name: /settings sections/i });
    await expect(nav).toBeVisible();

    const list = nav.locator("ul");
    const box = await list.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
    const listScroll = await list.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(listScroll.scrollWidth).toBeLessThanOrEqual(listScroll.clientWidth + 1);

    await expect(page.locator(".settings-pane")).toBeHidden();
    await tapTargets(page, ".settings-nav-link");
    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
    await nothingOffScreen(page);

    await nav.getByRole("link", { name: "Appearance" }).click();
    await expect(page).toHaveURL(/#\/settings\/themes$/);
    await expect(page.getByRole("heading", { name: "Appearance", level: 2 })).toBeVisible();
    await expect(nav).toBeHidden();
    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);

    await page.getByRole("radio", { name: "Dark" }).check();
    await expect(page.locator(".theme-picker")).toContainText("Showing dark");

    await page.getByRole("link", { name: "All settings" }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(nav).toBeVisible();
    await expect(page.locator(".settings-pane")).toBeHidden();
  });

  test("the account section's form fits and its inputs are full width", async ({ page }) => {
    await signIn(page, ADMIN);

    await page.goto("/#/settings/settings.account");
    await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeVisible();

    const inputs = page.locator(".settings-form input");
    for (const input of await inputs.all()) {
      const box = await input.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(PHONE.width * 0.6);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
    await nothingOffScreen(page);
  });

  test("admin's user and invite rows are cards, with their actions on screen", async ({
    page,
  }) => {
    await signIn(page, ADMIN);

    await page.goto("/#/admin/users");
    await expect(page.getByRole("heading", { name: "Users", level: 3 })).toBeVisible();

    for (const name of ["Reset link", "Delete"]) {
      const button = page.getByRole("button", { name }).first();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${name} has a box`).toBeTruthy();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await expect(page.locator(".admin-table td[data-label='Last sign-in']").first()).toBeVisible();

    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
    await nothingOffScreen(page);

    await page.goto("/#/admin/invites");
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.locator(".admin-secret")).toBeVisible();
    const revoke = page.getByRole("button", { name: "Revoke" }).first();
    await expect(revoke).toBeVisible();
    const box = await revoke.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);

    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
  });

  test("the audit log wraps its ids instead of dragging the page", async ({ page }) => {
    await signIn(page, ADMIN);

    await page.goto("/#/admin/invites");
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.locator(".admin-secret")).toBeVisible();

    await page.goto("/#/admin/audit");
    await expect(page.getByRole("heading", { name: "Audit log", level: 3 })).toBeVisible();
    await expect(page.locator(".admin-audit li").first()).toBeVisible();

    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
    await nothingOffScreen(page);

    const details = page.locator(".admin-audit summary");
    expect(await details.count(), "audit entries with a detail block").toBeGreaterThan(0);
    await tapTargets(page, ".admin-audit summary");

    const target = page.locator(".admin-audit-target button.admin-link").first();
    const id = (await target.innerText()).trim();
    expect(id.length, "an audit entry with a target id").toBeGreaterThan(10);
    await target.click();
    await expect(page.getByLabel("Target id")).toHaveValue(id);
    await noSidewaysScroll(page);
    await nothingOffScreen(page);
  });

  test("a notice panel is not cut off the left edge", async ({ page }) => {
    await page.addInitScript(() => {
      const storage = navigator.storage as unknown as Record<string, unknown>;
      storage["persist"] = () => Promise.resolve(false);
      storage["persisted"] = () => Promise.resolve(false);
    });
    await signIn(page, ADMIN);

    const bell = page.locator(".notices-bell");
    await expect(bell).toBeVisible();
    const panel = page.locator(".notices-panel");
    if (await panel.isHidden()) await bell.click();
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box?.x ?? -1, "the panel's left edge is on screen").toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    expect(box?.height ?? 0).toBeLessThanOrEqual(PHONE.height * 0.6 + 1);

    await tapTargets(page, ".notices-panel button");
    await noSidewaysScroll(page);
  });

  test("safe mode fits, and every disclosure in the app is a tap target", async ({ page }) => {
    await signIn(page, ADMIN);

    await page.goto("/?safe=bare");
    await expect(page.getByRole("heading", { name: /plugin manager/i })).toBeVisible();
    await expect(page.locator(".ddd-bare-table tbody tr").first()).toBeVisible();
    await noSidewaysScroll(page);
    await nothingOffScreen(page);

    await expect(page.locator(".ddd-bare-table td[data-label='Would load']").first()).toBeVisible();
  });
});

test.describe("phone in landscape (844 × 390)", () => {
  test.use({ viewport: LANDSCAPE, hasTouch: true, isMobile: true });

  test("gets the compact layout, not the desktop one", async ({ page }) => {
    await signIn(page, ADMIN);

    const sidebar = page.getByRole("complementary", { name: /sidebar/i });
    await expect(sidebar).toBeHidden();
    await page.locator(".shell-sidebar-toggle").click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS("position", "absolute");
    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();

    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);

    await page.goto("/#/settings");
    await expect(page.locator(".settings-pane")).toBeHidden();
    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
  });
});
