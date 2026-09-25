/**
 * The document experience on a phone: `document-surface`, `viewer`, `editor`,
 * `properties`, `markdown`.
 *
 * Why a separate file from `polish.spec.ts`: that one pins a handful of shipped-build
 * regressions across the whole app, and its phone block is one test per *screen*. This
 * one is per *surface a document has* and drives each one's key interaction at the
 * acceptance viewport, because the layout bugs it pins were all invisible to a test that
 * only asserted the screen rendered — the worst of them (a long URL widening the whole
 * reading column to 659 px inside a 390 px pane) needed a document with wide content in
 * it before anything moved at all.
 *
 * The device profile is Playwright's `Pixel 7` rather than a bare viewport: `hasTouch`
 * and `isMobile` are what make the long-press path and `pointer: coarse` real, and the
 * owner's acceptance bar is a real Android phone through the Flutter shell, for which
 * this is the closest proxy the suite can run.
 *
 * Every test ends in `noDocumentOverflow`. `documentElement.scrollWidth <=
 * clientWidth` is the whole statement of "nothing on this page scrolls the page
 * sideways", and `widestInside` names the offender when it fails, because "expected 659
 * to be at most 390" on its own is a bug report with no address on it.
 */

import { devices, expect, test, type Locator, type Page } from "@playwright/test";

import { ADMIN, createDocument, openDocument, showSidebar, signIn } from "./helpers.js";

test.use({ ...devices["Pixel 7"] });

/** The acceptance viewport. `devices["Pixel 7"]` is 412 wide; the bar is 390. */
const PHONE = { width: 390, height: 844 };
/** The common Android floor, where the mode switcher has the least room. */
const NARROW = { width: 360, height: 800 };

/**
 * Nothing may widen the document, and nothing inside the document pane may be clipped
 * off-screen. A container with its own `overflow-x: auto` is the sanctioned exception
 * (fenced code, tables), so it is excluded rather than reported.
 */
async function noDocumentOverflow(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const root = document.documentElement;
    const scrollable = (element: Element): boolean => {
      const overflow = getComputedStyle(element).overflowX;
      return overflow === "auto" || overflow === "scroll";
    };
    const offenders = [...document.querySelectorAll<HTMLElement>("main *")]
      // A zero-sized element has no `clientWidth` to overflow: CodeMirror's cursor and
      // selection layers are 0×0 by design and would otherwise be reported forever.
      .filter((element) => element.clientWidth > 0 && element.clientHeight > 0)
      .filter((element) => element.scrollWidth > element.clientWidth + 1 && !scrollable(element))
      .map((element) => `${element.tagName.toLowerCase()}.${element.className} (${element.scrollWidth}>${element.clientWidth})`)
      .slice(0, 5);
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders };
  });
  expect(
    report.scrollWidth,
    `the page scrolls sideways; clipped: ${report.offenders.join(", ")}`,
  ).toBeLessThanOrEqual(report.clientWidth);
  expect(report.offenders, "content is clipped outside a scroll container").toEqual([]);
}

/** Every interactive control in `locator` clears the 44 px target of SPEC §6.5. */
async function tapTargets(locator: Locator, label: string): Promise<void> {
  const boxes = await locator.evaluateAll((nodes) =>
    nodes
      .filter((node) => (node as HTMLElement).offsetParent !== null)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { name: node.textContent?.trim().slice(0, 24) ?? "", w: box.width, h: box.height };
      }),
  );
  expect(boxes.length, `${label}: nothing matched`).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(Math.min(box.w, box.h), `${label} "${box.name}" is ${box.w}×${box.h}`).toBeGreaterThanOrEqual(44);
  }
}

/**
 * A document whose content is exactly what broke the reading column: an unbreakable URL,
 * a long inline code span, a fenced block and a table (both of which are *allowed* to
 * scroll, inside themselves), and a task list to long-press.
 */
const WIDE = [
  "---",
  "title: Wide content probe",
  "path: mobile",
  "tags: [one, two]",
  "---",
  "",
  "# Wide content probe",
  "",
  "https://example.com/a/very/long/path/that/no/browser/will/break/on/its/own/because/it/contains/no/spaces/at/all/and/keeps/going",
  "",
  "Inline `kubectl get pods --all-namespaces --output=jsonpath={.items[*].metadata.name}` in prose.",
  "",
  "```bash",
  "kubectl get pods --all-namespaces --output=jsonpath={.items[*].metadata.name} | tr ' ' '\\n'",
  "```",
  "",
  "| column one | column two | column three | column four | column five |",
  "|---|---|---|---|---|",
  "| a value | another value | a third value | a fourth value | a fifth |",
  "",
  "- [ ] first task",
  "- [ ] second task",
  "",
].join("\n");

