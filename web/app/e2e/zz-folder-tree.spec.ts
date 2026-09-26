/**
 * The folder tree as a file manager — verified against what the **server** ends up
 * holding, not against what the panel says it did.
 *
 * The owner's ask was "folder plugin should render as actual filetree, letting me drag
 * and drop files between folders, rearrange folders, add and delete folders" and "notes
 * with no folder just sit in root". Every one of those verbs is a write, and in this
 * product a metadata write has a shape as well as a result: **one line splice per
 * document** (SPEC §3.3). A move that produced the right `fm.path` by parsing the block
 * and writing it back would look identical in the tree and would have destroyed the
 * user's comments, key order and blank lines on the way. So each test below reads the
 * raw text over REST and byte-compares it against the fixture it started from — the same
 * standard `journeys.spec.ts` holds a *document* drag to, extended to the four writes
 * that drag never covered: a folder move, a drop on Root, a folder delete, and the
 * pointer-free path a phone has to use instead.
 *
 * Named `zz-` so it runs last. The suite shares one workspace and one account
 * (`playwright.app.config.ts`), and this file adds a dozen documents to it; several
 * earlier specs assert on workspace-wide counts, so arriving before them would make this
 * file's setup their flake.
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
  waitSynced,
} from "./helpers.js";

/**
 * A fixture document, written by hand so the splice assertion can be exact.
 *
 * The comment, the key order (`path` before `title`) and the blank line inside the block
 * are the three things a parse→re-serialize→replace round trip destroys and a splice
 * keeps. The `%%%` section is the fourth: it belongs to another plugin and nothing here
 * may touch it.
 */
function fixture(title: string, path: string | undefined): string {
  const front = ["---", "# a comment only a splice survives"];
  if (path !== undefined) front.push(`path: ${path}`);
  front.push(`title: ${title}`, "", "tags: [alpha, beta]", "---");
  return [
    ...front,
    "",
    `# ${title}`,
    "",
    "body stays put",
    "",
    "%%% sweep-demo",
    "source-uid: keep-me@example.com",
    "%%%",
    "",
  ].join("\n");
}

/** A unique prefix per test: one workspace, and a folder name is global to it. */
function unique(tag: string): string {
  return `${tag}-${Math.random().toString(36).slice(2, 8)}`;
}

function tree(page: Page): Locator {
  return page.getByRole("tree", { name: "Folders" });
}

/** A folder row's own button, by its leaf name. */
function folderRow(page: Page, name: string): Locator {
  return tree(page).getByRole("button", { name, exact: true });
}

/**
 * The `treeitem` a folder's name button sits in — the row, not the label.
 *
 * `has:` is given a **page-rooted** locator deliberately: Playwright re-roots it at each
 * candidate row, and a locator chained off `tree(page)` would instead be looked for
 * starting at the tree and match nothing inside a row.
 */
function folderNode(page: Page, name: string): Locator {
  return page
    .locator(".folders-node")
    .filter({ has: page.getByRole("button", { name, exact: true }) })
    .first();
}

/**
 * Drag one element onto another with real pointer events.
 *
 * Not `locator.dragTo`: that moves the mouse to the target in two jumps, and Chromium's
 * HTML5 drag machinery needs a `dragover` on the destination shortly *before* the drop
 * for the drop to be accepted at all. In a tree of a dozen rows the two-jump version
 * landed the pointer on the right row with no intervening `dragover` often enough to be
 * a coin flip — a test that failed with the document still in its old folder and nothing
 * to say about why. The intermediate moves are what make the gesture the one a hand
 * makes.
 */
