/**
 * The UX sweep's regression net.
 *
 * Every test here pins something that was **wrong in a shipped build** and is cheap to
 * break again, because each one is a property nothing else in the suite asserts:
 *
 * - The journeys drive a desktop viewport, so nothing noticed that the navbar ran past
 *   a phone's screen and took the page's horizontal scroll with it.
 * - Nothing read a fold placeholder, a Trash attribution line, or the palette's
 *   *ordering*, so all three could say something wrong while every assertion passed.
 *
 * The mobile block uses 390 px — the narrowest mainstream phone, and the width SPEC
 * §6.5's breakpoint exists for. `documentElement.scrollWidth === clientWidth` is the
 * whole assertion for "nothing overflows": a page that scrolls sideways on a phone is
 * the symptom every one of those layout bugs produced.
 */

import { expect, test, type WebSocketRoute } from "@playwright/test";

import {
  ADMIN,
  createDocument,
  docRows,
  openDocument,
  runCommand,
  showSidebar,
  signIn,
  waitSynced,
  trashRow,
} from "./helpers.js";

/** Nothing on the page may push the document wider than the viewport. */
async function noHorizontalScroll(page: import("@playwright/test").Page): Promise<void> {
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
    `the page scrolls sideways; widest offenders: ${overflow.widest.join(", ")}`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

test.describe("phone width (390px)", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test("the navbar fits, and its entries are reachable", async ({ page }) => {
    await signIn(page, ADMIN);

    // What is left in the bar has to be a real tap target at phone width, not a label
    // squeezed to nothing by the end group.
    for (const name of ["Settings", "Admin"]) {
      const control = page.getByRole("button", { name });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.width ?? 0, `${name} is narrower than a tap target`).toBeGreaterThanOrEqual(40);
    }

    await noHorizontalScroll(page);
  });

  test("the document list, a document and settings all fit", async ({ page, request, baseURL }) => {
    const id = await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Phone width fixture\npath: sweep\n---\n\nbody\n",
    );

    await signIn(page, ADMIN);
    await noHorizontalScroll(page);

    await openDocument(page, id);
    await noHorizontalScroll(page);

    // The settings section list is a row of long names ("Administration — Snapshots").
    // As a grid item with the default `min-width: auto` it grew to their combined
    // max-content width — 1 700 px — and its own `overflow-x` never fired.
    await page.goto("/#/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await noHorizontalScroll(page);
    const nav = page.getByRole("navigation", { name: /settings sections/i });
    expect((await nav.boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
  });

  test("the sidebar drawer opens over the content and Escape closes it", async ({ page }) => {
    await signIn(page, ADMIN);
    await showSidebar(page);
    const sidebar = page.getByRole("complementary", { name: /sidebar/i });
    await expect(sidebar).toBeVisible();
    await noHorizontalScroll(page);

    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();
    // Focus goes back to the control that opened it, not to the top of the document.
    await expect(page.locator(".shell-sidebar-toggle")).toBeFocused();
  });
});

test.describe("copy and labels that were wrong", () => {
  test("a fold placeholder names the region it hides", async ({ page, request, baseURL }) => {
    // A `%%%` section's owner is on the fence line the fold hides, so the chip is the
    // one place left to say it. This test used to assert a *second* placeholder reading
    // "⋯ frontmatter": the block was folded on open behind a per-user preference, and
    // the label was the fix for it having said "machine data". The owner removed the
    // behaviour instead (2026-09-25) — frontmatter is human-owned (SPEC §3.3) and edit
    // mode is where it gets edited — so what is left to pin here is that exactly one
    // region folds and it names its plugin. `frontmatter.spec.ts` owns the rest.
    const id = await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Fold labels\npath: sweep\n---\n\nbody\n\n%%% sweep-demo\nkey: value\nother: 2\n%%%\n",
    );

    await signIn(page, ADMIN);
    await openDocument(page, id);
    await page.getByRole("tab", { name: "Edit" }).click();

    const placeholders = page.locator(".cm-foldPlaceholder");
    await expect(placeholders).toHaveCount(1);
    await expect(placeholders.nth(0)).toHaveText("⋯ sweep-demo data");

    // Still a fold, not just a label: clicking it puts the text back.
    await placeholders.nth(0).click();
    await expect(placeholders).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("key: value");
  });

  test("Trash attributes a deletion in words, not a raw user id", async ({ page, request, baseURL }) => {
    await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Trash attribution fixture\npath: sweep\n---\n\nbody\n",
    );

    await signIn(page, ADMIN);
    const row = docRows(page).filter({ hasText: "Trash attribution fixture" });
    await expect(row).toHaveCount(1);
    await trashRow(page, row);

    await page.goto("/#/trash");
    const trashed = page.locator(".doclist-item").filter({ hasText: "Trash attribution fixture" });
    await expect(trashed).toHaveCount(1);
    await expect(trashed).toContainText("by you");
    // The id is still recoverable on hover; it is not what the line reads as.
    await expect(trashed).not.toContainText(/by 0[0-9A-HJKMNP-TV-Z]{25}/);
  });
});

