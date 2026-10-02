/**
 * Phone-width regressions for the four **browse and find** surfaces: the document list
 * (`table`'s results table under `search`'s controls) and Trash (`doc-list`), the folder
 * tree (`folders`), searching the list, and the command palette plus the keybindings
 * settings section (`commands`).
 *
 * Each test asserts two things, and the pair is the point:
 *
 * 1. **The document never scrolls sideways** —
 *    `documentElement.scrollWidth <= clientWidth` — because every layout bug the mobile
 *    audit found on these pages ended there. It is checked *after* the interaction as
 *    well as before, since a palette, a dropdown and an expanded filter panel are all
 *    things that were only too wide once they were open.
 * 2. **The page's key interaction still works at 390 px.** A rule that merely stops the
 *    overflow by hiding the control would pass half of this file and fail the other
 *    half, which is why "the tap target is 44 px" is asserted as a measurement rather
 *    than inferred from a stylesheet.
 *
 * 390 × 844 is the acceptance viewport (`devices["Pixel 7"]`'s CSS size, and the
 * narrowest mainstream phone). `hasTouch`/`isMobile` are set so the `(hover: none)` and
 * `(pointer: coarse)` rules these fixes rely on are the ones actually evaluated —
 * without them Chromium reports a fine pointer and hover, and the landscape and
 * touch-only branches would never be exercised.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  ADMIN,
  createDocument,
  docRows,
  modeSwitch,
  openDocument,
  runCommand,
  showSidebar,
  signIn,
  trashRow,
} from "./helpers.js";

const PHONE = { width: 390, height: 844 };

/** Nothing on the page may push the document wider than the viewport. */
async function noHorizontalScroll(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const widest = [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter((entry) => entry.box.width > 0 && entry.box.right > root.clientWidth + 1)
      .map((entry) => `${entry.element.tagName.toLowerCase()}.${entry.element.className}`)
      .slice(0, 5);
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, widest };
  });
  expect(
    overflow.scrollWidth,
    `${where}: the page scrolls sideways; widest offenders: ${overflow.widest.join(", ")}`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

/** A control a fingertip can hit: SPEC §6.5's 44 px, in the dimension that was wrong. */
async function tappable(control: Locator, what: string): Promise<void> {
  const box = await control.boundingBox();
  expect(box?.height ?? 0, `${what} is under the 44 px tap target`).toBeGreaterThanOrEqual(44);
}

/**
 * The right edge of a control, in viewport coordinates.
 *
 * `boundingBox()` returns `{ x, y, width, height }` and **no** `right`/`bottom` — an
 * assertion reading `box.right` compares `undefined` and passes whatever it is handed,
 * which is how an off-screen button can satisfy an "is it on screen" test.
 */
async function edges(control: Locator): Promise<{ right: number; bottom: number }> {
  const box = await control.boundingBox();
  expect(box, "the control has no box at all").not.toBeNull();
  return { right: (box?.x ?? 0) + (box?.width ?? 0), bottom: (box?.y ?? 0) + (box?.height ?? 0) };
}

/**
 * Four notes, each listed in its parent's `%%% folders` section: a four-deep path in the
 * folder tree. Returns the deepest.
 */
async function seedPath(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
): Promise<string> {
  const leaf = await createDocument(request, baseURL, "---\ntitle: Phone path leaf\n---\n\nbody\n");
  let child = leaf;
  for (const title of ["Phone path third", "Phone path second", "Phone path root"]) {
    child = await createDocument(
      request,
      baseURL,
      `---\ntitle: ${title}\n---\n\nbody\n\n%%% folders\nchildren:\n  - ${child}\n%%%\n`,
    );
  }
  return leaf;
}

/** A row of documents to browse. */
async function seed(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
): Promise<void> {
  await createDocument(
    request,
    baseURL,
    "---\ntitle: Phone browse fixture with a deliberately long title that will not fit\npath: phone/deeply/nested/folder\n---\n\nthe body mentions phoneneedle once\n",
  );
  await createDocument(
    request,
    baseURL,
    "---\ntitle: Phone browse second\npath: phone\n---\n\nanother phoneneedle in a much longer paragraph of body text so the snippet has somewhere to run past the right-hand edge of a narrow screen\n",
  );
}

test.describe("browse and find, at phone width", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("the document list shows documents above the fold, and a row is one tap target", async ({
    page,
    request,
    baseURL,
  }) => {
    await seed(request, baseURL as string);
    await signIn(page, ADMIN);

    // The defect this replaces: the filter bar was always expanded and pushed every
    // document off the first screen, so opening the app showed no documents at all.
    const rows = docRows(page);
    await expect(rows.first()).toBeVisible();
    const firstRow = await rows.first().boundingBox();
    expect(firstRow?.y ?? Infinity, "the first document is below the fold").toBeLessThan(
      PHONE.height,
    );

    // The most-used control in the product, measured 22.5 px tall before this.
    const open = rows.first().locator(".search-open");
    await tappable(open, "the document title button");

    // A long title truncates rather than widening the row: one line, and no wider than
    // the column it sits in.
    const title = await open.boundingBox();
    expect(title?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
    expect(title?.height ?? 0).toBeLessThan(60);

    // Sort and direction stay on screen; the conditions are behind the toggle.
    await expect(page.getByRole("button", { name: /^Sort by/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Order:/ })).toBeVisible();
    const filters = page.getByRole("button", { name: /^filters/i });
    await expect(filters).toHaveAttribute("aria-expanded", "false");
    await noHorizontalScroll(page, "the document list");

    // Opening it is the interaction, and the panel it reveals must fit too.
    await filters.click();
    await expect(filters).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("checkbox", { name: /show machine documents/i })).toBeVisible();
    await page.getByRole("button", { name: "Add condition" }).click();
    await noHorizontalScroll(page, "the document list with a condition added");

    // And the row still opens the document — the whole reason the target was widened.
    await filters.click();
    await rows.first().locator(".search-open").click();
    await expect(modeSwitch(page)).toBeVisible();
  });

  test("Trash fits, and a deleted document can be restored", async ({ page, request, baseURL }) => {
    // Unique per run: the suite's database is dropped when its server starts, not
    // between runs, so a fixed title makes a second run against a warm server count two.
    const title = `Phone trash fixture ${Date.now()}`;
    await createDocument(
      request,
      baseURL as string,
      `---\ntitle: ${title}\npath: phone\n---\n\nbody\n`,
    );
    await signIn(page, ADMIN);

    const row = docRows(page).filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await trashRow(page, row);

    await page.goto("/#/trash");
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
    const trashed = page.locator(".doclist-item").filter({ hasText: title });
    await expect(trashed).toHaveCount(1);
    await noHorizontalScroll(page, "Trash");

    await trashed.getByRole("button", { name: "Restore" }).click();
    await expect(page.locator(".doclist-item").filter({ hasText: title })).toHaveCount(0);
  });

  test("the folder tree survives a four-deep path in the drawer", async ({
    page,
    request,
    baseURL,
  }) => {
    const deepest = await seedPath(request, baseURL as string);
    await signIn(page, ADMIN);
    // The tree reveals the open note, so the path is unfolded and on screen however many
    // notes the specs before this one left at the root (the tree is virtual).
    await openDocument(page, deepest);
    await showSidebar(page);

    const tree = page.getByRole("tree", { name: /folders/i });
    await expect(tree).toBeVisible();
    await noHorizontalScroll(page, "the sidebar drawer");

    // Nothing in the tree may stick out of the drawer: the indent used to grow 12 px a
    // level with 44 px buttons on the other side of the row.
    const drawerRight = await tree.evaluate((element) => element.getBoundingClientRect().right);
    const nodes = tree.locator(".folders-node");
    expect(await nodes.count()).toBeGreaterThan(1);
    for (const node of await nodes.all()) {
      const { right } = await edges(node);
      expect(right, "a folder row runs past the drawer").toBeLessThanOrEqual(drawerRight + 1);
    }

    // The twisty is the control a tree is for, and it measured 24 × 24.
    const twisty = tree.locator("button.folders-twisty").first();
    await tappable(twisty, "the folder twisty");
    const twistyBox = await twisty.boundingBox();
    expect(twistyBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    // It folds, which is the interaction. (Counted rows say nothing: the tree is virtual,
    // and draws a screenful either way.)
    const label = (await twisty.getAttribute("aria-label")) ?? "";
    const flipped = label.startsWith("Collapse ") ? label.replace(/^Collapse /, "Expand ") : label.replace(/^Expand /, "Collapse ");
    await twisty.click();
    await expect(tree.getByRole("button", { name: flipped, exact: true })).toBeVisible();
    await noHorizontalScroll(page, "the folder tree collapsed");
  });

  test("a note opens from the tree and fits", async ({ page, request, baseURL }) => {
    await seed(request, baseURL as string);
    await signIn(page, ADMIN);
    await showSidebar(page);

    // A folder is a note: its row opens it.
    const tree = page.getByRole("tree", { name: /folders/i });
    const row = tree.getByRole("treeitem").first();
    await tappable(row, "a note row in the tree");
    await row.click();
    await expect(modeSwitch(page)).toBeVisible();
    await noHorizontalScroll(page, "a note opened from the tree");
  });

  test("search docks at the bottom, widens when focused, and opens a result", async ({
    page,
    request,
    baseURL,
  }) => {
    await seed(request, baseURL as string);
    await signIn(page, ADMIN);

    // The old results page's address still opens the list, searching.
    await page.goto("/#/search?q=phoneneedle");
    await expect(page.getByRole("heading", { name: "Documents", level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/#\/\?q=phoneneedle$/);
    // The title alone: the matched line is a column the View panel adds (`t.cols=match`).
    const results = page.locator(".search-open");
    await expect(results.first()).toBeVisible({ timeout: 20_000 });
    await noHorizontalScroll(page, "search results");

    // Docked: the toolbar card sits on the bottom edge of the pane, right on top of the
    // shell's bottom toolbar, filters opening upwards.
    const card = page.locator(".search-controls");
    const box = await card.boundingBox();
    const dock = await page.getByRole("contentinfo").boundingBox();
    expect(Math.round(dock?.y ?? 0) + Math.round(dock?.height ?? 0)).toBe(PHONE.height);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(Math.round(dock?.y ?? 0));
    await page.getByRole("button", { name: /^Filters/ }).click();
    const panel = await page.locator(".search-filter-panel").boundingBox();
    const bar = await page.locator(".search-toolbar").boundingBox();
    expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + 1);
    // Everything outside the card is dimmed while they are open; a tap there folds them.
    const scrim = page.locator(".search-filter-scrim");
    await expect(scrim).toBeVisible();
    await scrim.click({ position: { x: 20, y: 120 } });
    await expect(scrim).toHaveCount(0);
    await expect(page.locator(".search-filter-panel")).toBeHidden();

    // Focused, the field takes the icons' room; blurred, it gives it back.
    const search = page.getByRole("searchbox", { name: "Search documents" });
    const narrow = (await search.boundingBox())?.width ?? 0;
    await search.focus();
    await expect.poll(async () => (await search.boundingBox())?.width ?? 0).toBeGreaterThan(narrow + 100);
    // Tucked away is out of reach too, not just out of sight.
    const icons = page.locator(".search-toolbar-icons");
    await expect(icons).toHaveAttribute("inert", "");
    await expect.poll(async () => (await icons.boundingBox())?.width ?? 0).toBeLessThan(2);
    await search.blur();
    await expect.poll(async () => Math.round((await search.boundingBox())?.width ?? 0)).toBe(Math.round(narrow));
    await expect(icons).not.toHaveAttribute("inert");
    await expect(page.getByRole("button", { name: /^Order:/ })).toBeVisible();

    await results.first().click();
    await expect(page).toHaveURL(/#\/doc\/[^?]+\?line=\d+$/);
    await expect(modeSwitch(page)).toBeVisible();
  });

  test("the palette is a sheet that fits the viewport and runs a command", async ({ page }) => {
    await signIn(page, ADMIN);

    await page.keyboard.press("ControlOrMeta+p");
    const input = page.getByRole("combobox", { name: /command/i });
    await expect(input).toBeVisible();

    const palette = page.locator(".cmd-palette");
    const sheet = await palette.boundingBox();
    // A sheet, not a dialog: full width, and no taller than what is on screen. The
    // height comes from `visualViewport` (see `Palette.tsx`), which in a test with no
    // keyboard is the window — the assertion is that it is measured at all.
    expect(sheet?.width ?? 0).toBeGreaterThan(PHONE.width - 4);
    expect(sheet?.height ?? 0).toBeLessThanOrEqual(PHONE.height + 1);
    expect(sheet?.y ?? -1).toBeGreaterThanOrEqual(0);

    // The mechanism, not just the result: the sheet's height comes from
    // `visualViewport`, which is the only thing that shrinks when Android opens the soft
    // keyboard (the layout viewport does not, which is the whole bug). A headless run
    // has no keyboard, so the assertion is that the wiring is live — a `height: 100%`
    // sheet would leave these unset and be indistinguishable on screen until a real
    // phone put a keyboard under it.
    const wiring = await page.locator(".cmd-overlay").evaluate((element) => ({
      height: element.style.getPropertyValue("--cmd-sheet-height"),
      top: element.style.getPropertyValue("--cmd-sheet-top"),
      viewport: `${window.visualViewport?.height ?? -1}px`,
    }));
    expect(wiring.height).toBe(wiring.viewport);
    expect(wiring.top).toMatch(/^\d+(\.\d+)?px$/);

    // The list scrolls inside the sheet rather than the sheet growing past the screen.
    const list = page.locator(".cmd-list");
    const scrolls = await list.evaluate(
      (element) => element.scrollHeight > element.clientHeight && element.clientHeight > 0,
    );
    expect(scrolls, "the palette list does not scroll inside the sheet").toBe(true);

    // The last option is reachable — the bug was that it sat under the keyboard or the
    // gesture bar, in a list that never scrolled.
    const options = page.locator(".cmd-list [role=option]");
    const last = options.last();
    await last.scrollIntoViewIfNeeded();
    expect((await edges(last)).bottom).toBeLessThanOrEqual(PHONE.height);
    await noHorizontalScroll(page, "the command palette");

    await page.keyboard.press("Escape");
    await expect(input).toBeHidden();

    // And it still runs things.
    await runCommand(page, /trash/i);
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
  });

  test("the keybindings section stacks into cards with every action reachable", async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    await page.goto("/#/settings/commands.keybindings");

    const rows = page.locator(".cmd-table tbody tr");
    await expect(rows.first()).toBeVisible();
    await noHorizontalScroll(page, "the keybindings section");

    // Twenty "Change" buttons were 22–28 px past the right edge, in a table with no
    // scroller of its own. Every one of them is now inside the viewport.
    const buttons = page.getByRole("button", { name: "Change" });
    expect(await buttons.count()).toBeGreaterThan(5);
    for (const button of await buttons.all()) {
      const { right } = await edges(button);
      expect(right, "a Change button is off-screen").toBeLessThanOrEqual(PHONE.width);
      await tappable(button, "a Change button");
    }

    // The filter is the section's own interaction, and it narrows the list.
    const before = await rows.count();
    await page.getByLabel("Filter commands").fill("trash");
    await expect(rows).not.toHaveCount(before);
    await noHorizontalScroll(page, "the keybindings section, filtered");
  });
});

/**
 * The two viewports that are not the acceptance one but are the same phone: the 360 px
 * Android floor, and that phone rotated.
 *
 * Landscape is here because the width-only breakpoint every plugin used missed it: at
 * 844 px a phone is "desktop" by width, has no hover, and has 390 px of height for a
 * dialog. The rules these assert are `(hover: none)` and `(max-height: 480px) and
 * (pointer: coarse)` — neither of which fires without `hasTouch`/`isMobile`.
 */
test.describe("the same phone, rotated and at the Android floor", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the document list still fits at 360 px with its row actions", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await seed(request, baseURL as string);
    await signIn(page, ADMIN);

    const row = docRows(page).first();
    await expect(row).toBeVisible();
    await noHorizontalScroll(page, "the document list at 360 px");

    // Title and the row's ⋯ share the row; the title gives way, the ⋯ stays on screen.
    const actions = row.getByRole("button", { name: /^Actions for/ });
    await expect(actions).toBeVisible();
    expect((await edges(actions)).right).toBeLessThanOrEqual(360);
    await tappable(row.locator(".search-open"), "the document title button at 360 px");
  });

  test("landscape gets the compact palette and reachable folder actions", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await seed(request, baseURL as string);
    await signIn(page, ADMIN);

    // `(hover: none)`: above the 640 px width breakpoint, with no pointer that can
    // hover, the row actions used to be `display: none` and unreachable by any means.
    // A phone has no ⋯ on a row: a long press (a context menu) opens its menu, as a sheet.
    await showSidebar(page);
    const tree = page.getByRole("tree", { name: /folders/i });
    await tree.getByRole("treeitem").first().click({ button: "right" });
    const action = page.getByRole("dialog").getByRole("menuitem", { name: "Rename" });
    await expect(action).toBeVisible();
    await tappable(action, "a folder row action in landscape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // And the palette is a sheet measured against 390 px of height, not a 70vh dialog
    // in a viewport that has no 70vh to give.
    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.getByRole("combobox", { name: /command/i })).toBeVisible();
    const sheet = await page.locator(".cmd-palette").boundingBox();
    expect(sheet?.height ?? 0).toBeLessThanOrEqual(391);
    expect(sheet?.width ?? 0).toBeGreaterThan(840);
    await noHorizontalScroll(page, "the palette in landscape");
  });
});
