import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  ADMIN,
  createDocument,
  currentDocumentId,
  docRows,
  openDocument,
  pluginRegistry,
  rawText,
  runCommand,
  showSidebar,
  signIn,
  waitSynced,
  trashRow,
} from "./helpers.js";

const EXPECTED_PLUGINS = 38;

const MIDNIGHT_BG = "#0d1117";

test.describe.configure({ mode: "serial" });

test("registering the first user boots the whole plugin distribution", async ({
  page,
  request,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/status of 401/.test(text)) return;
    errors.push(`console: ${text}`);
  });

  await signIn(page);

  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("link", { name: /skip to content/i })).toBeAttached();

  await page.goto("/#/?t.rows=200");
  const main = page.locator("#shell-main");
  for (const title of [
    "Welcome to ddd",
    "Writing in markdown",
    "Tasks and lists",
    "Properties",
    "Folders are notes",
    "Embedding notes",
    "Files and images",
    "Finding things",
    "History and changes",
    "Keyboard and commands",
    "Directives and machine sections",
  ]) {
    await expect(main.getByRole("button", { name: title, exact: true })).toBeVisible();
  }
  await expect(docRows(page).first()).toBeVisible();
  await main.getByRole("button", { name: "Folders are notes", exact: true }).click();
  await expect(
    page.getByRole("tree", { name: "Folders" }).locator('[role="treeitem"][aria-level="2"]').filter({ hasText: "Folders are notes" }),
  ).toBeVisible();

  await expect(page.getByRole("banner").getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByRole("combobox", { name: /command/i })).toBeVisible();
  await page.keyboard.press("Escape");

  const registry = await pluginRegistry(request, baseURL as string);
  expect(registry.problems).toHaveLength(0);
  expect(registry.plugins).toHaveLength(EXPECTED_PLUGINS);

  await expect(page.getByText(/plugin[s]? failed|failed to load/i)).toHaveCount(0);
  expect(errors, "no console errors during boot").toEqual([]);
});

test("a document created from the palette is edited in CodeMirror and the list follows live", async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page);

  await runCommand(page, /New document/);
  await expect.poll(() => currentDocumentId(page)).toBeTruthy();
  const id = currentDocumentId(page) as string;

  const tabs = page.getByRole("tablist", { name: /document mode/i });
  await expect(tabs.getByRole("tab", { name: "Read" })).toBeVisible();
  await tabs.getByRole("tab", { name: "Edit" }).click();

  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();

  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("---\ntitle: Palette-made note\n---\n\nbody text here\n");
  await waitSynced(page);

  await expect(page.getByRole("heading", { level: 1, name: "Palette-made note" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Palette-made note", exact: true })).toBeVisible();

  expect(await rawText(request, baseURL as string, id)).toContain("title: Palette-made note");
});

test("clicking a task toggles it and the state menu sets a plugin-contributed marker", async ({
  page,
  request,
  baseURL,
}) => {
  const id = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Task journey", "---", "", "- [ ] first", "- [ ] second", ""].join("\n"),
  );

  await signIn(page);
  await openDocument(page, id);

  const checkboxes = page.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.first()).not.toBeChecked();

  await checkboxes.first().click();
  await expect(checkboxes.first()).toBeChecked();
  await waitSynced(page);
  expect(await rawText(request, baseURL as string, id)).toContain("- [x] first");

  await checkboxes.nth(1).click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Task state" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /in progress/i })).toBeVisible();
  await menu.getByRole("menuitemradio", { name: /in progress/i }).click();

  await expect.poll(() => rawText(request, baseURL as string, id)).toContain("- [/] second");
  const text = await rawText(request, baseURL as string, id);
  expect(text).toContain("- [x] first");
});

test("dragging a document from the list onto a folder note files it there, and never writes the document", async ({
  page,
  request,
  baseURL,
}) => {
  const original = [
    "---",
    "# where this note lives — keep this comment",
    "title: Moves by splice",
    "",
    "tags: [alpha, beta]",
    "---",
    "",
    "# Moves by splice",
    "",
    "body stays put",
    "",
    "%%% reminders",
    "source-uid: keep-me@example.com",
    "%%%",
    "",
  ].join("\n");
  const base = baseURL as string;
  const id = await createDocument(request, base, original);
  const folder = (title: string, children: readonly string[]): string =>
    `---\ntitle: ${title}\n---\n\n# ${title}\n\n%%% folders\nchildren:\n${children.map((child) => `  - ${child}\n`).join("")}%%%\n`;
  const from = await createDocument(request, base, folder("journeys-from", [id]));
  const other = await createDocument(request, base, "---\ntitle: Already there\n---\n\nx\n");
  const to = await createDocument(request, base, folder("journeys-to", [other]));

  await signIn(page);
  await page.goto("/");
  await showSidebar(page);

  const tree = page.getByRole("tree", { name: /folders/i });
  await expect(tree).toBeVisible();
  const target = tree.locator(".folders-node").filter({ has: page.locator(".folders-name", { hasText: /^journeys-to$/ }) });
  await expect(target).toBeVisible();

  const row = page.getByRole("button", { name: "Moves by splice", exact: true });
  await expect(row).toBeVisible();
  await row.dragTo(target);
  await waitSynced(page);

  const children = async (folderId: string): Promise<string[]> =>
    [...(await rawText(request, base, folderId)).matchAll(/^ {2}- (\S+)$/gm)].map((match) => match[1] as string);
  await expect.poll(() => children(to), { timeout: 15_000 }).toEqual([other, id]);
  await expect.poll(() => children(from), { timeout: 15_000 }).toEqual([]);
  expect(await rawText(request, base, id)).toBe(original);
});

