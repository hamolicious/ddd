/**
 * Two browsing behaviours that only exist once every layer is assembled, and that no
 * unit test can reach.
 *
 * **Machine-owned documents are hidden by default.** The kernel stores each user's
 * settings as a document with `fm.path: .settings` (SPEC §6.4), which is the right
 * design and had one visible consequence nobody chose: the sidebar counted it, the
 * document list listed it, and the folder tree grew a `.settings` folder you could
 * drag notes into. The rule and its DSL clause are unit-tested against the real Wasm
 * evaluator (`plugins/base/_shared/machine-docs.test.ts`); what is only testable here
 * is that **three plugins agree** — the list, the sidebar count and the tree — and that
 * the toggle really brings the document back rather than merely existing.
 *
 * **`?line=N` moves the editor.** The parser is unit-tested
 * (`document-surface/src/line.test.ts`) and the search side builds the link
 * (`search/src/hash.ts`), but "the editor actually scrolled" is a CodeMirror viewport
 * fact: it needs a real document long enough to scroll and a real layout to scroll in.
 */

import { expect, test } from "@playwright/test";

import { createDocument, docRows, showSidebar, signIn, waitSynced } from "./helpers.js";

/** A document filed the way the kernel files its settings documents. */
const MACHINE_DOC = [
  "---",
  "title: Machine owned thing",
  "path: .settings",
  "---",
  "",
  "machine data lives here",
  "",
].join("\n");

/** Long enough that line 300 cannot be on screen at the top of the document. */
const LONG_DOC = [
  "---",
  "title: A long document",
  "---",
  "",
  ...Array.from({ length: 400 }, (_, index) => `line ${index + 1} of the body`),
  "",
].join("\n");

test("a machine-owned document is out of the list, the count and the tree — until asked for", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  await createDocument(request, base, MACHINE_DOC);
  const ordinary = await createDocument(
    request,
    base,
    ["---", "title: An ordinary note", "path: home", "---", "", "body", ""].join("\n"),
  );

  await signIn(page);
  await waitSynced(page);

  // The ordinary document is there; the machine-owned one is not.
  await expect(page.getByRole("button", { name: "An ordinary note" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Machine owned thing" })).toHaveCount(0);

  // The sidebar count agrees with the list — the two disagreeing is the bug this
  // whole rule exists to fix, and it is the half a person actually notices.
  await showSidebar(page);
  const allDocuments = page.locator(".doclist-view", { hasText: "All documents" });
  const listed = await docRows(page).count();
  await expect(allDocuments.locator(".doclist-count")).toHaveText(String(listed));

  // And the folder tree has no `.settings` folder to drag anything into. `home` is
  // there, so this is "the tree is built and lacks it", not "the tree is empty".
  const tree = page.getByRole("tree", { name: /folders/i });
  await expect(tree.getByRole("treeitem", { name: /home/ })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: /\.settings/ })).toHaveCount(0);

  // The toggle is a view default, not access control: asking brings it back.
  await page.getByRole("checkbox", { name: /show machine documents/i }).check();
  await expect(page.getByRole("button", { name: "Machine owned thing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "An ordinary note" })).toBeVisible();

  // Hidden or not, a direct link always worked — nothing here changed what the
  // workspace holds or what a link resolves to.
  await page.goto(`/#/doc/${ordinary}`);
  await expect(page.getByRole("tablist", { name: /document mode/i })).toBeVisible();
});

test("?line=N opens the editor at that line, and a second link moves it again", async ({
  page,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL as string, LONG_DOC);

  await signIn(page);
  await waitSynced(page);

  // No `?line=`: the document opens at the top, which is the behaviour a deep link
  // must not become the default of.
  await page.goto(`/#/doc/${id}`);
  await page.getByRole("tab", { name: "Edit" }).click();
  const scroller = page.locator(".cm-scroller");
  await expect(scroller).toBeVisible();
  await expect(async () => {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  }).toPass();

  // With one: the editor scrolls to it. The assertion is the viewport rather than the
  // cursor because scrolling is the observable half — a cursor on a line nobody can
  // see is exactly the failure this feature exists to prevent.
  await page.goto(`/#/doc/${id}?line=300`);
  await expect(async () => {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  }).toPass();
  const deep = await scroller.evaluate((element) => element.scrollTop);

  // A **query-only** navigation, which is what following a second search result into
  // the document already on screen is. The editor stays mounted, so this is the path
  // through the surface's router subscription rather than through a fresh mount — and
  // it was the one that silently did nothing while everything else worked.
  await page.goto(`/#/doc/${id}?line=5`);
  await expect(async () => {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(deep);
  }).toPass();

  // A line past the end is clamped, not an error: a deep link into a document that has
  // since been shortened still opens it.
  await page.goto(`/#/doc/${id}?line=99999`);
  await expect(scroller).toBeVisible();
  await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
});
