import { expect, test } from "@playwright/test";

import { createDocument, docRows, showSidebar, signIn, waitSynced } from "./helpers.js";

const MACHINE_DOC = [
  "---",
  "title: Machine owned thing",
  "machine: true",
  "---",
  "",
  "machine data lives here",
  "",
].join("\n");

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
    ["---", "title: An ordinary note", "---", "", "body", ""].join("\n"),
  );

  await signIn(page);
  await waitSynced(page);

  await expect(page.getByRole("button", { name: "An ordinary note", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Machine owned thing", exact: true })).toHaveCount(0);

  await showSidebar(page);
  const allDocuments = page.locator(".doclist-view", { hasText: "All documents" });
  const status = page.locator(".search-status");
  await expect(status).toHaveText(/^\d+ documents?$/);
  const listed = Number.parseInt((await status.textContent()) ?? "", 10);
  await expect(allDocuments.locator(".doclist-count")).toHaveText(String(listed));

  const tree = page.getByRole("tree", { name: /folders/i });
  await expect(tree.getByRole("treeitem", { name: /An ordinary note/ }).first()).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: /Machine owned thing/ })).toHaveCount(0);

  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("checkbox", { name: /show machine documents/i }).check();
  await expect(page.getByRole("button", { name: "Machine owned thing", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "An ordinary note", exact: true })).toBeVisible();

  await page.goto(`/#/doc/${ordinary}`);
  await expect(page.getByRole("tablist", { name: /document mode/i })).toBeVisible();
});

test("Ctrl+Space searches the list, which keeps its filters and its sort", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL as string;
  const needle = "quibblesearchword";
  await createDocument(request, base, `---\ntitle: Quibble ordinary\n---\n\nsays ${needle}\n`);
  await createDocument(
    request,
    base,
    `---\ntitle: Quibble machine\nmachine: true\n---\n\nalso ${needle}\n`,
  );

  await signIn(page);
  await waitSynced(page);
  await page.goto("/#/trash");
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();

  await page.keyboard.press("Control+Space");
  const search = page.getByRole("searchbox", { name: "Search documents" });
  await expect(search).toBeFocused();
  await expect(page).toHaveURL(/#\/$/);

  await search.fill(needle);
  await expect(page).toHaveURL(new RegExp(`#/\\?q=${needle}$`));
  await expect(page.getByRole("button", { name: "Quibble ordinary", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quibble machine", exact: true })).toHaveCount(0);
  await expect(docRows(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Sort by Best match$/ })).toBeVisible();
  await expect(page.locator(".search-status")).toHaveText(`1 result for “${needle}”`);

  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("checkbox", { name: /show machine documents/i }).check();
  await expect(page.getByRole("button", { name: "Quibble machine", exact: true })).toBeVisible();
  await expect(docRows(page)).toHaveCount(2);
  await page.getByRole("checkbox", { name: /show machine documents/i }).uncheck();

  await search.fill(`${needle} `);
  await search.press("x");
  await expect(search).toHaveValue(`${needle} x`);

  await search.fill("");
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("button", { name: /^Sort by Last updated$/ })).toBeVisible();
  await expect(page.locator(".search-status")).toContainText(/documents|Showing/);
});

test("?line=N opens the editor at that line, and a second link moves it again", async ({
  page,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL as string, LONG_DOC);

  await signIn(page);
  await waitSynced(page);

  await page.goto(`/#/doc/${id}`);
  await page.getByRole("tab", { name: "Edit" }).click();
  const scroller = page.locator(".cm-scroller");
  await expect(scroller).toBeVisible();
  await expect(async () => {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  }).toPass();

  await page.goto(`/#/doc/${id}?line=300`);
  await expect(async () => {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  }).toPass();
  const deep = await scroller.evaluate((element) => element.scrollTop);

  await page.goto(`/#/doc/${id}?line=5`);
  await expect(async () => {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(deep);
  }).toPass();

  await page.goto(`/#/doc/${id}?line=99999`);
  await expect(scroller).toBeVisible();
  await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
});
