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
  const status = page.locator(".doclist-status");
  await expect(status).toHaveText(/^\d+ documents?$/);
  const listed = Number.parseInt((await status.textContent()) ?? "", 10);
  await expect(allDocuments.locator(".doclist-count")).toHaveText(String(listed));

  const tree = page.getByRole("tree", { name: /folders/i });
  await expect(tree.getByRole("treeitem", { name: /An ordinary note/ }).first()).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: /Machine owned thing/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Advanced search" }).click();
  await expect(page.getByRole("button", { name: /^from / })).toHaveCount(0);
  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("menuitem", { name: /^Include machine notes/ }).click();
  await expect(page.getByRole("button", { name: /^from notes, with machine notes/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Machine owned thing", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "An ordinary note", exact: true })).toBeVisible();

  await page.goto(`/#/doc/${ordinary}`);
  await expect(page.getByRole("tablist", { name: /document mode/i })).toBeVisible();
});

test("Ctrl+Space searches the list, and advanced search keeps its filters and its sort", async ({
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

  await search.fill("quibblesearchwrod");
  await expect(page.getByRole("button", { name: "Quibble ordinary", exact: true })).toBeVisible();

  await search.fill(needle);
  await expect(page).toHaveURL(new RegExp(`#/\\?q=${needle}$`));
  await expect(page.getByRole("button", { name: "Quibble ordinary", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quibble machine", exact: true })).toHaveCount(0);
  await expect(docRows(page)).toHaveCount(1);
  await expect(page.locator(".doclist-status")).toHaveText(`1 result for “${needle}”`);
  await expect(page.locator(".doclist-note-match mark")).toHaveText(needle);
  await search.press("ArrowDown");
  await expect(page.locator(".doclist-note-open").first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();
  await expect(page.getByRole("button", { name: /^Filters/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Advanced search" }).click();
  await expect(page).toHaveURL(new RegExp(`#/\\?fuzzy=${needle}&advanced=1$`));
  const fuzzyWords = page.getByRole("searchbox", { name: "Typo-tolerant words" });
  await expect(fuzzyWords).toHaveValue(needle);
  await expect(search).toHaveCount(0);
  await expect(docRows(page)).toHaveCount(1);
  await expect(page.locator(".search-status")).toHaveText(`1 result for “${needle}”`);

  await page.getByRole("button", { name: "Remove typo-tolerant words" }).click();
  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("menuitem", { name: /^Words to find/ }).click();
  await expect(search).toBeFocused();
  await search.fill(needle);
  await expect(page).toHaveURL(new RegExp(`#/\\?q=${needle}&advanced=1$`));
  await expect(page.getByRole("button", { name: /^sort / })).toHaveCount(0);

  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("menuitem", { name: /^Include machine notes/ }).click();
  await expect(page.getByRole("button", { name: "Quibble machine", exact: true })).toBeVisible();
  await expect(docRows(page)).toHaveCount(2);
  await page.getByRole("button", { name: /^from notes, with machine notes/ }).click();
  await page.getByRole("checkbox", { name: /show machine documents/i }).click();
  await expect(page.getByRole("dialog", { name: "From" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^from / })).toHaveCount(0);
  await expect(docRows(page)).toHaveCount(1);

  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("menuitem", { name: /^Sort/ }).click();
  await page.getByRole("menuitemradio", { name: /Title/ }).click();
  await expect(page.getByRole("button", { name: /^sort Title/ })).toBeVisible();
  await page.getByRole("button", { name: /^sort Title/ }).click();
  await page.getByRole("menuitem", { name: "Remove sort" }).click();
  await expect(page.getByRole("button", { name: /^sort / })).toHaveCount(0);

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Show as code" }).click();
  await expect(page.locator(".search-code-text")).toContainText(`.text("${needle}")`);
  await expect(page.locator(".search-code-text")).toContainText('.sort("relevance", "-updated_at")');
  await expect(page.getByRole("dialog", { name: "As code" }).locator(".search-code-text span").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".search-code-text")).toHaveCount(0);

  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("menuitem", { name: /^Typo-tolerant words/ }).click();
  await expect(fuzzyWords).toBeFocused();
  await fuzzyWords.fill("quibblesearchwrod");
  await expect(page.getByRole("button", { name: "Quibble ordinary", exact: true })).toBeVisible();
  await expect(page.locator(".doclist-note-match mark")).toHaveText(needle);
  await expect(page).toHaveURL(/fuzzy=quibblesearchwrod/);
  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByRole("menuitem", { name: /^Sort/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^sort Match score, best match first/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quibble ordinary", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Show as code" }).click();
  await expect(page.locator(".search-code-text")).toContainText(`.text("${needle}")`);
  await expect(page.locator(".search-code-text")).toContainText('.fuzzy("quibblesearchwrod")\n  .sort("-score")');
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Remove typo-tolerant words" }).click();
  await expect(fuzzyWords).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^sort / })).toHaveCount(0);
  await expect(docRows(page)).toHaveCount(1);

  await search.fill(`${needle} `);
  await search.press("x");
  await expect(search).toHaveValue(`${needle} x`);

  await search.fill("");
  await expect(page).toHaveURL(/#\/\?advanced=1$/);
  await expect(page.locator(".search-status")).toContainText(/documents|Showing/);

  await page.getByRole("button", { name: "Basic search" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("button", { name: "Advanced search" })).toBeVisible();

  await page.getByRole("button", { name: "Advanced search" }).click();
  await expect(page).toHaveURL(/#\/\?advanced=1$/);
  await page.keyboard.press("Control+Space");
  await expect(page).toHaveURL(/#\/$/);
  await expect(search).toBeFocused();
  await expect(page.getByRole("button", { name: "Advanced search" })).toBeVisible();

  await search.fill(needle);
  await expect(docRows(page)).toHaveCount(1);
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/doc\/[^?]+\?line=\d+$/);
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

test("switching to the editor with the keyboard puts the caret in it, ready to type", async ({
  page,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL as string, "---\ntitle: Focus on switch\n---\n\nbody\n");

  await signIn(page);
  await page.goto(`/#/doc/${id}`);
  await page.getByRole("tab", { name: "Read" }).click();
  await expect(page.locator("article")).toContainText("body");

  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("typed straight away");
  await expect(page.locator(".cm-content")).toContainText("typed straight away");
});

test("opening a document straight into the editor leaves focus alone", async ({ page, request, baseURL }) => {
  const id = await createDocument(request, baseURL as string, "---\ntitle: No focus on open\n---\n\nbody\n");

  await signIn(page);
  await page.goto(`/#/doc/${id}`);
  await page.getByRole("tab", { name: "Edit" }).click();
  await page.goto("/#/");
  await page.goto(`/#/doc/${id}`);
  await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".cm-content")).not.toBeFocused();
});