async function dragOnto(
  page: Page,
  source: Locator,
  target: Locator,
  position?: { x: number; y: number },
): Promise<void> {
  await source.hover();
  await page.mouse.down();
  // Twice, and through `hover()` rather than `mouse.move`: the first pass is what starts
  // the drag (Chromium needs a move *after* the button goes down before it will treat
  // the gesture as one), the second is the `dragover` on the destination that a drop is
  // only accepted after. `hover()` re-resolves the element each time, so a tree that
  // scrolls or re-renders mid-drag still gets the pointer put on the right row.
  await target.hover(position ? { position } : {});
  await target.hover(position ? { position } : {});
  // A destination that accepted the drag outlines itself (`.folders-node-drop`, set in
  // `dragover`). Waiting for that waits for the browser to have accepted the gesture,
  // and fails *here* — "nothing accepted the drag" — rather than three assertions later
  // as a document that did not move.
  await expect(page.locator(".folders-node-drop, .folders-tree-root-drop").first()).toBeVisible({
    timeout: 5_000,
  });
  await page.mouse.up();
}

/**
 * Open the sidebar and wait for the tree to have finished its first query.
 *
 * `folders` renders "Loading folders…" until the projection answers, and a test that
 * queried a row inside that window would be testing its own timing.
 */
async function openTree(page: Page): Promise<Locator> {
  await page.goto("/");
  await showSidebar(page);
  const panel = tree(page);
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Fail the test if anything opens a native dialog.
 *
 * POLISH-BACKLOG §4: folder rename used to be `window.prompt`, which is untested inside
 * the Flutter shell (no `onJsPrompt` handler is registered) and may simply do nothing
 * there. Playwright auto-dismisses dialogs, so a regression would *not* fail on its own —
 * it would look like a rename that silently did nothing.
 */
function refuseNativeDialogs(page: Page): void {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
}

/** Poll the stored text until the splice lands, then return it. */
async function settled(
  request: APIRequestContext,
  baseURL: string,
  id: string,
  contains: string,
): Promise<string> {
  await expect
    .poll(async () => await rawText(request, baseURL, id), { timeout: 20_000 })
    .toContain(contains);
  return await rawText(request, baseURL, id);
}

// ---------------------------------------------------------------------------
// Rearranging folders
// ---------------------------------------------------------------------------

test("a folder dragged onto another's top edge goes before it, lifted, and stays there", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const parent = unique("order");
  // Named so that by name they sort first, second, third.
  const [first, second, third] = ["a", "b", "c"].map((letter) => unique(`${letter}-order`)) as [
    string,
    string,
    string,
  ];
  const ids = await Promise.all(
    [first, second, third].map((child) =>
      createDocument(request, base, fixture(`In ${child}`, `${parent}/${child}`)),
    ),
  );
  const order = async (): Promise<string[]> =>
    (await tree(page).locator(".folders-node .folders-name").allTextContents()).filter((name) =>
      [first, second, third].includes(name),
    );

  await signIn(page, ADMIN);
  await openTree(page);
  await expect(folderRow(page, third)).toBeVisible();
  expect(await order()).toEqual([first, second, third]);

  // Pick `third` up and carry it to the top edge of `first`.
  const target = folderNode(page, first);
  await folderNode(page, third).hover();
  await page.mouse.down();
  await target.hover({ position: { x: 40, y: 2 } });
  await target.hover({ position: { x: 40, y: 2 } });

  // Lifted, not a translucent ghost: an opaque copy under the pointer, and a line
  // (not an outline) on the row it will go before.
  const lifted = page.locator(".folders-lifted");
  await expect(lifted).toBeVisible();
  await expect(lifted).toContainText(third);
  expect(await lifted.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect(page.locator(".folders-node-before")).toHaveCount(1);
  await expect(page.locator(".folders-node-drop")).toHaveCount(0);

  await page.mouse.up();
  await expect(lifted).toHaveCount(0);
  await expect.poll(order).toEqual([third, first, second]);

  // A reorder is the user's order, not a move: no document was written to.
  for (const [index, child] of [first, second, third].entries()) {
    expect(await rawText(request, base, ids[index] as string)).toContain(`path: ${parent}/${child}`);
  }

  // And it is stored: a reload draws the same order.
  await waitSynced(page);
  await page.reload();
  await showSidebar(page);
  await expect(folderRow(page, third)).toBeVisible();
  await expect.poll(order).toEqual([third, first, second]);
});

test("dragging a folder into another re-prefixes every document inside it, one splice each", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const a = unique("alpha");
  const b = unique("beta");

  // Two levels inside the folder being moved, so the assertion covers a document filed
  // *below* the folder as well as one directly in it — the case where a naive
  // implementation re-prefixes the direct children and orphans the rest.
  const direct = await createDocument(request, base, fixture("Direct child", a));
  const deep = await createDocument(request, base, fixture("Deep child", `${a}/deep`));
  // A document in the destination that must not move: a folder move writes only to the
  // documents whose path actually changes (`planFolderMove` omits the rest), and a
  // splice that rewrites the same value is still a CRDT transaction.
  const bystander = await createDocument(request, base, fixture("Already in beta", b));
  const before = await rawText(request, base, bystander);

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);

  await expect(folderRow(page, a)).toBeVisible();
  await expect(folderRow(page, b)).toBeVisible();
  await dragOnto(page, folderNode(page, a), folderNode(page, b));
  await waitSynced(page);

  // The whole subtree moved, prefix intact.
  expect(await settled(request, base, direct, `path: ${b}/${a}`)).toBe(
    fixture("Direct child", a).replace(`path: ${a}`, `path: ${b}/${a}`),
  );
  expect(await settled(request, base, deep, `path: ${b}/${a}/deep`)).toBe(
    fixture("Deep child", `${a}/deep`).replace(`path: ${a}/deep`, `path: ${b}/${a}/deep`),
  );

  // Byte-for-byte, including the comment and the machine section.
  const moved = await rawText(request, base, direct);
  expect(moved).toContain("# a comment only a splice survives");
  expect(moved).toContain("%%% sweep-demo");
  expect(moved).toContain("source-uid: keep-me@example.com");

  // And the document that was already there was not written to at all.
  expect(await rawText(request, base, bystander)).toBe(before);

  // The tree reflects it without a reload: `alpha` is now a child of `beta`.
  await expect(folderRow(page, b)).toBeVisible();
  await expect(folderRow(page, a)).toBeVisible();
});