test.describe("the document experience at 390px", () => {
  test.use({ viewport: PHONE });

  test("read mode holds the column, and wide blocks scroll inside themselves", async ({
    page,
    request,
    baseURL,
  }) => {
    const id = await createDocument(request, baseURL as string, WIDE);
    await signIn(page, ADMIN);
    await openDocument(page, id);

    // Scoped to the read pane: the surface header carries the same title as an `h1`.
    const read = page.getByRole("tabpanel", { name: "Read" });
    await expect(read.getByRole("heading", { name: "Wide content probe" })).toBeVisible();

    // The bug this pins: `overflow-wrap: break-word` breaks a word visually but leaves
    // the element's min-content width at the word's full width, so the pane — and with
    // it every heading and paragraph — sized to the URL instead of to the screen.
    const pane = page.locator(".docsurface-pane");
    const paneBox = await pane.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(paneBox.scrollWidth, "the document pane scrolls sideways").toBeLessThanOrEqual(
      paneBox.clientWidth,
    );

    // The link is inside the screen, not merely painted over its edge.
    const link = page.locator(".md-link").first();
    const linkBox = await link.boundingBox();
    expect(linkBox?.x ?? 0).toBeGreaterThanOrEqual(0);
    expect((linkBox?.x ?? 0) + (linkBox?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);

    // A fenced block and a table are the sanctioned exception: they are allowed to be
    // wider than the screen, as long as the scrolling happens in their own box.
    for (const selector of [".md-code", ".md-table-scroll"]) {
      const box = page.locator(selector).first();
      await expect(box).toBeVisible();
      expect(await box.evaluate((node) => getComputedStyle(node).overflowX)).toBe("auto");
      expect((await box.boundingBox())?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
    }

    await noDocumentOverflow(page);
  });

  test("the mode switcher fits, and switching to Edit keeps CodeMirror's scroll inside it", async ({
    page,
    request,
    baseURL,
  }) => {
    const id = await createDocument(request, baseURL as string, WIDE);
    await signIn(page, ADMIN);
    await openDocument(page, id);

    const tabs = page.getByRole("tablist", { name: /document mode/i });
    expect((await tabs.boundingBox())?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
    await tapTargets(page.getByRole("tab"), "mode tab");

    await page.getByRole("tab", { name: "Edit" }).click();
    const content = page.locator(".cm-content");
    await expect(content).toBeVisible();
    await expect(content).toContainText("Wide content probe");

    // Rule 3 of `editor/style.css`: `.cm-scroller` is the only scroller. A long line
    // that CodeMirror will not wrap has to scroll there and nowhere else.
    const surface = page.locator(".editor-surface");
    expect(
      await surface.evaluate((node) => node.scrollWidth - node.clientWidth),
      "the editor host scrolls sideways instead of its scroller",
    ).toBeLessThanOrEqual(1);

    // And typing still reaches the document — the layout fix must not cost the editor.
    await content.click();
    await page.keyboard.type("edited ");
    await expect(content).toContainText("edited ");

    await noDocumentOverflow(page);
  });

  test("a task's state menu opens on long-press and stays inside the screen", async ({
    page,
    request,
    baseURL,
  }) => {
    // Indented, so the marker sits far enough right that an unclamped 12 rem menu
    // anchored to it runs off a 390 px screen — which is exactly the untested case.
    const id = await createDocument(
      request,
      baseURL as string,
      [
        "---",
        "title: Task menu probe",
        "path: mobile",
        "---",
        "",
        "- a parent item",
        "  - another level",
        "    - [ ] the deeply indented task",
        "",
      ].join("\n"),
    );
    await signIn(page, ADMIN);
    await openDocument(page, id);

    const box = page.getByRole("checkbox", { name: /to do/i }).first();
    await expect(box).toBeVisible();
    await tapTargets(page.locator(".md-task-box"), "task checkbox");

    // A real long press: `useLongPress` only listens to touch and pen, and only fires
    // after 500 ms without the finger moving more than 10 px.
    const target = await box.boundingBox();
    expect(target).not.toBeNull();
    const x = (target?.x ?? 0) + (target?.width ?? 0) / 2;
    const y = (target?.y ?? 0) + (target?.height ?? 0) / 2;
    await longPress(page, x, y);

    const menu = page.getByRole("menu", { name: /task state/i });
    await expect(menu).toBeVisible();

    const menuBox = await menu.boundingBox();
    expect(menuBox?.x ?? -1, "the state menu starts off the left edge").toBeGreaterThanOrEqual(0);
    expect(
      (menuBox?.x ?? 0) + (menuBox?.width ?? 0),
      "the state menu runs past the right edge",
    ).toBeLessThanOrEqual(PHONE.width);
    await tapTargets(page.getByRole("menuitem"), "state menu item");

    // The menu is the interaction, not just a box: choosing a state writes it.
    await page.getByRole("menuitem", { name: /^done$/i }).click();
    await expect(page.getByRole("checkbox", { name: /done/i }).first()).toBeVisible();

    await noDocumentOverflow(page);
  });

  test("properties rows stack label over value, with full-size controls", async ({
    page,
    request,
    baseURL,
  }) => {
    const id = await createDocument(request, baseURL as string, WIDE);
    await signIn(page, ADMIN);
    await openDocument(page, id);
    await showSidebar(page);

    const panel = page.locator(".properties-root");
    await expect(panel).toBeVisible();

    // Stacked, not side by side: on a phone the key and its value each get the full
    // column rather than a 34% / 66% split that truncates both.
    const row = page.locator(".properties-row").first();
    const stacked = await row.evaluate((node) => {
      const key = node.querySelector(".properties-key")?.getBoundingClientRect();
      const value = node.querySelector(".properties-value")?.getBoundingClientRect();
      return key && value ? value.top >= key.bottom - 1 : false;
    });
    expect(stacked, "the label and its value are still on one line").toBe(true);

    // The declaration claimed a 44 px target and shipped 34 px, on every row.
    await tapTargets(page.locator(".properties-input"), "property field");
    await tapTargets(page.locator(".properties-remove"), "remove property");
    await tapTargets(page.locator(".properties-chip-remove"), "remove tag");

    // Editing still works through the panel.
    const title = page.locator(".properties-row", { hasText: "title" }).locator("input").first();
    await title.fill("Renamed on a phone");
    await title.blur();
    await expect(page.locator(".docsurface-title")).toHaveText("Renamed on a phone");

    await noDocumentOverflow(page);
  });
});

test.describe("the document experience at 360px", () => {
  test.use({ viewport: NARROW });

  test("the mode switcher still fits the Android floor", async ({ page, request, baseURL }) => {
    const id = await createDocument(request, baseURL as string, WIDE);
    await signIn(page, ADMIN);
    await openDocument(page, id);

    const tabs = page.getByRole("tablist", { name: /document mode/i });
    const tabsBox = await tabs.boundingBox();
    expect(tabsBox?.width ?? 0).toBeLessThanOrEqual(NARROW.width);
    // Full labels, not a truncation: two modes have room even here.
    await expect(page.getByRole("tab", { name: "Read" })).toHaveText("Read");
    await expect(page.getByRole("tab", { name: "Edit" })).toHaveText("Edit");

    await page.getByRole("tab", { name: "Edit" }).click();
    await expect(page.locator(".cm-content")).toBeVisible();
    await noDocumentOverflow(page);
  });
});

/** Press and hold long enough for `useLongPress` (500 ms), without moving. */
async function longPress(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x: px, y: py }) => {
      const target = document.elementFromPoint(px, py);
      if (!target) throw new Error(`nothing at ${px},${py}`);
      const options = {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        clientX: px,
        clientY: py,
      };
      target.dispatchEvent(new PointerEvent("pointerdown", options));
      (globalThis as { __lmLongPress?: () => void }).__lmLongPress = () => {
        target.dispatchEvent(new PointerEvent("pointerup", options));
      };
    },
    { x, y },
  );
  // Real time, because the timer is a real `setTimeout` inside the component.
  await page.waitForTimeout(700);
  await page.evaluate(() => (globalThis as { __lmLongPress?: () => void }).__lmLongPress?.());
}