test.describe("the folder tree", () => {
  /**
   * The tree is a roving-tabindex widget: the container is the only tab stop and arrows
   * move the active row. Correct for navigating it, and it left the row's two action
   * buttons unreachable by any key — `tabindex="-1"` like everything else in a row, and
   * `display: none` until the row is active. Rename at least had F2. "New document in
   * this folder" had no keyboard path at all, on a button the tree draws for you.
   *
   * So the assertion is a real `Tab` from the tree rather than a CSS check: a rule that
   * merely *showed* the buttons without putting them in the tab order would still leave
   * them unreachable, and would still pass a visibility test.
   */
  test("puts the active row's actions in the tab order", async ({ page, request, baseURL }) => {
    await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Folder keyboard fixture\npath: sweep-folder\n---\n\nbody\n",
    );

    await signIn(page, ADMIN);
    await showSidebar(page);

    // Focusing the tree activates its first row (that is the widget's own onFocus), so
    // the actions Tab reaches are the ones the user can see highlighted.
    const tree = page.getByRole("tree", { name: /folders/i });
    await tree.focus();
    const active = tree.locator(".folders-node-active");
    await expect(active).toHaveCount(1);
    const folder = await active.locator(".folders-name").innerText();

    // Folder operations now live behind one modest ellipsis menu. The old + and
    // pencil controls were deliberately removed, but the active row's menu must
    // remain keyboard reachable.
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: new RegExp(`actions for .*${folder}`, "i") }).first(),
    ).toBeFocused();

    // And a row that is not active stays out of the way — one tab stop per tree, plus
    // the row the user is standing on, is the whole contract.
    const inactiveActions = tree.locator(".folders-node:not(.folders-node-active) .folders-actions button");
    for (const button of await inactiveActions.all()) {
      await expect(button).toHaveAttribute("tabindex", "-1");
    }
  });
});

