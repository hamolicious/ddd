/**
 * The folder tree as a file manager — verified against what the **server** ends up
 * holding, not against what the panel says it did.
 *
 * A folder is a note: its children are listed in its own `%%% folders` section, one id
 * per line. So every verb here is a write with a shape as well as a result: a move is one
 * line added to the new parent's list and one line removed from the old one, and the note
 * being moved is **not written at all**. Each test reads the raw text over REST and checks
 * both halves — the lists say the right thing, and every other byte (a comment, the key
 * order, another plugin's section) is where it was.
 *
 * Named `zz-` so it runs last. The suite shares one workspace and one account
 * (`playwright.app.config.ts`), and this file adds a few dozen notes to it; several
 * earlier specs assert on workspace-wide counts, so arriving before them would make this
 * file's setup their flake.
 *
 * Each test starts from an empty workspace (everything else to Trash): the tree is
 * virtual and draws only the rows on screen, so a test's notes must not depend on how
 * many the specs before it left at the root.
 */

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import {
  ADMIN,
  createDocument,
  openDocument,
  rawText,
  runCommand,
  showSidebar,
  signIn,
  trashAllDocuments,
  waitSynced,
} from "./helpers.js";

/**
 * A fixture note, written by hand so the byte-for-byte assertions can be exact: a
 * comment, a blank line inside the block and another plugin's section are what a
 * careless rewrite would lose. `children` makes it a folder.
 */
function fixture(title: string, children: readonly string[] = []): string {
  const lines = [
    "---",
    "# a comment only a splice survives",
    `title: ${title}`,
    "",
    "tags: [alpha, beta]",
    "---",
    "",
    `# ${title}`,
    "",
    "body stays put",
    "",
    "%%% sweep-demo",
    "source-uid: keep-me@example.com",
    "%%%",
  ];
  if (children.length > 0) lines.push("%%% folders", "children:", ...children.map((id) => `  - ${id}`), "%%%");
  return `${lines.join("\n")}\n`;
}

/** The ids a note's `%%% folders` section lists, in order. */
function childrenIn(text: string): string[] {
  const section = /%%% folders\n([\s\S]*?)%%%/.exec(text)?.[1] ?? "";
  return [...section.matchAll(/^ {2}- (\S+)$/gm)].map((match) => match[1] as string);
}

/** A unique title per test: one workspace, and titles are what the tree shows. */
function unique(tag: string): string {
  return `${tag}-${Math.random().toString(36).slice(2, 8)}`;
}

function tree(page: Page): Locator {
  return page.getByRole("tree", { name: "Folders" });
}

const exact = (title: string): RegExp => new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/**
 * The row for a note, by its exact title. `has:` is given a **page-rooted** locator:
 * Playwright re-roots it at each candidate row.
 */
function row(page: Page, title: string): Locator {
  return tree(page)
    .locator('[role="treeitem"]')
    .filter({ has: page.locator(".folders-name", { hasText: exact(title) }) })
    .first();
}