test("dropping a document on Root removes the path line and leaves the rest byte-identical", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const folder = unique("filed");
  const original = fixture("Going to root", folder);
  const id = await createDocument(request, base, original);

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(folderRow(page, folder)).toBeVisible();

  // The document's row in the tree itself, not `doc-list`'s: the ask is about the tree
  // behaving like a file manager, and the row has to be the thing you can pick up.
  const leaf = page.locator(".folders-node-leaf", { hasText: "Going to root" }).first();
  await expect(leaf).toBeVisible();
  // Root has no button any more. While a drag is in flight the tree renders a sticky
  // "move to root" strip pinned to the bottom of its on-screen slice, so the target is
  // reachable however tall the tree has grown. The strip only exists after `dragstart`,
  // which Chromium fires on the first move *after* the button goes down — hence the
  // small wiggle before the strip can be hovered.
  const leafBox = await leaf.boundingBox();
  if (!leafBox) throw new Error("the leaf has no box");
  await leaf.hover();
  await page.mouse.down();
  await page.mouse.move(leafBox.x + leafBox.width / 2 + 6, leafBox.y + leafBox.height / 2 + 6);
  const strip = page.locator(".folders-root-dropzone");
  await expect(strip).toBeVisible({ timeout: 5_000 });
  await strip.hover();
  await strip.hover(); // the dragover a drop is only accepted after
  await expect(page.locator(".folders-node-drop").first()).toBeVisible({ timeout: 5_000 });
  await page.mouse.up();
  await waitSynced(page);

  await expect
    .poll(async () => await rawText(request, base, id), { timeout: 20_000 })
    .not.toContain("path:");

  // `removeFrontmatterKey`, not "set it to empty": the line is gone, and every other
  // line — the comment above where it used to be included — is where it was.
  const rooted = await rawText(request, base, id);
  expect(rooted).toBe(original.replace(`path: ${folder}\n`, ""));
  expect(rooted).toContain("# a comment only a splice survives");
  expect(rooted).toContain("tags: [alpha, beta]");
  expect(rooted).toContain("%%% sweep-demo");
});