test.describe("the task state menu", () => {
  /**
   * A menu that takes focus has to give it back. Both of these were "the menu closed,
   * and focus was on `<body>`" — the keyboard user ends up at the top of the document,
   * several dozen tab stops from the task they were working on, with nothing on screen
   * to say what happened.
   *
   * The right-click path is the one that matters: a context menu opened by pointer does
   * not focus the control it targets, so the element to return to cannot be read from
   * `document.activeElement` and has to come from the menu's own position in the DOM.
   */
  test("hands focus back to the checkbox on Escape and on choosing a state", async ({
    page,
    request,
    baseURL,
  }) => {
    const id = await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Task focus fixture\npath: sweep\n---\n\n- [ ] first\n- [ ] second\n",
    );

    await signIn(page, ADMIN);
    await openDocument(page, id);

    const box = page.locator(".md-task-box").first();
    const menu = page.getByRole("menu", { name: "Task state" });

    await box.click({ button: "right" });
    await expect(menu).toBeVisible();
    // Focus really is inside the menu first — otherwise the assertion below would pass
    // for a menu that never took focus at all.
    await expect(menu.getByRole("menuitem").first()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(box).toBeFocused();

    // Choosing an item rewrites the marker, so the trigger re-renders underneath the
    // focus call; it is still the control the user should be on.
    await box.click({ button: "right" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Done" }).click();
    await expect(box).toHaveAttribute("aria-checked", "true");
    await expect(box).toBeFocused();
  });

  test("closing by clicking elsewhere leaves focus where the user put it", async ({
    page,
    request,
    baseURL,
  }) => {
    // The other half of the same rule: the menu must not *pull* focus back when it was
    // dismissed by the user going somewhere else. A menu that does is worse than one
    // that drops focus, because it fights the pointer.
    const id = await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Task blur fixture\npath: sweep\n---\n\n- [ ] only\n",
    );

    await signIn(page, ADMIN);
    await openDocument(page, id);

    const box = page.locator(".md-task-box").first();
    await box.click({ button: "right" });
    await expect(page.getByRole("menu", { name: "Task state" })).toBeVisible();

    // The already-selected mode tab: focusable, and it leaves the read view mounted, so
    // the checkbox is still there to assert *isn't* focused. (Clicking "Edit" would
    // unmount the whole article and prove nothing.)
    const elsewhere = page.getByRole("tab", { name: "Read" });
    await elsewhere.click();
    await expect(page.getByRole("menu", { name: "Task state" })).toHaveCount(0);
    await expect(box).toBeVisible();
    await expect(box).not.toBeFocused();
    await expect(elsewhere).toBeFocused();
  });
});

test.describe("the command palette", () => {
  test("offers no mode command when no document is open", async ({ page, request, baseURL }) => {
    const id = await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Palette guard fixture\npath: sweep\n---\n\nbody\n",
    );

    await signIn(page, ADMIN);
    await page.goto("/#/trash");
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("combobox", { name: /command/i });
    await expect(palette).toBeVisible();
    // These ran `setMode` on nothing and looked like a broken app.
    await expect(page.getByRole("option", { name: /show document as/i })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // On a document they are exactly what the palette is for.
    await openDocument(page, id);
    await runCommand(page, /show document as: edit/i);
    await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
  });

  test("separates a row's category from its title in the accessible name", async ({ page }) => {
    // The gap was `margin-right` on the category, which is invisible to the
    // accessibility tree: every row announced as one run-together word
    // ("Admin ›Browse snapshots"). The same markup builds the keybindings table, so
    // both views were saying it.
    await signIn(page, ADMIN);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: /command/i })).toBeVisible();

    const categorised = page.locator(".cmd-list [role=option]", { has: page.locator(".cmd-category") });
    expect(await categorised.count()).toBeGreaterThan(0);
    for (const row of await categorised.all()) {
      // The *accessible name*, not `innerText`: the separator is generated content, which
      // `innerText` does not return at all and the name computation does. That difference
      // is the entire bug — the gap was styling the sighted reader could see and the name
      // computation could not.
      await expect(row).toHaveAccessibleName(/\S\s›\s\S/);
    }
  });

  test("groups an unfiltered list by category", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: /command/i })).toBeVisible();

    // Every score is 0 for an empty query, so the tie-break *is* the ordering. Sorting
    // on title alone interleaved the categories the rows are labelled with.
    const categories = await page.locator(".cmd-list [role=option] .cmd-category").allInnerTexts();
    expect(categories.length).toBeGreaterThan(5);
    const firstSeen = new Map<string, number>();
    categories.forEach((category, index) => {
      if (!firstSeen.has(category)) firstSeen.set(category, index);
    });
    for (const [category, start] of firstSeen) {
      const last = categories.lastIndexOf(category);
      const run = categories.slice(start, last + 1);
      expect(run.every((entry) => entry === category), `"${category}" is not contiguous`).toBe(true);
    }
  });
});

