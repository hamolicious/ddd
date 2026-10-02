import { expect, test, type Page } from "@playwright/test";

import { ADMIN, createDocument, docRows, modeSwitch, openDocument, signIn } from "./helpers.js";

const LISTS = [
  "---",
  "title: List alignment fixture",
  "---",
  "",
  "A paragraph at the body margin.",
  "",
  "- [ ] top level task",
  "  - [ ] nested task",
  "    - [ ] deeper task",
  "",
  "- bullet one",
  "  - nested bullet",
  "",
  "1. numbered one",
  "",
  "- [ ] task in a mixed list",
  "- plain bullet in the same list",
  "",
].join("\n");

async function readPane(page: Page) {
  await expect(modeSwitch(page)).toBeVisible();
  const back = page.getByRole("button", { name: "Switch to Read" });
  if (await back.isVisible()) await back.click();
  const tab = page.getByRole("tab", { name: "Read" });
  if ((await tab.isVisible()) && (await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  return page.getByRole("tabpanel", { name: "Read" });
}

async function leftEdge(page: Page, selector: string, index = 0): Promise<number> {
  const box = await page.locator(selector).nth(index).boundingBox();
  expect(box, `nothing matched ${selector}[${String(index)}]`).not.toBeNull();
  return box?.x ?? Number.NaN;
}

test.describe("markdown list alignment", () => {
  test("a top-level task starts where a paragraph starts, and steps like a bullet", async ({
    page,
    request,
    baseURL,
  }) => {
    const id = await createDocument(request, baseURL as string, LISTS);
    await signIn(page, ADMIN);
    await openDocument(page, id);

    const read = await readPane(page);
    await expect(read.locator(".md-root")).toBeVisible();
    await expect(read.getByRole("checkbox").first()).toBeVisible();

    const paragraph = await leftEdge(page, ".md-root > p");
    const task = await leftEdge(page, ".md-root > ul > li.md-task");
    const taskText = await leftEdge(page, ".md-root > ul > li.md-task > .md-task-body");

    expect(task, "a top-level task is indented away from the body text margin").toBeCloseTo(
      paragraph,
      0,
    );

    const bullet = await leftEdge(page, ".md-root > ul > li.md-item:not(.md-task)");
    expect(taskText, "a task's text and a bullet's text are indented differently").toBeCloseTo(
      bullet,
      0,
    );
    expect(taskText).toBeGreaterThan(paragraph);

    const nestedTask = await leftEdge(page, ".md-task .md-task-body ul > li.md-task");
    const nestedBullet = await leftEdge(page, ".md-item:not(.md-task) > ul > li.md-item");
    const taskStep = nestedTask - task;
    const bulletStep = nestedBullet - bullet;
    expect(taskStep, "a nested task does not step in by one gutter").toBeCloseTo(bulletStep, 0);
    expect(taskStep).toBeGreaterThan(0);

    const deeperTask = await leftEdge(page, ".md-task .md-task-body ul .md-task-body ul > li.md-task");
    expect(deeperTask - nestedTask).toBeCloseTo(taskStep, 0);

    const mixed = page.locator(".md-root > ul").last();
    const mixedTaskText = (await mixed.locator("li.md-task > .md-task-body").boundingBox())?.x ?? -1;
    const mixedBullet = (await mixed.locator("li.md-item:not(.md-task)").boundingBox())?.x ?? -2;
    expect(mixedTaskText, "one list, two indents").toBeCloseTo(mixedBullet, 0);

    const box = await page.locator(".md-task-box").first().boundingBox();
    expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(44);
  });

  test("the same alignment holds at 390 px, with nothing off the left edge", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = await createDocument(request, baseURL as string, LISTS);
    await signIn(page, ADMIN);
    await openDocument(page, id);
    await readPane(page);
    await expect(page.getByRole("checkbox").first()).toBeVisible();

    const paragraph = await leftEdge(page, ".md-root > p");
    const task = await leftEdge(page, ".md-root > ul > li.md-task");
    const taskText = await leftEdge(page, ".md-root > ul > li.md-task > .md-task-body");
    const bullet = await leftEdge(page, ".md-root > ul > li.md-item:not(.md-task)");
    expect(task).toBeCloseTo(paragraph, 0);
    expect(taskText).toBeCloseTo(bullet, 0);

    const box = await page.locator(".md-task-box").first().boundingBox();
    expect(box?.x ?? -1, "the checkbox hangs off the left edge of the screen").toBeGreaterThanOrEqual(0);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

test.describe("the document list's incomplete condition", () => {
  test("marks the row, says why, and leaves the list exactly as it was", async ({ page }) => {
    await signIn(page, ADMIN);
    await expect(docRows(page).first()).toBeVisible();
    const before = await docRows(page).count();
    expect(before, "the fixture workspace has documents to lose").toBeGreaterThan(0);

    const filters = page.getByRole("button", { name: /^Filters/ });
    if ((await filters.getAttribute("aria-expanded")) !== "true") await filters.click();
    await page.getByRole("button", { name: "Add condition" }).click();

    const note = page.locator(".search-clause-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Not applied.");
    await expect(note).toContainText("Type a value");

    await expect(docRows(page)).toHaveCount(before);
    await page.locator(".search-json summary").click();
    const json = await page.locator(".search-json pre").innerText();
    expect(json, "an unusable clause reached the query").not.toContain("fm.status");

    await expect(page.locator(".search-filter-count")).toHaveCount(0);
  });
});
