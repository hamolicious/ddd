import { devices, expect, test, type Page } from "@playwright/test";

import { ADMIN, createDocument, modeSwitch, signIn } from "./helpers.js";

const PHONE = { width: 390, height: 844 };

test.use({ ...devices["Pixel 7"], viewport: PHONE });

const HOSTILE = [
  "---",
  "title: Wide content",
  "---",
  "",
  "# Wide content",
  "",
  `A pasted link: https://example.com/${"segment-".repeat(30)}end`,
  "",
  "Inline code: `" + "abcdefghij".repeat(12) + "`",
  "",
  "| Column one | Column two | Column three | Column four | Column five |",
  "|---|---|---|---|---|",
  "| a very long cell value | another long cell | and a third | and a fourth | and a fifth |",
  "",
  "```",
  "an unwrapped fenced line ".repeat(12),
  "```",
  "",
  "- [ ] top level",
  "  - [ ] nested once",
  "    - [ ] nested twice with a reasonably long label on it",
  "",
].join("\n");

interface Overflow {
  readonly where: string;
  readonly what: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly offenders: readonly string[];
}

async function measure(page: Page, where: string): Promise<Overflow[]> {
  const result = await page.evaluate(() => {
    const describe = (element: HTMLElement): string => {
      const classes = String(element.className).trim().split(/\s+/).filter(Boolean);
      return `${element.tagName.toLowerCase()}${classes.length > 0 ? `.${classes.join(".")}` : ""}`;
    };

    const root = document.documentElement;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.right > root.clientWidth + 1;
      })
      .filter((element) => element.querySelector("*") === null)
      .map(describe)
      .slice(0, 8);

    const wideText = [...document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, p, li")]
      .filter((element) => element.closest("pre, table, code") === null)
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter((entry) => entry.box.height > 0 && entry.box.width > root.clientWidth + 1)
      .map((entry) => `${describe(entry.element)} ${String(Math.round(entry.box.width))}px wide`)
      .slice(0, 8);

    const main = document.querySelector<HTMLElement>("main#shell-main");
    return {
      document: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth },
      main: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth } : undefined,
      viewport: root.clientWidth,
      offenders,
      wideText,
    };
  });

  const failures: Overflow[] = [];
  if (result.document.scrollWidth > result.document.clientWidth + 1) {
    failures.push({ where, what: "the document", ...result.document, offenders: result.offenders });
  }
  if (result.main && result.main.scrollWidth > result.main.clientWidth + 1) {
    failures.push({ where, what: "main#shell-main", ...result.main, offenders: result.offenders });
  }
  if (result.wideText.length > 0) {
    failures.push({
      where,
      what: "a block of text is wider than the screen",
      scrollWidth: result.viewport,
      clientWidth: result.viewport,
      offenders: result.wideText,
    });
  }
  return failures;
}

async function sweep(page: Page, routes: readonly string[]): Promise<Overflow[]> {
  const failures: Overflow[] = [];
  for (const route of routes) {
    await page.goto(`/#${route}`);
    await expect(page.locator("main#shell-main")).toBeVisible();
    await page.waitForTimeout(250);
    failures.push(...(await measure(page, route)));
  }
  return failures;
}

function report(failures: readonly Overflow[]): string {
  return failures
    .map((failure) => {
      const measurement =
        failure.scrollWidth === failure.clientWidth
          ? `in a ${String(Math.round(failure.clientWidth))} px viewport`
          : `scrolls sideways (${String(Math.round(failure.scrollWidth))} > ${String(Math.round(failure.clientWidth))})`;
      return (
        `${failure.where} — ${failure.what} ${measurement}; ` +
        `offenders: ${failure.offenders.join(", ") || "none measured"}`
      );
    })
    .join("\n");
}

