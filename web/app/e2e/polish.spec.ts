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
    await expect(page.locator(".shell-sidebar-toggle")).toBeFocused();
  });
});

test.describe("copy and labels that were wrong", () => {
  test("a fold placeholder names the region it hides, and folds again once opened", async ({ page, request, baseURL }) => {
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
    await expect(placeholders.nth(0)).toHaveText("");
    await expect(placeholders.nth(0)).toHaveAttribute("aria-label", "Expand sweep-demo data");

    await placeholders.nth(0).click();
    await expect(placeholders).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("key: value");

    await page.getByRole("button", { name: "Collapse sweep-demo data" }).click();
    await expect(placeholders).toHaveCount(1);
    await expect(page.locator(".cm-content")).not.toContainText("key: value");
    await expect(page.getByRole("button", { name: "Collapse sweep-demo data" })).toHaveCount(0);
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
    await expect(trashed).not.toContainText(/by 0[0-9A-HJKMNP-TV-Z]{25}/);
  });
});

test.describe("the folder tree", () => {
  test("puts the active row's actions in the tab order", async ({ page, request, baseURL }) => {
    const child = await createDocument(request, baseURL as string, "---\ntitle: Folder keyboard child\n---\n\nbody\n");
    await createDocument(
      request,
      baseURL as string,
      `---\ntitle: Folder keyboard fixture\n---\n\nbody\n\n%%% folders\nchildren:\n  - ${child}\n%%%\n`,
    );

    await signIn(page, ADMIN);
    await showSidebar(page);

    const tree = page.getByRole("tree", { name: /folders/i });
    await tree.focus();
    const active = tree.locator(".folders-node-active");
    await expect(active).toHaveCount(1);

    await page.keyboard.press("Tab");
    await expect(active.getByRole("button", { name: "Note actions" })).toBeFocused();

    const inactiveActions = tree.locator(".folders-node:not(.folders-node-active) .folders-actions button");
    for (const button of await inactiveActions.all()) {
      await expect(button).toHaveAttribute("tabindex", "-1");
    }
  });
});

test.describe("the task state menu", () => {
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
    const menu = page.getByRole("dialog", { name: "Task state" });

    await box.click({ button: "right" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio").first()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(box).toBeFocused();

    await box.click({ button: "right" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitemradio", { name: "Done" }).click();
    await expect(box).toHaveAttribute("aria-checked", "true");
    await expect(box).toBeFocused();
  });

  test("a click elsewhere closes it without landing underneath, and focus comes back", async ({
    page,
    request,
    baseURL,
  }) => {
    const id = await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Task blur fixture\npath: sweep\n---\n\n- [ ] only\n",
    );

    await signIn(page, ADMIN);
    await openDocument(page, id);

    const box = page.locator(".md-task-box").first();
    await box.click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Task state" });
    await expect(menu).toBeVisible();

    const edit = page.getByRole("tab", { name: "Edit" });
    const at = await edit.boundingBox();
    if (!at) throw new Error("the Edit tab has no box");
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Read" })).toHaveAttribute("aria-selected", "true");
    await expect(box).toBeFocused();
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

    await page.keyboard.press("ControlOrMeta+p");
    const palette = page.getByRole("combobox", { name: /command/i });
    await expect(palette).toBeVisible();
    await expect(page.getByRole("option", { name: /show document as/i })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await openDocument(page, id);
    await runCommand(page, /show document as: edit/i);
    await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
  });

  test("separates a row's category from its title in the accessible name", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.getByRole("combobox", { name: /command/i })).toBeVisible();

    const categorised = page.locator(".cmd-list [role=option]", { has: page.locator(".cmd-category") });
    expect(await categorised.count()).toBeGreaterThan(0);
    for (const row of await categorised.all()) {
      await expect(row).toHaveAccessibleName(/\S\s›\s\S/);
    }
  });

  test("groups an unfiltered list by category", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.getByRole("combobox", { name: /command/i })).toBeVisible();

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
    await page.keyboard.press("ControlOrMeta+p");
    const input = page.getByRole("combobox", { name: /command/i });
    await expect(input).toBeVisible();

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

test.describe("the toolbar", () => {
  test("its items can be reordered, moved between seats and bars, and hidden from Settings", async ({ page }) => {
    await signIn(page, ADMIN);
    const header = page.getByRole("banner");
    const endSeat = header.locator('ul[data-seat="top-end"]');
    const startSeat = header.locator('ul[data-seat="top-start"]');
    const footer = page.getByRole("contentinfo");

    await page.goto("/#/settings/toolbar.layout");
    await expect(page.getByRole("tab", { name: /^Desktop/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Header — right" })).toBeVisible();

    await page.getByRole("combobox", { name: "Move Settings to" }).selectOption({ label: "Header — left" });
    await expect(startSeat.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(endSeat.getByRole("button", { name: "Settings" })).toHaveCount(0);

    await page.reload();
    await expect(startSeat.getByRole("button", { name: "Settings" })).toBeVisible();

    await page.getByRole("combobox", { name: "Move Settings to" }).selectOption({ label: "Footer — right" });
    await expect(footer.locator('ul[data-seat="bottom-end"]').getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Settings" })).toHaveCount(0);

    await page.getByRole("button", { name: "Hide Admin" }).click();
    await expect(header.getByRole("button", { name: "Admin" })).toHaveCount(0);
    await page.getByRole("button", { name: "Show Admin" }).click();
    await expect(endSeat.getByRole("button", { name: "Admin" })).toBeVisible();

    await page.getByRole("tab", { name: /^Phone/ }).click();
    await expect(page.getByRole("heading", { name: "Bottom toolbar" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Move Settings to" })).toHaveValue("bottom");

    await page.getByRole("tab", { name: /^Desktop/ }).click();
    await page.getByRole("button", { name: "Reset desktop layout" }).click();
    await expect(endSeat.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  test("a phone gets a bottom toolbar and opens Settings on its own tab", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, ADMIN);
    const dock = page.getByRole("contentinfo").getByRole("navigation", { name: "Toolbar" });
    await expect(dock.getByRole("button", { name: "Settings" })).toBeVisible();

    await page.goto("/#/settings/toolbar.layout");
    await expect(page.getByRole("tab", { name: /^Phone/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("combobox", { name: "Move Settings to" }).selectOption({ label: "Top bar — right" });
    await expect(page.getByRole("banner").getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(dock.getByRole("button", { name: "Settings" })).toHaveCount(0);
    await page.getByRole("button", { name: "Reset phone layout" }).click();
    await expect(dock.getByRole("button", { name: "Settings" })).toBeVisible();
  });
});

test.describe("the settings list", () => {
  test("puts base plugins' sections first and extensions below a divider", async ({ page }) => {
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