test.describe("the command palette closes", () => {
  test("on Escape even after a click inside it moved focus", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByRole("combobox", { name: /command/i });
    await expect(input).toBeVisible();

    // The list's own top padding: inside the palette, not an option and not focusable,
    // so a click there used to drop focus to <body>, where Escape went unheard.
    const panel = page.getByRole("dialog", { name: "Command palette" });
    await panel.getByRole("listbox").click({ position: { x: 8, y: 1 } });
    await expect(panel).toBeVisible();
    await expect(input).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });
});

test.describe("the sync status", () => {
  test("a dropped connection shows a steady red ✕ that reconnects", async ({ page }) => {
    // `context.setOffline` leaves an open WebSocket connected, so cut the socket itself:
    // drop the live one, then refuse every reconnect until the test lets them through.
    let refuse = false;
    let live: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/api\/sync/, (ws) => {
      if (refuse) {
        void ws.close();
        return;
      }
      live = ws;
      ws.connectToServer();
    });
    await signIn(page, ADMIN);
    await waitSynced(page);

    refuse = true;
    await live?.close();
    const reconnect = page.getByRole("button", { name: "Offline. Reconnect" });
    await expect(reconnect).toBeVisible({ timeout: 30_000 });
    await expect(reconnect).not.toHaveText(/retry/i);

    // Steady through the kernel's reconnect attempts, which each pass through
    // "connecting": the ✕ used to blink with every one of them.
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(500);
      await expect(reconnect).toHaveCount(1);
    }

    refuse = false;
    await reconnect.click();
    await waitSynced(page);
    await expect(reconnect).toHaveCount(0);
  });
});

test.describe("the top bar", () => {
  test("its items can be reordered, moved between seats and hidden from Settings", async ({ page }) => {
    await signIn(page, ADMIN);
    const bar = page.getByRole("banner");
    const endSeat = bar.locator('ul[data-side="end"]');
    const startSeat = bar.locator('ul[data-side="start"]');

    await page.goto("/#/settings/header.bar");
    await expect(page.getByRole("heading", { name: /^End/ })).toBeVisible();

    // Settings moves to the start seat, and the bar follows without a reload.
    await page.getByRole("button", { name: "Move Settings to the start seat" }).click();
    await expect(startSeat.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(endSeat.getByRole("button", { name: "Settings" })).toHaveCount(0);

    // It is a per-user setting, so it survives a reload.
    await page.reload();
    await expect(startSeat.getByRole("button", { name: "Settings" })).toBeVisible();

    // Hidden: gone from the bar, still listed in Settings so it can come back.
    await page.getByRole("button", { name: "Hide Admin" }).click();
    await expect(bar.getByRole("button", { name: "Admin" })).toHaveCount(0);
    await page.getByRole("button", { name: "Show Admin" }).click();
    await expect(endSeat.getByRole("button", { name: "Admin" })).toBeVisible();

    // And reset puts every item back where its plugin asked to be.
    await page.getByRole("button", { name: "Reset to default order" }).click();
    await expect(endSeat.getByRole("button", { name: "Settings" })).toBeVisible();
  });
});

test.describe("the settings list", () => {
  test("puts base plugins' sections first and extensions below a divider", async ({ page }) => {
    // No shipped extension contributes a settings section, so report `themes` as one.
    // `base` only decides safe mode and this grouping; the plugin still loads.
    await page.route("**/api/plugins", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        plugins: { base: boolean; manifest: { id: string } }[];
      };
      for (const plugin of body.plugins) if (plugin.manifest.id === "themes") plugin.base = false;
      await route.fulfill({ response, json: body });
    });
    await signIn(page, ADMIN);
    await page.goto("/#/settings");

    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const extensions = nav.getByRole("list", { name: "Extensions" });
    await expect(extensions.getByRole("link", { name: "Appearance" })).toBeVisible();
    await expect(nav.getByRole("separator")).toBeVisible();
    await expect(nav.getByRole("list", { name: "Built-in" }).getByRole("link", { name: "Account" })).toBeVisible();
    await expect(nav.getByRole("list", { name: "Built-in" }).getByRole("link", { name: "Appearance" })).toHaveCount(0);
  });
});
