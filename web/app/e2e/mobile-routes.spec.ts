/**
 * The permanent regression net: **every route in the app, at 390 px, never scrolls the
 * page sideways.**
 *
 * The three mobile specs beside this one each own a group of surfaces and assert the
 * interactions on them. This one owns the single rule that has to hold everywhere and
 * that no group can enforce for another: a design rule from the brief — *the body never
 * scrolls horizontally; wide content scrolls inside its own container* — checked on
 * every registered `router.route`, so a plugin that reintroduces the defect fails here
 * even when nobody thought to extend that plugin's own spec.
 *
 * Three things make it a net rather than a formality:
 *
 * 1. **It checks three levels, because two were not enough.**
 *    `documentElement.scrollWidth <= clientWidth` was already true across the whole app
 *    when the audit ran — the body was held while `main#shell-main`, which *is* an
 *    `overflow: auto` box, scrolled instead. That is the same defect one level down, so
 *    the region is asserted too. And *that* is still not enough: the worst layout bug
 *    the audit found (B-1, a pasted URL stretching the reading pane to 659 px in a
 *    390 px viewport) shows up in neither number, because `.docsurface-pane` is an
 *    `overflow-x: auto` box as well — the page held, `main` held, and the article inside
 *    was 651 px wide with its `<h1>` running off the screen. Verified by putting that
 *    regression back into the served CSS: the first two checks passed it.
 *
 *    So the third check is the one that matters on a phone: **a block of text must fit
 *    the screen.** Headings, paragraphs and list items are what a person reads by
 *    scrolling *down*, and any of them wider than the viewport means reading sideways.
 *    A wide table or a long fenced line is exempt — scrolling those inside their own
 *    container is the sanctioned pattern and the brief says so.
 * 2. **It sweeps, it does not stop.** Every route is visited and every offender
 *    collected before the expectation runs, so one regression does not hide the other
 *    nine. The failure message names the route, the measured widths and the widest
 *    leaf elements that caused it.
 * 3. **The routes are discovered from the running app**, not typed out here: the
 *    settings sections come from the rendered nav and the admin sections from the
 *    rendered tablist, so a section contributed tomorrow is swept tomorrow without
 *    this file changing. Reading them from plugin source instead would mean importing
 *    another plugin's module into the suite, which is the thing plugins may not do.
 *
 * The document it sweeps is deliberately hostile: a 300-character URL, a long inline
 * code span and a table wider than the screen are what set `.docsurface-pane`'s
 * intrinsic minimum width to 659 px in a 390 px viewport. A sweep over empty documents
 * proves nothing about the page people paste links into.
 */

import { devices, expect, test, type Page } from "@playwright/test";

import { ADMIN, createDocument, signIn } from "./helpers.js";

/** SPEC §6.5's acceptance viewport: the phone the owner tests on. */
const PHONE = { width: 390, height: 844 };

test.use({ ...devices["Pixel 7"], viewport: PHONE });

/**
 * Content chosen to break the layout if anything is allowed to size to its content:
 * an unbreakable 300-character token, an unbreakable inline-code span, a table wider
 * than the viewport, an unwrapped fence and a deeply indented list. Every one of these
 * is an ordinary thing to have in a note.
 */
const HOSTILE = [
  "---",
  "title: Wide content",
  "path: sweep",
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

/**
 * Measure the document and the main region on whatever is currently rendered.
 *
 * Returns the failures rather than asserting, so the caller can finish the sweep and
 * report all of them at once. One pixel of slack on each: sub-pixel layout rounding
 * produces fractional differences on perfectly correct pages.
 */
async function measure(page: Page, where: string): Promise<Overflow[]> {
  const result = await page.evaluate(() => {
    const describe = (element: HTMLElement): string => {
      const classes = String(element.className).trim().split(/\s+/).filter(Boolean);
      return `${element.tagName.toLowerCase()}${classes.length > 0 ? `.${classes.join(".")}` : ""}`;
    };

    const root = document.documentElement;
    // The elements physically past the right edge, leaves only: a parent is wide
    // because a child in it is, and naming the child is what points at the fix.
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.right > root.clientWidth + 1;
      })
      .filter((element) => element.querySelector("*") === null)
      .map(describe)
      .slice(0, 8);

    // Text a person reads by scrolling down. Anything here wider than the screen has
    // to be read by scrolling sideways, which is the defect whatever box it sits in.
    // `pre`, `table` and `code` are exempt: wide content scrolling inside its own
    // container is the pattern the brief asks for, not a bug.
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

/** Go to a hash route, wait for the region to render, and measure it. */
async function sweep(page: Page, routes: readonly string[]): Promise<Overflow[]> {
  const failures: Overflow[] = [];
  for (const route of routes) {
    await page.goto(`/#${route}`);
    // The shell is up by this point (the first navigation activated the plugins);
    // what varies is the view inside it, so wait on the region rather than on any one
    // view's own markup. A view rendering from the local projection settles within a
    // frame, and this is the cheapest way to be after that frame rather than in it.
    await expect(page.locator("main#shell-main")).toBeVisible();
    await page.waitForTimeout(250);
    failures.push(...(await measure(page, route)));
  }
  return failures;
}

/** Turn the collected failures into one readable message. */
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
      "/folder?path=",
      "/folder?path=sweep",
      `/doc/${id}`,
      // A route no plugin claims, and a document id nothing resolves. The not-found
      // view renders the id it could not find, which is the longest string on it.
      "/doc/01JZZZZZZZZZZZZZZZZZZZZZZZ",
      "/nothing-claims-this-route",
    ]);

    // Edit mode is a *mode*, not a URL (it is remembered per document as a per-user
    // setting), so the only way to sweep it is to switch to it. It is a different
    // layout over the same hostile content and has to hold the page just as read mode
    // does — CodeMirror's scroller is the usual way it does not.
    await page.goto(`/#/doc/${id}`);
    await expect(page.getByRole("tablist", { name: /document mode/i })).toBeVisible();
    await page.getByRole("tab", { name: /edit/i }).click();
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

    // The tabs carry their own ids in the URL they navigate to; reading them off the
    // rendered tablist keeps this in step with whatever `admin` ships.
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

    // Not routes, but the three things that render *over* every route — and each was
    // a separate off-screen defect in the audit (the drawer's tree, the palette sheet,
    // and a notice panel clipped off the left edge).
    const drawer = page.locator(".header-sidebar-toggle");
    await drawer.click();
    await expect(page.getByRole("complementary", { name: /sidebar/i })).toBeVisible();
    await page.waitForTimeout(250);
    failures.push(...(await measure(page, "the sidebar drawer")));
    await drawer.click();

    await page.keyboard.press("ControlOrMeta+k");
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
    // A context with no session: the gate is the first thing a phone ever renders,
    // and it renders outside the shell, so `main#shell-main` does not exist yet.
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
      // `?safe=bare` is the kernel's own manager: no plugins, no shell — the screen a
      // user reaches when everything else is broken, and so exactly the screen that
      // must not need a horizontal scroll to be read. `signIn`'s waits do not apply
      // here (there is no shell and no loader line); the gate is the same one.
      await page.goto("/?safe=bare");
      await page.locator("#email").fill(ADMIN.email);
      await page.locator("#password").fill(ADMIN.password);
      await page.locator("form.lm-auth-form button[type=submit]").click();
      await expect(page.locator(".lm-bare")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(250);
      failures.push(...(await measure(page, "?safe=bare")));

      // `?safe=1` is the base distribution with nothing else: a real shell, and the
      // route every other test here sweeps, reached the way a recovering user reaches
      // it.
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