test("search finds body text with the network down, and the document still opens", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const needle = "peculiarsearchtoken";
  const id = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Offline searchable", "---", "", `a body containing ${needle} in it`, ""].join("\n"),
  );

  await signIn(page);
  await expect(page.getByRole("button", { name: "Offline searchable", exact: true })).toBeVisible();

  await context.setOffline(true);
  try {
    await page.goto(`/#/search?q=${needle}`);
    const results = page.getByRole("link", { name: /Offline searchable/i }).or(
      page.getByRole("button", { name: /Offline searchable/i }),
    );
    await expect(results.first()).toBeVisible({ timeout: 20_000 });

    await page.goto(`/#/doc/${id}`);
    await expect(page.getByText(needle)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Read" })).toBeVisible();

    await expect(page.getByRole("tab", { name: "Edit" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  await waitSynced(page);
});

test("a second browser context sees an edit live", async ({ page, browser, request, baseURL }) => {
  const id = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Collaborative", "---", "", "start", ""].join("\n"),
  );

  await signIn(page);
  await openDocument(page, id);
  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page.locator(".cm-content")).toBeVisible();

  const second: BrowserContext = await browser.newContext({ baseURL: baseURL as string });
  try {
    const other: Page = await second.newPage();
    await signIn(other);
    await openDocument(other, id);
    await other.getByRole("tab", { name: "Edit" }).click();
    await expect(other.locator(".cm-content")).toBeVisible();

    const marker = "typed-in-the-first-browser";
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(`\n${marker}\n`);

    await expect(other.locator(".cm-content")).toContainText(marker, { timeout: 20_000 });
  } finally {
    await second.close();
  }
});

test("a theme choice persists across a reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/settings/themes");

  const appearance = page.getByRole("radio", { name: /^dark$/i });
  await expect(appearance).toBeVisible();
  await appearance.check();

  const midnight = page.getByRole("radio", { name: /midnight/i });
  await expect(midnight).toBeVisible();
  await midnight.check();

  const background = (): Promise<string> =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--ddd-bg").trim(),
    );

  await expect.poll(background).toBe(MIDNIGHT_BG);

  await waitSynced(page);
  await page.reload();
  await expect.poll(background).toBe(MIDNIGHT_BG);
  await expect(page.getByRole("radio", { name: /midnight/i })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^dark$/i })).toBeChecked();
});

test("a document moves to Trash and comes back", async ({ page, request, baseURL }) => {
  const id = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Doomed then saved", "---", "", "text", ""].join("\n"),
  );

  await signIn(page);
  await page.goto("/");
  const row = docRows(page).filter({ hasText: "Doomed then saved" });
  await expect(row).toHaveCount(1);
  await trashRow(page, row);
  await expect(docRows(page).filter({ hasText: "Doomed then saved" })).toHaveCount(0);

  await page.goto("/#/trash");
  const trashed = page.locator(".doclist-item").filter({ hasText: "Doomed then saved" });
  await expect(trashed).toHaveCount(1);
  await trashed.getByRole("button", { name: /restore/i }).click();
  await expect(page.locator(".doclist-item").filter({ hasText: "Doomed then saved" })).toHaveCount(0);

  await page.goto("/");
  await expect(docRows(page).filter({ hasText: "Doomed then saved" })).toHaveCount(1);
  expect(await rawText(request, baseURL as string, id)).toContain("Doomed then saved");
});

test("an admin invite lets a second user register", async ({ page, browser, baseURL }) => {
  await signIn(page);
  await page.goto("/#/settings/admin.invites");

  const invites = page.getByRole("region", { name: "Invites", exact: true });
  await expect(invites).toBeVisible();
  await invites.getByRole("button", { name: "Create invite" }).click();

  const shown = invites.getByRole("status");
  await expect(shown).toContainText(/shown once/i);
  const link = ((await shown.locator("code").first().textContent()) ?? "").trim();
  const value = link.split("#/invite/")[1] ?? "";
  expect(value.length, `link looked wrong: ${link}`).toBeGreaterThan(15);

  await expect(invites.getByRole("row").filter({ hasText: "pending" })).toHaveCount(1);

  const second = await browser.newContext({ baseURL: baseURL as string });
  try {
    const other = await second.newPage();
    await signIn(
      other,
      { email: "invited@e2e.test", password: "e2e-invited-password-1" },
      { invite: value },
    );
    await expect(other.getByRole("banner")).toBeVisible();
    await other.getByRole("searchbox", { name: "Search documents" }).fill("Welcome to ddd");
    await expect(other.getByRole("button", { name: "Welcome to ddd", exact: true })).toBeVisible();
  } finally {
    await second.close();
  }
});