/** Open a row's ⋯ menu (hover-gated, so the pointer goes into the row first). */
async function actions(page: Page, title: string): Promise<Locator> {
  await row(page, title).hover();
  await row(page, title).getByRole("button", { name: "Note actions" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * Drag one row onto another with real pointer events: the tree's own drags are pointer
 * driven (a lifted copy under the pointer), so this is a press, two moves and a release.
 * `position` picks the part of the row: its top or bottom edge means "next to it".
 */
async function drag(page: Page, source: Locator, target: Locator, position?: { x: number; y: number }): Promise<void> {
  await source.hover();
  await page.mouse.down();
  await target.hover(position ? { position } : {});
  await target.hover(position ? { position } : {});
  await expect(page.locator(".folders-lifted")).toBeVisible({ timeout: 5_000 });
  await page.mouse.up();
}

/** Open the sidebar and wait for the tree to have finished its first query. */
async function openTree(page: Page): Promise<Locator> {
  await page.goto("/");
  await showSidebar(page);
  const panel = tree(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** Fail the test if anything opens a native dialog: rename is inline, never a prompt. */
function refuseNativeDialogs(page: Page): void {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
}

/** Poll a note's list until it says `expected`, then return the whole text. */
async function listed(
  request: APIRequestContext,
  baseURL: string,
  id: string,
  expected: readonly string[],
): Promise<string> {
  await expect.poll(async () => childrenIn(await rawText(request, baseURL, id)), { timeout: 20_000 }).toEqual(expected);
  return await rawText(request, baseURL, id);
}

test.beforeEach(async ({ request, baseURL }) => {
  await trashAllDocuments(request, baseURL as string);
});

// ---------------------------------------------------------------------------
// Moving notes
// ---------------------------------------------------------------------------

test("a note dragged onto another's top edge goes before it, and only the parent's list changes", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const [first, second, third] = ["a", "b", "c"].map((letter) => unique(`${letter}-order`)) as [string, string, string];
  const ids = await Promise.all([first, second, third].map((title) => createDocument(request, base, fixture(title))));
  const parentTitle = unique("order");
  const parent = await createDocument(request, base, fixture(parentTitle, ids));
  const texts = await Promise.all(ids.map((id) => rawText(request, base, id)));
  const order = async (): Promise<string[]> =>
    (await tree(page).locator(".folders-name").allTextContents()).filter((name) => [first, second, third].includes(name));

  await signIn(page, ADMIN);
  await openTree(page);
  await expect(row(page, third)).toBeVisible();
  expect(await order()).toEqual([first, second, third]);

  // Pick `third` up and carry it to the top edge of `first`: a line, not an outline.
  const target = row(page, first);
  await row(page, third).hover();
  await page.mouse.down();
  await target.hover({ position: { x: 40, y: 2 } });
  await target.hover({ position: { x: 40, y: 2 } });
  const lifted = page.locator(".folders-lifted");
  await expect(lifted).toBeVisible();
  await expect(lifted).toContainText(third);
  expect(await lifted.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect(page.locator(".folders-node-before")).toHaveCount(1);
  await expect(page.locator(".folders-node-drop")).toHaveCount(0);
  await page.mouse.up();
  await expect(lifted).toHaveCount(0);
  await expect.poll(order).toEqual([third, first, second]);
  await waitSynced(page);

  const [a, b, c] = ids as [string, string, string];
  expect(await listed(request, base, parent, [c, a, b])).toBe(fixture(parentTitle, [c, a, b]));
  // The notes themselves were not written to.
  for (const [index, id] of ids.entries()) expect(await rawText(request, base, id)).toBe(texts[index]);

  // And a reload draws the same order.
  await page.reload();
  await showSidebar(page);
  await expect.poll(order).toEqual([third, first, second]);
});

test("dragging a note into another files it last there, with everything under it", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const deepTitle = unique("deep");
  const deep = await createDocument(request, base, fixture(deepTitle));
  const movingTitle = unique("alpha");
  const moving = await createDocument(request, base, fixture(movingTitle, [deep]));
  const bystander = await createDocument(request, base, fixture(unique("already-there")));
  const destTitle = unique("beta");
  const dest = await createDocument(request, base, fixture(destTitle, [bystander]));
  const before = { moving: await rawText(request, base, moving), bystander: await rawText(request, base, bystander) };

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(row(page, movingTitle)).toBeVisible();
  await drag(page, row(page, movingTitle), row(page, destTitle));
  await waitSynced(page);

  // One line added to the destination, after what was there; nothing else in it moved.
  expect(await listed(request, base, dest, [bystander, moving])).toBe(fixture(destTitle, [bystander, moving]));
  // The moved note and its own list are untouched, so its child came along.
  expect(await rawText(request, base, moving)).toBe(before.moving);
  expect(await rawText(request, base, bystander)).toBe(before.bystander);
  await expect(row(page, movingTitle)).toHaveAttribute("aria-level", "2");
  await expect(row(page, deepTitle)).toHaveAttribute("aria-level", "3");
});

test("dropping a note on the root takes it out of its parent's list, and nothing else", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const title = unique("Going to root");
  const id = await createDocument(request, base, fixture(title));
  const stays = await createDocument(request, base, fixture(unique("stays")));
  const folderTitle = unique("filed");
  const folder = await createDocument(request, base, fixture(folderTitle, [id, stays]));
  const original = await rawText(request, base, id);

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  const leaf = row(page, title);
  await expect(leaf).toBeVisible();

  // While a drag is in flight the tree pins a "move to the root" strip to the bottom of
  // its on-screen slice, so the target is reachable however tall the tree has grown.
  const box = await leaf.boundingBox();
  if (!box) throw new Error("the row has no box");
  await leaf.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 6);
  const strip = page.locator(".folders-root-dropzone");
  await expect(strip).toBeVisible({ timeout: 5_000 });
  await strip.hover();
  await strip.hover();
  await page.mouse.up();
  await waitSynced(page);

  expect(await listed(request, base, folder, [stays])).toBe(fixture(folderTitle, [stays]));
  expect(await rawText(request, base, id)).toBe(original);
  await expect(row(page, title)).toHaveAttribute("aria-level", "1");
});

test("a note nobody lists is a row at the root, and clicking any row opens it", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const title = unique("Unfiled note");
  await createDocument(request, base, fixture(title));
  const childTitle = unique("inside");
  const child = await createDocument(request, base, fixture(childTitle));
  const folderTitle = unique("somewhere");
  const folder = await createDocument(request, base, fixture(folderTitle, [child]));

  await signIn(page, ADMIN);
  await openTree(page);
  await expect(row(page, title)).toHaveAttribute("aria-level", "1");
  await expect(row(page, folderTitle)).toHaveAttribute("aria-level", "1");
  await expect(row(page, childTitle)).toHaveAttribute("aria-level", "2");

  // A folder is a note: clicking it opens it; the chevron is what folds it.
  await row(page, folderTitle).click();
  await expect(page).toHaveURL(new RegExp(`#/doc/${folder}`));
  await expect(row(page, childTitle)).toBeVisible();
  await tree(page).getByRole("button", { name: `Collapse ${folderTitle}` }).click();
  await expect(row(page, childTitle)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Renaming, creating and deleting
// ---------------------------------------------------------------------------

test("a note is renamed inline, and a new note made inside it is listed there", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const name = unique("fresh");
  const renamed = `${name}-renamed`;
  const id = await createDocument(request, base, fixture(name));

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(row(page, name)).toBeVisible();

  await (await actions(page, name)).getByRole("menuitem", { name: /^Rename/ }).click();
  const field = page.getByRole("textbox", { name: `Rename ${name}` });
  await expect(field).toBeVisible();
  await field.fill(renamed);
  await field.press("Enter");
  await expect(row(page, renamed)).toBeVisible();
  await waitSynced(page);
  // One value splice: the title line, and nothing else.
  await expect.poll(async () => await rawText(request, base, id), { timeout: 20_000 }).toContain(`title: ${renamed}`);
  expect(await rawText(request, base, id)).toBe(fixture(name).replace(`title: ${name}`, `title: ${renamed}`));

  await (await actions(page, renamed)).getByRole("menuitem", { name: /^New note inside/ }).click();
  await expect(page).toHaveURL(/#\/doc\//);
  const created = /#\/doc\/([^?]+)/.exec(page.url())?.[1] ?? "";
  expect(created).not.toBe(id);
  await waitSynced(page);
  await listed(request, base, id, [created]);

  await page.reload();
  await showSidebar(page);
  await expect(row(page, renamed)).toBeVisible();
});

test("New search inside files a saved search under the note and opens it", async ({ page, request, baseURL }) => {
  const base = baseURL as string;
  const name = unique("searches");
  const id = await createDocument(request, base, fixture(name));

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(row(page, name)).toBeVisible();

  await (await actions(page, name)).getByRole("menuitem", { name: /^New search inside/ }).click();
  await expect(page).toHaveURL(/#\/doc\//);
  const created = /#\/doc\/([^?]+)/.exec(page.url())?.[1] ?? "";
  expect(created).not.toBe(id);
  await waitSynced(page);
  await listed(request, base, id, [created]);
  expect(await rawText(request, base, created)).toMatch(/^saved-search:/m);
});

test("deleting a note can keep what is inside it, in its place in the parent", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const leafTitle = unique("rehomed");
  const leaf = await createDocument(request, base, fixture(leafTitle));
  const doomedTitle = unique("doomed");
  const doomed = await createDocument(request, base, fixture(doomedTitle, [leaf]));
  const before = await createDocument(request, base, fixture(unique("before")));
  const after = await createDocument(request, base, fixture(unique("after")));
  const parentTitle = unique("keep");
  const parent = await createDocument(request, base, fixture(parentTitle, [before, doomed, after]));
  const leafText = await rawText(request, base, leaf);

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(row(page, doomedTitle)).toBeVisible();

  await (await actions(page, doomedTitle)).getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("menuitem", { name: `Keep them, in ${parentTitle}` }).click();
  await expect(page.getByRole("dialog")).toContainText(`move to ${parentTitle}`);
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  await waitSynced(page);

  // The child took the deleted note's place; the note itself is in Trash with no list.
  await listed(request, base, parent, [before, leaf, after]);
  expect(childrenIn(await rawText(request, base, doomed))).toEqual([]);
  expect(await rawText(request, base, leaf)).toBe(leafText);
  await expect(row(page, doomedTitle)).toHaveCount(0);
  await expect(row(page, leafTitle)).toHaveAttribute("aria-level", "2");
});

test("deleting a note can send everything inside it to Trash too, restorable in place", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const childTitle = unique("Doomed child");
  const child = await createDocument(request, base, fixture(childTitle));
  const folderTitle = unique("trashed");
  const folder = await createDocument(request, base, fixture(folderTitle, [child]));
  const folderText = await rawText(request, base, folder);

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(row(page, childTitle)).toBeVisible();

  await (await actions(page, folderTitle)).getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("menuitem", { name: "Delete them too" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  await waitSynced(page);
  await expect(row(page, folderTitle)).toHaveCount(0);
  await expect(row(page, childTitle)).toHaveCount(0);

  // Lists are left as they were, so restoring puts the child back inside its folder.
  expect(await rawText(request, base, folder)).toBe(folderText);
  await page.goto("/#/trash");
  for (const title of [folderTitle, childTitle]) {
    const trashed = page.locator(".doclist-item").filter({ hasText: title });
    await expect(trashed).toHaveCount(1);
    await trashed.getByRole("button", { name: /restore/i }).click();
    await expect(trashed).toHaveCount(0);
  }
  await openTree(page);
  await expect(row(page, childTitle)).toHaveAttribute("aria-level", "2");
});

test("a note with nothing inside is deleted after a confirm", async ({ page, request, baseURL }) => {
  const base = baseURL as string;
  const title = unique("Unwanted note");
  await createDocument(request, base, fixture(title));

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(row(page, title)).toBeVisible();

  await (await actions(page, title)).getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(row(page, title)).toBeVisible();

  await (await actions(page, title)).getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  await waitSynced(page);
  await expect(row(page, title)).toHaveCount(0);
  await page.goto("/#/trash");
  await expect(page.locator(".doclist-item").filter({ hasText: title })).toHaveCount(1);
});

test("a note folds and unfolds recursively: alt-click, the menu, and Shift+arrows", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const low = unique("low");
  const mid = unique("mid");
  const top = unique("deep");
  const lowId = await createDocument(request, base, fixture(low));
  const midId = await createDocument(request, base, fixture(mid, [lowId]));
  await createDocument(request, base, fixture(top, [midId]));

  await signIn(page, ADMIN);
  await openTree(page);
  const panel = tree(page);
  await expect(row(page, low)).toBeVisible();

  await (await actions(page, top)).getByRole("menuitem", { name: "Collapse all inside" }).click();
  await expect(row(page, mid)).toHaveCount(0);
  await panel.getByRole("button", { name: `Expand ${top}` }).click();
  await expect(row(page, mid)).toBeVisible();
  await expect(row(page, low)).toHaveCount(0);

  await panel.getByRole("button", { name: `Collapse ${top}` }).click();
  await panel.getByRole("button", { name: `Expand ${top}` }).click({ modifiers: ["Alt"] });
  await expect(row(page, low)).toBeVisible();

  await row(page, top).click();
  await panel.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(row(page, mid)).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(row(page, mid)).toBeVisible();
  await expect(row(page, low)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Where a new note lands — two plugins that cannot call each other
// ---------------------------------------------------------------------------

test('"New notes go to" decides where a new note is filed', async ({ page, request, baseURL }) => {
  const base = baseURL as string;
  const homeTitle = unique("inbox");
  const home = await createDocument(request, base, fixture(homeTitle));

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);

  // `doc-list` announces the note it made; `folders` hears it and files it.
  await page.goto("/#/settings/folders");
  const picker = page.getByLabel("New notes go to");
  await expect(picker).toBeVisible();
  await picker.selectOption(home);

  await runCommand(page, "New document");
  await expect(page).toHaveURL(/#\/doc\//);
  const filed = /#\/doc\/([^?]+)/.exec(page.url())?.[1] ?? "";
  await waitSynced(page);
  await listed(request, base, home, [filed]);

  // Back to the root: the next note is in nobody's list.
  await page.goto("/#/settings/folders");
  await page.getByLabel("New notes go to").selectOption("");
  await runCommand(page, "New document");
  await expect(page).toHaveURL(/#\/doc\//);
  const unfiled = /#\/doc\/([^?]+)/.exec(page.url())?.[1] ?? "";
  expect(unfiled).not.toBe(filed);
  await waitSynced(page);
  await openTree(page);
  await expect(tree(page).locator('[role="treeitem"][aria-level="1"]').filter({ hasText: "Untitled" }).first()).toBeVisible();
  expect(childrenIn(await rawText(request, base, home))).toEqual([filed]);
});

// ---------------------------------------------------------------------------
// The phone: the same moves, with no drag to make them with
// ---------------------------------------------------------------------------

test("at 390 px a note is moved through the sheet, and the panel holds the page", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const title = unique("Moved by touch");
  const id = await createDocument(request, base, fixture(title));
  const fromTitle = unique("phone-from");
  const from = await createDocument(request, base, fixture(fromTitle, [id]));
  const toTitle = unique("phone-to");
  const to = await createDocument(request, base, fixture(toTitle));

  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(row(page, title)).toBeVisible();

  // A phone has no ⋯ on a row: a long press opens its menu, as a sheet. A right-click is
  // the same `contextmenu` event.
  const sheet = async (): Promise<Locator> => {
    await row(page, title).click({ button: "right" });
    const menu = page.getByRole("dialog");
    await expect(menu).toBeVisible();
    return menu;
  };
  await (await sheet()).getByRole("menuitem", { name: "Move to…" }).click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("textbox", { name: "Filter notes" }).fill(toTitle);
  await picker.getByRole("button", { name: toTitle }).first().click();
  await waitSynced(page);

  await listed(request, base, to, [id]);
  await listed(request, base, from, []);

  // The sheet is portalled out of the sidebar on purpose — `shell-ui` declares
  // `container-type: inline-size` there, which traps a `position: fixed` panel.
  await sheet();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, "the move sheet scrolls the page sideways").toBeLessThanOrEqual(overflow.clientWidth);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".context-menu button")]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .filter((box) => box.height < 44 || box.width < 44).length,
  );
  expect(small, "a sheet control is under 44 px").toBe(0);
});

test("refuses to file a machine-owned document into a folder", async ({ page, request, baseURL }) => {
  const base = baseURL as string;
  // `machine: true` is what makes a document machine-owned (`_shared/machine-docs.ts`). A
  // probe rather than the *real* settings document, so a regression cannot wipe this
  // account's stored preferences for every spec that runs after.
  const original = "---\ntitle: Not yours to move\nmachine: true\n---\n\nprobe\n";
  const id = await createDocument(request, base, original);
  const destTitle = unique("machine-dest");
  await createDocument(request, base, fixture(destTitle));

  await signIn(page, ADMIN);
  await openTree(page);
  await expect(row(page, destTitle)).toBeVisible();
  await expect(row(page, "Not yours to move")).toHaveCount(0);

  // The route reaches it anyway: the command reads the id out of the URL.
  await openDocument(page, id);
  await runCommand(page, "Move this note to a folder");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/maintained by the app/i).first()).toBeVisible();
  await waitSynced(page);
  expect(await rawText(request, base, id)).toBe(original);
});

// ---------------------------------------------------------------------------
// The same note, moved again and again
// ---------------------------------------------------------------------------

/**
 * Every move of a note the client has held before must reach the server. The bug this
 * pins lost every second move of the same document: a move's `UPDATE` went out after an
 * unsubscribe the server had not seen yet. Moves now write the parents, so the hops run
 * between two parents that are both held open by the tree's own writes.
 */
test("a note moved back and forth lands every move, by drag and by menu", async ({ page, request, baseURL }) => {
  const base = baseURL as string;
  const title = unique("Hops between folders");
  const id = await createDocument(request, base, fixture(title));
  const anchorA = await createDocument(request, base, fixture(unique("stays in a")));
  const anchorB = await createDocument(request, base, fixture(unique("stays in b")));
  const aTitle = unique("hop-a");
  const a = await createDocument(request, base, fixture(aTitle, [anchorA, id]));
  const bTitle = unique("hop-b");
  const b = await createDocument(request, base, fixture(bTitle, [anchorB]));
  const original = await rawText(request, base, id);

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openDocument(page, id);
  await openTree(page);
  await expect(row(page, title)).toBeVisible();

  const byDrag = async (toTitle: string): Promise<void> => {
    await drag(page, row(page, title), row(page, toTitle));
  };
  const byMenu = async (toTitle: string): Promise<void> => {
    await (await actions(page, title)).getByRole("menuitem", { name: "Move to…" }).click();
    const picker = page.getByRole("dialog");
    await picker.getByRole("textbox", { name: "Filter notes" }).fill(toTitle);
    await picker.getByRole("button", { name: toTitle }).first().click();
  };

  const hops: Array<[string, (to: string) => Promise<void>]> = [
    [bTitle, byDrag],
    [aTitle, byDrag],
    [bTitle, byDrag],
    [aTitle, byMenu],
    [bTitle, byMenu],
    [aTitle, byMenu],
  ];
  for (const [index, [to, how]] of hops.entries()) {
    await how(to);
    await waitSynced(page);
    const [into, outOf, anchorInto, anchorOut] = to === aTitle ? [a, b, anchorA, anchorB] : [b, a, anchorB, anchorA];
    // The new parent is written first, then the old one: poll both.
    await listed(request, base, into, [anchorInto, id]);
    await listed(request, base, outOf, [anchorOut]);
    await expect(row(page, title)).toBeVisible();
  }
  expect(await rawText(request, base, id)).toBe(original);
});

test("a note takes a background and an icon from its menu, keeps them on reload and through a rename", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const name = unique("dressed");
  const renamed = `${name}-renamed`;
  const child = await createDocument(request, base, fixture(unique("inside")));
  await createDocument(request, base, fixture(name, [child]));

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(row(page, name)).toBeVisible();

  // `folder-style`'s entry, which `folders` lists without knowing who offered it.
  await (await actions(page, name)).getByRole("menuitem", { name: "Color and icon…" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "#1971c2" }).click();

  // With nothing typed the grid holds every icon, but draws only the rows in view.
  const grid = sheet.getByRole("listbox", { name: "Icons" });
  await expect(sheet.getByRole("status").filter({ hasText: /^[\d,]+ icons$/ })).toBeVisible();
  const total = Number((await grid.getByRole("option").first().getAttribute("aria-setsize")) ?? "0");
  expect(total).toBeGreaterThan(5000);
  expect(await grid.getByRole("option").count()).toBeLessThan(300);
  await grid.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(grid.locator(`[aria-posinset="${total}"]`)).toBeVisible();

  await sheet.getByRole("searchbox", { name: "Search icons" }).fill("rocket");
  await sheet.getByRole("option", { name: "rocket", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  const dressed = async (title: string): Promise<void> => {
    const pill = row(page, title).locator(".folders-dressed");
    await expect(pill).toHaveCSS("background-color", "rgb(25, 113, 194)");
    await expect(pill).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(pill.locator(".folders-icon svg path").first()).toBeAttached();
  };
  await dressed(name);

  await waitSynced(page);
  await page.reload();
  await showSidebar(page);
  await dressed(name);

  // Looks are kept by note id, so a rename keeps it with nothing to follow.
  await (await actions(page, name)).getByRole("menuitem", { name: /^Rename/ }).click();
  const rename = page.getByRole("textbox", { name: `Rename ${name}` });
  await rename.fill(renamed);
  await rename.press("Enter");
  await dressed(renamed);
});