test("a document with no folder is a row at the root of the tree", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const title = unique("Unfiled note");
  await createDocument(request, base, fixture(title, undefined));
  // A folder, so "at root" means something: the pathless document has to be a sibling of
  // the top-level folders, not a row that only looks right in an empty tree.
  const folder = unique("somewhere");
  await createDocument(request, base, fixture("Filed away", folder));

  await signIn(page, ADMIN);
  await openTree(page);

  const row = page.locator(".folders-node-leaf", { hasText: title }).first();
  await expect(row).toBeVisible();
  // `aria-level` 1 is the tree's own statement that this row is at the top level, and
  // it is what a screen reader announces. The same level as the folders beside it.
  await expect(row).toHaveAttribute("aria-level", "1");
  await expect(folderNode(page, folder)).toHaveAttribute("aria-level", "1");

  // Clicking it opens the document — a leaf in a file tree is a file.
  await row.click();
  await expect(page).toHaveURL(/#\/doc\//);
});

// ---------------------------------------------------------------------------
// Adding, renaming and deleting folders
// ---------------------------------------------------------------------------

test("a folder can be created empty, filled, renamed inline and survives a reload", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const name = unique("fresh");
  const renamed = `${name}-renamed`;

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);

  // Created with no document in it at all — the thing `fm.path` alone cannot express,
  // and the reason this plugin keeps a list of empty folders in its own settings.
  // The toolbar is gone; the palette command is the create path now.
  await runCommand(page, "New folder");
  const field = page.getByRole("textbox", { name: "New folder name" });
  await expect(field).toBeVisible();
  await field.fill(name);
  await field.press("Enter");
  await expect(folderRow(page, name)).toBeVisible();

  // It is still there after a reload: an empty folder that lived only in React state
  // would pass every assertion up to this line.
  await waitSynced(page);
  await page.reload();
  await showSidebar(page);
  await expect(folderRow(page, name)).toBeVisible();

  // Rename, inline. No `window.prompt` (POLISH-BACKLOG §4) — `refuseNativeDialogs`
  // above is what makes that a checked claim rather than a description.
  // Folder operations live behind the row's ⋯ menu, which is hover-gated (hidden until
  // `:hover`/`:focus-within`/active), so the pointer has to be in the row first.
  await folderRow(page, name).hover();
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("dialog").getByRole("menuitem", { name: /^Rename/ }).click();
  const rename = page.getByRole("textbox", { name: `Rename or move ${name}` });
  await expect(rename).toBeVisible();
  await rename.fill(renamed);
  await rename.press("Enter");
  await expect(folderRow(page, renamed)).toBeVisible();

  // Put a document in it through the row's own menu, and the folder stops being empty
  // bookkeeping and becomes a `path:` line like any other.
  await folderRow(page, renamed).hover();
  await page.getByRole("button", { name: `Actions for ${renamed}` }).click();
  await page.getByRole("dialog").getByRole("menuitem", { name: /^New document here/ }).click();
  await expect(page).toHaveURL(/#\/doc\//);
  const id = /#\/doc\/([^?]+)/.exec(page.url())?.[1] ?? "";
  expect(id, "the folder's menu created a document").toBeTruthy();
  await waitSynced(page);

  // The created text names the folder the button belongs to — an explicit path, which
  // is also the case that must win over the "new notes go to" default.
  const created = await settled(request, base, id, `path: ${renamed}`);
  expect(created).toContain(`path: ${renamed}`);

  // And after a reload the folder is still there, now held up by the document rather
  // than by the settings entry that has been dropped.
  await page.reload();
  await showSidebar(page);
  await expect(folderRow(page, renamed)).toBeVisible();
});

