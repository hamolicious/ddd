/**
 * Phone layout for the shell, settings, themes, admin and the kernel's own screens.
 *
 * The acceptance bar is a real Android phone in the Flutter shell; Playwright's 390 px
 * viewport is the proxy for it, and these are the properties that were measurably
 * wrong in a shipped build:
 *
 * - **The body never scrolls sideways.** `documentElement.scrollWidth <= clientWidth`
 *   is one assertion for a whole class of bug, and it is not enough on its own: the
 *   page held while `main#shell-main` — which *is* an `overflow: auto` box — scrolled
 *   instead, which is the same defect one level down. So `noSidewaysScroll` checks the
 *   document and `mainDoesNotScrollSideways` checks the region the design rule is
 *   actually about.
 * - **Settings is a drill-down, not an 1 860 px strip.** Eleven section names laid out
 *   in a row inside a 374 px scroller showed two and a half of them, with no scrollbar
 *   on a touch device to say the rest existed.
 * - **Admin's destructive actions are on screen.** `Reset link`, `Delete` and `Revoke`
 *   sat 64–167 px past the right edge inside a nested scroller that draws no
 *   scrollbar on Android. Their being *reachable* is the assertion — a stacked card
 *   makes them so, and a test that only asserted "the page does not overflow" would
 *   pass with them still off-screen inside the wrapper.
 * - **Every disclosure and control is a tap target**, including `<summary>`, which the
 *   kernel stylesheet's `button` rule never reached.
 *
 * Landscape (844 × 390) is here for one reason: every `@media (max-width: 640px)` in
 * the tree was off on a rotated phone, so eleven already-written mobile layouts were
 * unreachable in the orientation people read in bed in.
 */

import { expect, test, type Page } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

/** SPEC §6.5's acceptance viewport, and the width the audit measured at. */
const PHONE = { width: 390, height: 844 };
/** The same phone rotated: wider than the old 640 px breakpoint, and 390 px tall. */
const LANDSCAPE = { width: 844, height: 390 };

/** The document itself must never acquire a horizontal scroll. */
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

/**
 * And neither may the main region, which is the same bug one level down: `main` is an
 * `overflow: auto` box, so an unclipped pane inside it makes *the page* scroll
 * sideways instead of the wide thing inside the pane.
 */
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

/** Every element the locator matches is at least 44 px in its smallest dimension. */
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

