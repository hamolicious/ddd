import { expect, test } from "@playwright/test";

import { createDocument, signIn } from "./helpers.js";

const TRASH_PAGE = 50;
const LIST_PAGE = 50;
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
  await expect(status).toHaveText(/^\d+ documents$/);
  expect(Number.parseInt((await status.textContent()) ?? "", 10)).toBeGreaterThanOrEqual(PROBES);

  const notes = page.locator(".doclist-note");
  await expect(notes).toHaveCount(LIST_PAGE);
  await expect(async () => {
    await notes.last().scrollIntoViewIfNeeded({ timeout: 2_000 });
    expect(await notes.count()).toBeGreaterThan(LIST_PAGE);
  }).toPass({ timeout: 20_000 });

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
  const rows = page.locator(".doclist-item");
  await expect(rows).toHaveCount(TRASH_PAGE);
  await expect(async () => {
    await rows.last().scrollIntoViewIfNeeded({ timeout: 2_000 });
    await expect(rows).toHaveCount(Math.min(2 * TRASH_PAGE, await trashedNow()), { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
});