test("deleting a folder moves its documents to the parent, by splice", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const parent = unique("keep");
  const doomed = `${parent}/${unique("doomed")}`;
  const leaf = doomed.slice(doomed.indexOf("/") + 1);
  const original = fixture("Rehomed", doomed);
  const id = await createDocument(request, base, original);

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(folderRow(page, leaf)).toBeVisible();

  await folderRow(page, leaf).hover();
  await page.getByRole("button", { name: `Actions for ${doomed}` }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("menuitem", { name: "Delete folder" }).click();

  // The choice the user is offered, in the words the plugin offers it in: the documents
  // have to go somewhere, because a folder is only a `path:` line.
  const confirm = page.getByRole("dialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("menuitem", { name: `Move them to ${parent}` }).click();
  await waitSynced(page);

  // One splice: the path is the parent's, the rest of the file is untouched.
  const rehomed = await settled(request, base, id, `path: ${parent}\n`);
  expect(rehomed).toBe(original.replace(`path: ${doomed}`, `path: ${parent}`));
  expect(rehomed).toContain("# a comment only a splice survives");

  // The folder is gone from the tree; the parent is not.
  await expect(folderRow(page, leaf)).toHaveCount(0);
  await expect(folderRow(page, parent)).toBeVisible();
});

test("deleting a folder can send its documents to Trash instead", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const folder = unique("trashed");
  const title = unique("Doomed note");
  const id = await createDocument(request, base, fixture(title, folder));

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(folderRow(page, folder)).toBeVisible();

  await folderRow(page, folder).hover();
  await page.getByRole("button", { name: `Actions for ${folder}` }).click();
  await page.getByRole("dialog").getByRole("menuitem", { name: "Delete folder" }).click();
  await page.getByRole("dialog").getByRole("menuitem", { name: "Move them to Trash" }).click();
  await waitSynced(page);

  // A tombstone, not a purge (SPEC §3.5 — the id stays forever, and `GET
  // /api/documents/:id` still answers 200 for it). What changes is where it is: out of
  // the tree and the list, into Trash, restorable — which is the promise the sheet's
  // hint makes, so it is the thing to check.
  await expect(folderRow(page, folder)).toHaveCount(0);
  await expect(page.locator(".folders-node-leaf", { hasText: title })).toHaveCount(0);

  await page.goto("/#/trash");
  const trashed = page.locator(".doclist-item").filter({ hasText: title });
  await expect(trashed).toHaveCount(1);
  await trashed.getByRole("button", { name: /restore/i }).click();
  await expect(trashed).toHaveCount(0);

  // Restored with its `path` intact: "move them to Trash" deleted documents, it did not
  // also rewrite them, so the folder comes back with the document that made it.
  await expect
    .poll(async () => await rawText(request, base, id), { timeout: 20_000 })
    .toContain(`path: ${folder}`);
  expect(await rawText(request, base, id)).toBe(fixture(title, folder));
});

// ---------------------------------------------------------------------------
// Where a new document lands — two plugins that cannot call each other
// ---------------------------------------------------------------------------

