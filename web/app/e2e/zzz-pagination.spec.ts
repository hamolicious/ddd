/**
 * The document list and Trash are paged: a page of rows, then "Load N more", which
 * also loads by itself as the reader scrolls near it (`doc-list/src/pagination.ts`).
 *
 * Named to run last: it adds more than a page of documents, which would push the
 * seeded welcome documents off the first page for every spec after it. It trashes them
 * again at the end, which is also how it gets more than a page into Trash.
 */

import { expect, test } from "@playwright/test";

import { createDocument, docRows, signIn } from "./helpers.js";

const PAGE_SIZE = 50;
const PROBES = 60;

test("the list and Trash show a page at a time, and load the rest on demand", async ({
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
  await expect(docRows(page)).toHaveCount(PAGE_SIZE);
  const total = Number(/of (\d+)/.exec((await status.textContent()) ?? "")?.[1]);
  expect(total).toBeGreaterThan(PAGE_SIZE);

  // Scrolling near the end loads the next page by itself; no click.
  const more = page.locator(".doclist-load-more");
  await expect(more).toHaveText(`Load ${Math.min(PAGE_SIZE, total - PAGE_SIZE)} more`);
  await more.scrollIntoViewIfNeeded();
  await expect(docRows(page)).toHaveCount(Math.min(2 * PAGE_SIZE, total));

  // A change to the sort starts again from one page.
  await page.getByRole("button", { name: /^Order:/ }).click();
  await expect(docRows(page)).toHaveCount(PAGE_SIZE);

  // Trash: the same paging, and the button works when pressed rather than scrolled to.
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
  // Dispatched, not clicked: a click scrolls the button into view, which would load
  // the page by itself and leave nothing to prove about the button.
  await page.locator(".doclist-load-more").dispatchEvent("click");
  await expect(docRows(page)).toHaveCount(Math.min(2 * PAGE_SIZE, trashed));
});
