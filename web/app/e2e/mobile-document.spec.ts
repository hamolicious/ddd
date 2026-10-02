import { devices, expect, test, type Locator, type Page } from "@playwright/test";

import { ADMIN, createDocument, openDocument, showSidebar, signIn } from "./helpers.js";

test.use({ ...devices["Pixel 7"] });

const PHONE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 800 };

async function noDocumentOverflow(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const root = document.documentElement;
    const scrollable = (element: Element): boolean => {
      const overflow = getComputedStyle(element).overflowX;
      return overflow === "auto" || overflow === "scroll";
    };
    const offenders = [...document.querySelectorAll<HTMLElement>("main *")]
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

    const read = page.getByRole("tabpanel", { name: "Read" });
    await expect(read.getByRole("heading", { name: "Wide content probe" })).toBeVisible();

    const pane = page.locator(".docsurface-pane");
    const paneBox = await pane.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(paneBox.scrollWidth, "the document pane scrolls sideways").toBeLessThanOrEqual(
      paneBox.clientWidth,
    );

    const link = page.locator(".md-link").first();
    const linkBox = await link.boundingBox();
    expect(linkBox?.x ?? 0).toBeGreaterThanOrEqual(0);
    expect((linkBox?.x ?? 0) + (linkBox?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);

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

    await expect(page.getByRole("tablist", { name: /document mode/i })).toBeHidden();
    const bubble = page.getByRole("button", { name: "Switch to Edit" });
    const box = await bubble.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(PHONE.height);
    await tapTargets(bubble, "the mode button");

    await bubble.click();
    await expect(page.getByRole("button", { name: "Switch to Read" })).toBeVisible();
    const content = page.locator(".cm-content");
    await expect(content).toBeVisible();
    await expect(content).toContainText("Wide content probe");

    const surface = page.locator(".editor-surface");
    expect(
      await surface.evaluate((node) => node.scrollWidth - node.clientWidth),
      "the editor host scrolls sideways instead of its scroller",
    ).toBeLessThanOrEqual(1);

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

    const target = await box.boundingBox();
    expect(target).not.toBeNull();
    const x = (target?.x ?? 0) + (target?.width ?? 0) / 2;
    const y = (target?.y ?? 0) + (target?.height ?? 0) / 2;
    await longPress(page, x, y);

    const menu = page.getByRole("dialog", { name: /task state/i });
    await expect(menu).toBeVisible();

    const menuBox = await menu.boundingBox();
    expect(menuBox?.x ?? -1, "the state menu starts off the left edge").toBeGreaterThanOrEqual(0);
    expect(
      (menuBox?.x ?? 0) + (menuBox?.width ?? 0),
      "the state menu runs past the right edge",
    ).toBeLessThanOrEqual(PHONE.width);
    await tapTargets(menu.getByRole("menuitemradio"), "state menu item");

    await menu.getByRole("menuitemradio", { name: /^done$/i }).click();
    await expect(page.getByRole("checkbox", { name: /done/i }).first()).toBeVisible();

    await noDocumentOverflow(page);
  });
});

test.describe("the document experience at 360px", () => {
  test.use({ viewport: NARROW });

  test("the mode switcher still fits the Android floor", async ({ page, request, baseURL }) => {
    const id = await createDocument(request, baseURL as string, WIDE);
    await signIn(page, ADMIN);
    await openDocument(page, id);

    const bubble = page.getByRole("button", { name: "Switch to Edit" });
    const box = await bubble.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(NARROW.width);

    await bubble.click();
    await expect(page.locator(".cm-content")).toBeVisible();
    await noDocumentOverflow(page);
  });
});

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
      (globalThis as { __dddLongPress?: () => void }).__dddLongPress = () => {
        target.dispatchEvent(new PointerEvent("pointerup", options));
      };
    },
    { x, y },
  );
  await page.waitForTimeout(700);
  await page.evaluate(() => (globalThis as { __dddLongPress?: () => void }).__dddLongPress?.());
}
