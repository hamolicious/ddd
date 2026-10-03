import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers.js";

function searchFiles(page: Page): Promise<string[] | null> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      const dir = await root.getDirectoryHandle("ddd-search");
      const names: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
      return names;
    } catch {
      return null;
    }
  });
}

test("the search projection is built into OPFS after sign-in", async ({ page }) => {
  await signIn(page);
  await expect.poll(async () => (await searchFiles(page))?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
});

test.fixme("sign-out deletes the search projection (blocked: sign-out reports every synced document as an unsent edit)", async ({ page }) => {
  await signIn(page);
  await expect.poll(async () => (await searchFiles(page))?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  await page.goto("/#/settings/settings.account");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#email")).toBeVisible({ timeout: 30_000 });

  expect(await searchFiles(page)).toBeNull();
});