/** Nothing visible may have its box past either edge of the viewport. */
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

    // The strip is gone: the list is as wide as the screen, not 1 860 px, and every
    // section in it is reachable without a horizontal swipe.
    const list = nav.locator("ul");
    const box = await list.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
    const listScroll = await list.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(listScroll.scrollWidth).toBeLessThanOrEqual(listScroll.clientWidth + 1);

    // No pane beside it at this width: the index is the index.
    await expect(page.locator(".settings-pane")).toBeHidden();
    await tapTargets(page, ".settings-nav-link");
    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
    await nothingOffScreen(page);

    // Drill in. The link is a real navigation, so the URL carries the section.
    await nav.getByRole("link", { name: "Appearance" }).click();
    await expect(page).toHaveURL(/#\/settings\/themes$/);
    await expect(page.getByRole("heading", { name: "Appearance", level: 2 })).toBeVisible();
    await expect(nav).toBeHidden();
    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);

    // The theme picker is the interaction the section exists for.
    await page.getByRole("radio", { name: "Dark" }).check();
    await expect(page.locator(".theme-picker")).toContainText("Showing dark");

    // And back out.
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

    // The two destructive controls used to be 64–167 px past the right edge inside a
    // nested scroller. Reachability is the assertion, not merely "nothing overflows".
    for (const name of ["Reset link", "Delete"]) {
      const button = page.getByRole("button", { name }).first();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${name} has a box`).toBeTruthy();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // A stacked card says what each value is, which the hidden header row no longer can.
    await expect(page.locator(".admin-table td[data-label='Last sign-in']").first()).toBeVisible();

    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
    await nothingOffScreen(page);

    // Creating an invite is the interaction on the next tab, and its own table stacks
    // the same way with `Revoke` on screen.
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

    // The invite created above (or any admin action) puts an entry with a target id in
    // the log; a 26-character ULID rendered through `.admin-link` was a 485 px
    // unbreakable word in a 344 px column.
    await page.goto("/#/admin/invites");
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.locator(".admin-secret")).toBeVisible();

    await page.goto("/#/admin/audit");
    await expect(page.getByRole("heading", { name: "Audit log", level: 3 })).toBeVisible();
    await expect(page.locator(".admin-audit li").first()).toBeVisible();

    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
    await nothingOffScreen(page);

    // Every audit row's "Detail" disclosure — the global `summary` rule's whole reason
    // for existing. These measured 374 × 22.5.
    //
    // Measured on the **unfiltered** log, and before the filter interaction below,
    // deliberately. This used to run after clicking a target id, which filters the log
    // to that one target — and whether *that* target's entries carry a detail block is
    // an accident of which admin action happens to sort first, so the assertion failed
    // roughly one run in four with nothing wrong. The two things this test is about are
    // independent: that a disclosure is a 44 px target, and that filtering by a ULID
    // does not drag the page sideways.
    const details = page.locator(".admin-audit summary");
    expect(await details.count(), "audit entries with a detail block").toBeGreaterThan(0);
    await tapTargets(page, ".admin-audit summary");

    // The interaction: a target id filters the log to that target.
    const target = page.locator(".admin-audit-target button.admin-link").first();
    const id = (await target.innerText()).trim();
    expect(id.length, "an audit entry with a target id").toBeGreaterThan(10);
    await target.click();
    await expect(page.getByLabel("Target id")).toHaveValue(id);
    await noSidewaysScroll(page);
    await nothingOffScreen(page);
  });

  test("a notice panel is not cut off the left edge", async ({ page }) => {
    // Deny storage persistence, which raises a kernel notice during boot. It is the
    // cheapest deterministic way to put something in the bell without breaking a
    // plugin — the same stand-in `safe-mode.spec.ts` uses.
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

    // `right: 0` against the bell put the left edge at x = −9 on this screen and cut
    // the first characters off every notice.
    const box = await panel.boundingBox();
    expect(box?.x ?? -1, "the panel's left edge is on screen").toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    // And it is bounded by the visible height, not by the large viewport.
    expect(box?.height ?? 0).toBeLessThanOrEqual(PHONE.height * 0.6 + 1);

    await tapTargets(page, ".notices-panel button");
    await noSidewaysScroll(page);
  });

  test("safe mode fits, and every disclosure in the app is a tap target", async ({ page }) => {
    await signIn(page, ADMIN);

    // `?safe=bare` is the last recovery screen; it must not be the one that does not fit.
    await page.goto("/?safe=bare");
    await expect(page.getByRole("heading", { name: /plugin manager/i })).toBeVisible();
    await expect(page.locator(".ddd-bare-table tbody tr").first()).toBeVisible();
    await noSidewaysScroll(page);
    await nothingOffScreen(page);

    // The stacked card labels each cell, since the header row is hidden at this width.
    await expect(page.locator(".ddd-bare-table td[data-label='Would load']").first()).toBeVisible();
  });
});

test.describe("phone in landscape (844 × 390)", () => {
  /*
   * `hasTouch`, because the shared query is `(max-width: 640px), (max-height: 480px)
   * and (pointer: coarse)` (`plugins/base/_shared/compact.ts`) — the coarse arm is what
   * keeps a short *desktop* window on the wide layout, so a rotated phone has to be
   * emulated as a touch device or this asserts the wrong thing about the wrong device.
   */
  test.use({ viewport: LANDSCAPE, hasTouch: true, isMobile: true });

  test("gets the compact layout, not the desktop one", async ({ page }) => {
    await signIn(page, ADMIN);

    // The sidebar is a drawer, not a 270 px column eating a third of the screen. It is
    // the single observable that says the breakpoint fired: every other compact rule in
    // the tree keys off the same query.
    const sidebar = page.getByRole("complementary", { name: /sidebar/i });
    await expect(sidebar).toBeHidden();
    await page.locator(".shell-sidebar-toggle").click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS("position", "absolute");
    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();

    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);

    // And settings uses its compact drill-down here too, rather than a two-column grid
    // squeezed into 302 px of content.
    await page.goto("/#/settings");
    await expect(page.locator(".settings-pane")).toBeHidden();
    await noSidewaysScroll(page);
    await mainDoesNotScrollSideways(page);
  });
});
