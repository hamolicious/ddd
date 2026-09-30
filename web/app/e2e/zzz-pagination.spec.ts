/**
 * The document list and Trash are paged: a page of rows, and the next one loads by itself
 * as the reader scrolls near the end — no button (`_shared/pagination.ts`,
 * `_shared/LoadMore.tsx`).
 *
 * The document list is `table`'s results table: a box ten rows tall, scrolling inside
 * itself, whose page size is its height; it is virtual, so what it has loaded is read
 * from the box's scroll height, not by counting rows. Trash is `doc-list`'s own list, fifty
 * at a time, every loaded row in the DOM.
 *
 * Named to run last: it adds more than a page of documents, which would push the
 * seeded welcome documents off the first page for every spec after it. It trashes them
 * again at the end, which is also how it gets more than a page into Trash.
 */

import { expect, test } from "@playwright/test";

import { createDocument, signIn } from "./helpers.js";

const TRASH_PAGE = 50;
const PROBES = 60;

test("the list and Trash show a page at a time, and load the rest as they scroll", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const ids: string[] = [];
  for (let n = 0; n < PROBES; n += 1) {
    ids.push(await createDocument(request, baseURL!, `# Paging probe ${String(n).padStart(3, "0")}\n`));
  }

  await signIn(page);
  // The count under the list is always the real total.
  const status = page.locator(".search-status");
  await expect(status).toHaveText(/^\d+ documents$/);
  expect(Number.parseInt((await status.textContent()) ?? "", 10)).toBeGreaterThanOrEqual(PROBES);

  // Scrolling the box to its end loads the next page by itself, and says nothing about it.
  const box = page.locator(".search-table-box");
  const loaded = (): Promise<number> => box.evaluate((element) => element.scrollHeight);
  const first = await loaded();
  await box.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect.poll(loaded).toBeGreaterThan(first);

  // A change to the sort starts again from one page.
  await box.evaluate((element) => element.scrollTo(0, 0));
  await page.getByRole("button", { name: /^Order:/ }).click();
  await expect.poll(loaded).toBeLessThanOrEqual(first);

  // Trash: the same paging.
  for (const id of ids) {
    const response = await request.delete(`${baseURL}/api/documents/${id}`);
    expect(response.ok(), `DELETE ${id} -> ${response.status()}`).toBe(true);
  }
  await page.goto("/#/trash");
  const trashStatus = page.locator(".doclist-status");
  await expect(trashStatus).toContainText(/^Showing 50 of \d+$/);
  // The tombstones arrive over the sync feed, so the total climbs for a moment.
  const trashedNow = async (): Promise<number> =>
    Number(/of (\d+)/.exec((await trashStatus.textContent()) ?? "")?.[1]);
  await expect.poll(trashedNow).toBeGreaterThanOrEqual(PROBES);
  const trashed = await trashedNow();
  const rows = page.locator(".doclist-item");
  await expect(rows).toHaveCount(TRASH_PAGE);
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(Math.min(2 * TRASH_PAGE, trashed));
});