test('"New notes go to" decides where an unfiled document is created', async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const home = unique("inbox");
  await createDocument(request, base, fixture("Makes the folder exist", home));

  await signIn(page, ADMIN);
  refuseNativeDialogs(page);

  // The seam under test is a `kernel.events` message, not a service call: `folders`
  // depends on `doc-list`, so the arrow a service call needs points the wrong way and
  // the reverse edge would be a cycle the loader cannot order. An event bus needs no
  // dependency in either direction — and gives no replay and no ordering guarantee,
  // which is why "does the listener hear it?" is worth an end-to-end test rather than a
  // unit test on either side.
  await page.goto("/#/settings/folders");
  const picker = page.getByLabel("New notes go to");
  await expect(picker).toBeVisible();
  await picker.selectOption(home);

  // No reload between setting it and using it: the announcement is live.
  await runCommand(page, "New document");
  await expect(page).toHaveURL(/#\/doc\//);
  const filed = /#\/doc\/([^?]+)/.exec(page.url())?.[1] ?? "";
  await waitSynced(page);
  expect(await settled(request, base, filed, `path: ${home}`)).toContain(`path: ${home}`);

  // Back to root, and the `path:` line is not written at all — an empty setting is the
  // absence of a key, not `path: ""`.
  await page.goto("/#/settings/folders");
  await page.getByLabel("New notes go to").selectOption("");
  await runCommand(page, "New document");
  await expect(page).toHaveURL(/#\/doc\//);
  const unfiled = /#\/doc\/([^?]+)/.exec(page.url())?.[1] ?? "";
  expect(unfiled).not.toBe(filed);
  await waitSynced(page);
  await expect
    .poll(async () => await rawText(request, base, unfiled), { timeout: 20_000 })
    .toContain("title:");
  expect(await rawText(request, base, unfiled)).not.toContain("path:");
});

// ---------------------------------------------------------------------------
// The phone: the same moves, with no drag to make them with
// ---------------------------------------------------------------------------

test("at 390 px a document is moved through the sheet, and the panel holds the page", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const from = unique("phone-from");
  const to = unique("phone-to");
  const original = fixture("Moved by touch", from);
  const id = await createDocument(request, base, original);
  await createDocument(request, base, fixture("Lives in the destination", to));

  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ADMIN);
  refuseNativeDialogs(page);
  await openTree(page);
  await expect(folderRow(page, from)).toBeVisible();

  // HTML5 drag and drop does not fire from touch, which is POLISH-BACKLOG §3 in one
  // sentence: on a phone the tree used to have no move affordance at all.
  const leaf = page.locator(".folders-node-leaf", { hasText: "Moved by touch" }).first();
  await expect(leaf).toBeVisible();
  await leaf.hover();
  await leaf.getByRole("button", { name: "Document actions" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  // Scoped to the sheet: `doc-list`'s row action is "Move to Trash", and an unscoped
  // "Move to…" query matches both.
  await sheet.getByRole("menuitem", { name: "Move to…" }).click();

  const picker = page.getByRole("dialog");
  await picker.getByRole("textbox", { name: "Filter folders" }).fill(to);
  await picker.getByRole("button", { name: to }).first().click();
  await waitSynced(page);

  expect(await settled(request, base, id, `path: ${to}`)).toBe(
    original.replace(`path: ${from}`, `path: ${to}`),
  );

  // The sheet is portalled out of the sidebar on purpose — `shell-ui` declares
  // `container-type: inline-size` there, which traps a `position: fixed` panel — so the
  // zero-overflow net has to be re-run with one open.
  await leaf.hover();
  await leaf.getByRole("button", { name: "Document actions" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, "the move sheet scrolls the page sideways").toBeLessThanOrEqual(
    overflow.clientWidth,
  );

  // And the sheet's own controls are tappable at that width (SPEC §6.5's 44 px).
  const small = await page.evaluate(() => {
    return [...document.querySelectorAll<HTMLElement>(".context-menu button")]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .filter((box) => box.height < 44 || box.width < 44).length;
  });
  expect(small, "a sheet control is under 44 px").toBe(0);
});

test("refuses to file a machine-owned document into a folder", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const to = unique("machine-dest");
  // A dotted path is what makes a document machine-owned (`_shared/machine-docs.ts`).
  // A probe rather than the *real* settings document, because the failure this pins is
  // that the real one was movable: reproducing it against the live one would wipe this
  // account's stored preferences for every spec that runs after.
  const original = fixture("Not yours to move", ".probe-machine");
  const id = await createDocument(request, base, original);
  await createDocument(request, base, fixture("A real destination", to));

  await signIn(page, ADMIN);
  await openTree(page);
  await expect(folderRow(page, to)).toBeVisible();
  // It is not in the tree at all — the exclusion the browsing plugins share.
  await expect(tree(page).getByRole("button", { name: ".probe-machine" })).toHaveCount(0);

  // The route reaches it anyway, and this is the entry point that used to splice it:
  // the command reads the id out of the URL, which never went through the tree's rows.
  await openDocument(page, id);
  await runCommand(page, "Move this document to a folder");

  // No picker, and a notice instead. (`getByRole("dialog")` is the sheet; the palette
  // has already closed by the time `runCommand` returns.)
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/maintained by the app/i).first()).toBeVisible();

  // And the document is byte-identical: `fm.path` still names the machine folder, so a
  // kernel settings document filed the same way stays where its query is looking.
  await waitSynced(page);
  expect(await rawText(request, base, id)).toBe(original);
  expect(await rawText(request, base, id)).toContain("path: .probe-machine");
});