test.describe("every route at 390 px", () => {
  test("browse, search and document routes hold the page", async ({ page, request, baseURL }) => {
    const id = await createDocument(request, baseURL ?? "", HOSTILE);
    await signIn(page);

    const failures = await sweep(page, [
      "/",
      "/trash",
      "/search",
      "/search?q=wide",
      `/doc/${id}`,
      "/doc/01JZZZZZZZZZZZZZZZZZZZZZZZ",
      "/nothing-claims-this-route",
    ]);

    await page.goto(`/#/doc/${id}`);
    await expect(modeSwitch(page)).toBeVisible();
    await page.getByRole("button", { name: "Switch to Edit" }).click();
    await expect(page.locator(".cm-editor")).toBeVisible();
    await page.waitForTimeout(250);
    failures.push(...(await measure(page, `/doc/${id} in edit mode`)));

    expect(failures, report(failures)).toEqual([]);
  });

  test("every settings section holds the page", async ({ page }) => {
    await signIn(page);
    await page.goto("/#/settings");
    await expect(page.locator("main#shell-main")).toBeVisible();

    const routes = await page.locator(".settings-nav-link").evaluateAll((links) =>
      links
        .map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? "")
        .map((href) => href.replace(/^[^#]*#/, ""))
        .filter((route) => route.startsWith("/settings/")),
    );
    expect(routes.length, "the settings screen lists its sections").toBeGreaterThan(3);

    const failures = await sweep(page, ["/settings", ...routes]);
    expect(failures, report(failures)).toEqual([]);
  });

  test("every admin section holds the page", async ({ page }) => {
    await signIn(page);
    await page.goto("/#/admin");
    await expect(page.locator("main#shell-main")).toBeVisible();

    const sections = await page
      .getByRole("tab")
      .evaluateAll((tabs) =>
        tabs.map((tab) => (tab.textContent ?? "").trim()).filter((label) => label !== ""),
      );
    expect(sections.length, "the admin screen has its tabs").toBeGreaterThan(3);

    const failures: Overflow[] = [...(await measure(page, "/admin"))];
    for (const label of sections) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      await page.waitForTimeout(400);
      failures.push(...(await measure(page, `/admin — ${label}`)));
    }
    expect(failures, report(failures)).toEqual([]);
  });

  test("the drawer, the palette and the notice panel hold the page", async ({ page }) => {
    await signIn(page);
    const failures: Overflow[] = [];

    const drawer = page.locator(".shell-sidebar-toggle");
    await drawer.click();
    await expect(page.getByRole("complementary", { name: /sidebar/i })).toBeVisible();
    await page.waitForTimeout(250);
    failures.push(...(await measure(page, "the sidebar drawer")));
    await drawer.click();

    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.getByRole("combobox", { name: /command/i })).toBeVisible();
    await page.waitForTimeout(250);
    failures.push(...(await measure(page, "the command palette")));
    await page.keyboard.press("Escape");

    const bell = page.locator(".notices-bell");
    if ((await bell.count()) > 0 && (await bell.isVisible())) {
      await bell.click();
      await page.waitForTimeout(250);
      failures.push(...(await measure(page, "the notice panel")));
    }

    expect(failures, report(failures)).toEqual([]);
  });

  test("the auth gate holds the page", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["Pixel 7"], viewport: PHONE });
    const page = await context.newPage();
    const failures: Overflow[] = [];
    try {
      await page.goto("/");
      await expect(page.locator("#email")).toBeVisible();
      failures.push(...(await measure(page, "the auth gate")));

      await page.getByRole("button", { name: /i have an invite/i }).click();
      await expect(page.locator("#invite")).toBeVisible();
      failures.push(...(await measure(page, "the auth gate, invite mode")));
    } finally {
      await context.close();
    }
    expect(failures, report(failures)).toEqual([]);
  });

  test("safe mode holds the page", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["Pixel 7"], viewport: PHONE });
    const page = await context.newPage();
    const failures: Overflow[] = [];
    try {
      await page.goto("/?safe=bare");
      await page.locator("#email").fill(ADMIN.email);
      await page.locator("#password").fill(ADMIN.password);
      await page.locator("form.ddd-auth-form button[type=submit]").click();
      await expect(page.locator(".ddd-bare")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(250);
      failures.push(...(await measure(page, "?safe=bare")));

      await page.goto("/?safe=1");
      await expect(page.locator("main")).toBeVisible();
      await page.waitForTimeout(500);
      failures.push(...(await measure(page, "?safe=1")));
    } finally {
      await context.close();
    }
    expect(failures, report(failures)).toEqual([]);
  });
});
