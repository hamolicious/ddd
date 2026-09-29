/**
 * The document list and Trash are paged: a page of rows, and the next one loads by
 * itself as the reader scrolls near the end — no button (`doc-list/src/pagination.ts`).
 *
 * The document list is virtual, so its rows in the DOM are only those on screen: what
 * it has loaded is read from the status line, not by counting rows.
 *
 * Named to run last: it adds more than a page of documents, which would push the
 * seeded welcome documents off the first page for every spec after it. It trashes them
 * again at the end, which is also how it gets more than a page into Trash.
 */

import { expect, test } from "@playwright/test";

import { createDocument, docRows, signIn } from "./helpers.js";

const PAGE_SIZE = 50;
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
  const status = page.locator(".doclist-status");
  await expect(status).toContainText(/^Showing 50 of \d+$/);
  const total = Number(/of (\d+)/.exec((await status.textContent()) ?? "")?.[1]);
  expect(total).toBeGreaterThan(PAGE_SIZE);

  // Scrolling near the end loads the next page by itself, and says nothing about it.
  const more = page.locator(".doclist-load-more");
  await expect(more).toHaveText("");
  await more.scrollIntoViewIfNeeded();
  await expect(status).toHaveText(
    2 * PAGE_SIZE >= total ? `${total.toLocaleString()} documents` : `Showing ${2 * PAGE_SIZE} of ${total.toLocaleString()}`,
  );

  // A change to the sort starts again from one page.
  await page.getByRole("button", { name: /^Order:/ }).click();
  await expect(status).toContainText(/^Showing 50 of \d+$/);

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
  await expect(docRows(page)).toHaveCount(PAGE_SIZE);
  await page.locator(".doclist-load-more").scrollIntoViewIfNeeded();
  await expect(docRows(page)).toHaveCount(Math.min(2 * PAGE_SIZE, trashed));
});
