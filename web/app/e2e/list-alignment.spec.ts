/**
 * Where a list's text actually lands on screen, measured rather than described.
 *
 * Two owners' regressions, both of the same kind: a surface that *says* one thing and
 * *renders* another, where every existing assertion passes because nothing measured.
 *
 * 1. **`markdown` — task lists were indented twice.** A list's marker gutter
 *    (`--md-gutter`, 24 px) and a task's checkbox (a 44 px tap target) were two
 *    different widths, so a task's text sat 50 px from the body margin while a bullet
 *    in the same list sat at 24 px, and every nesting level stepped 50 px against a
 *    bullet's 24. The owner's words were "todos render very indented". Nothing in the
 *    suite noticed, because a checkbox that exists, is 44 px and toggles is a checkbox
 *    that passes every other test in this directory.
 *
 * 2. **`doc-list` — the incomplete-condition note.** `web/MOBILE-AUDIT.md` Q5 suspected
 *    the note was lying: "this condition is not being applied", over a list that had
 *    dropped to zero rows. `filter.test.ts` proves the builder drops the clause; this
 *    proves the rendered list does not move, which is the half a unit test cannot see
 *    and the half the audit actually observed.
 *
 * Both tests assert **relationships between measured edges**, not pixel constants: a
 * theme is free to change `--lm-space`, and these still hold.
 */

import { expect, test, type Page } from "@playwright/test";

import { ADMIN, createDocument, docRows, modeSwitch, openDocument, signIn } from "./helpers.js";

/**
 * A document with, in order: a paragraph at the body margin, a task list three levels
 * deep, a bullet list nested the same way, an ordered list, and a list that mixes a
 * task with a plain bullet — which is the case where the two indents sat side by side
 * and the drift was visible without measuring anything.
 */
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

/**
 * The read pane, whichever mode the workspace opens documents in.
 *
 * `document-surface` resolves a per-user default mode, so a suite that shares one
 * workspace cannot assume Read is selected — and a layout test that silently became a
 * test of that setting would fail for a reason it does not name.
 */
async function readPane(page: Page) {
  // A phone switches with the floating button, a wide screen with the header tab.
  await expect(modeSwitch(page)).toBeVisible();
  const back = page.getByRole("button", { name: "Switch to Read" });
  if (await back.isVisible()) await back.click();
  const tab = page.getByRole("tab", { name: "Read" });
  if ((await tab.isVisible()) && (await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  return page.getByRole("tabpanel", { name: "Read" });
}

/** The left edge of the first match, in viewport coordinates. */
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

    // Explicitly, not by relying on the default: `document-surface` has a per-user
    // "Open documents in" setting, so which mode a fresh document lands in is a
    // workspace preference. This test is about layout, and must not also be a test of
    // whose turn it is to set that.
    const read = await readPane(page);
    await expect(read.locator(".md-root")).toBeVisible();
    await expect(read.getByRole("checkbox").first()).toBeVisible();

    const paragraph = await leftEdge(page, ".md-root > p");
    const task = await leftEdge(page, ".md-root > ul > li.md-task");
    const taskText = await leftEdge(page, ".md-root > ul > li.md-task > .md-task-body");

    // The ask, stated as one number: a task row's left edge *is* the body text margin.
    // It used to be too, by accident — the negative margin was already there — while
    // everything a reader actually sees sat 50 px further in, which is why the second
    // assertion below is the one that matters.
    expect(task, "a top-level task is indented away from the body text margin").toBeCloseTo(
      paragraph,
      0,
    );

    // The bullet list that follows, at the same depth: its text and a task's text are
    // one gutter in, and it is the *same* gutter.
    const bullet = await leftEdge(page, ".md-root > ul > li.md-item:not(.md-task)");
    expect(taskText, "a task's text and a bullet's text are indented differently").toBeCloseTo(
      bullet,
      0,
    );
    expect(taskText).toBeGreaterThan(paragraph);

    // One indent step per level, and the same step for both kinds of list.
    const nestedTask = await leftEdge(page, ".md-task .md-task-body ul > li.md-task");
    const nestedBullet = await leftEdge(page, ".md-item:not(.md-task) > ul > li.md-item");
    const taskStep = nestedTask - task;
    const bulletStep = nestedBullet - bullet;
    expect(taskStep, "a nested task does not step in by one gutter").toBeCloseTo(bulletStep, 0);
    expect(taskStep).toBeGreaterThan(0);

    // Three levels: the step is uniform, not just present once.
    const deeperTask = await leftEdge(page, ".md-task .md-task-body ul .md-task-body ul > li.md-task");
    expect(deeperTask - nestedTask).toBeCloseTo(taskStep, 0);

    // A task and a bullet *in one list* line their text up with each other.
    const mixed = page.locator(".md-root > ul").last();
    const mixedTaskText = (await mixed.locator("li.md-task > .md-task-body").boundingBox())?.x ?? -1;
    const mixedBullet = (await mixed.locator("li.md-item:not(.md-task)").boundingBox())?.x ?? -2;
    expect(mixedTaskText, "one list, two indents").toBeCloseTo(mixedBullet, 0);

    // And the fix is not "make the checkbox smaller": the hit area is still SPEC §6.5's
    // 44 px square. It overflows the gutter instead of widening it, which is the whole
    // trick, so shrinking it would pass every assertion above and fail a fingertip.
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

    // The checkbox hangs 10 px into the page gutter on either side of its column. That
    // is fine until the pane's padding is smaller than the overhang, at which point it
    // would be painted off the screen — so measure it rather than assume.
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

    // The row is marked, and the mark names the reason rather than a state the boxes
    // are not in ("Incomplete" was shown over rows that were entirely filled in).
    const note = page.locator(".doclist-clause-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Not applied.");
    await expect(note).toContainText("Type a value");

    // Q5, measured: the list is untouched, and the query says so in its own words.
    await expect(docRows(page)).toHaveCount(before);
    await page.locator(".doclist-json summary").click();
    const json = await page.locator(".doclist-json pre").innerText();
    expect(json, "an unusable clause reached the query").not.toContain("fm.status");

    // The badge counts what the query carries. An unusable row is not a condition.
    await expect(page.locator(".doclist-filter-count")).toHaveCount(0);
  });
});
