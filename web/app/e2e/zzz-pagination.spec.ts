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
  const status = page.locator(".search-status");
  await expect(status).toHaveText(/^\d+ documents$/);
  expect(Number.parseInt((await status.textContent()) ?? "", 10)).toBeGreaterThanOrEqual(PROBES);

  const box = page.locator(".search-table-box");
  const loaded = (): Promise<number> => box.evaluate((element) => element.scrollHeight);
  const first = await loaded();
  await box.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect.poll(loaded).toBeGreaterThan(first);

  await box.evaluate((element) => element.scrollTo(0, 0));
  await page.getByRole("button", { name: /^Order:/ }).click();
  await expect.poll(loaded).toBeLessThanOrEqual(first);

  for (const id of ids) {
    const response = await request.delete(`${baseURL}/api/documents/${id}`);
    expect(response.ok(), `DELETE ${id} -> ${response.status()}`).toBe(true);
  }
  await page.goto("/#/trash");
  const trashStatus = page.locator(".doclist-status");
  await expect(trashStatus).toContainText(/^Showing 50 of \d+$/);
  const trashedNow = async (): Promise<number> =>
    Number(/of (\d+)/.exec((await trashStatus.textContent()) ?? "")?.[1]);
  await expect.poll(trashedNow).toBeGreaterThanOrEqual(PROBES);
  const trashed = await trashedNow();
  const rows = page.locator(".doclist-item");
  await expect(rows).toHaveCount(TRASH_PAGE);
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(Math.min(2 * TRASH_PAGE, trashed));
});
