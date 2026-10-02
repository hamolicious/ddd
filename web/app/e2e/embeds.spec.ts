import { expect, test } from "@playwright/test";

import { ADMIN, createDocument, openDocument, signIn } from "./helpers.js";

async function setDepth(page: import("@playwright/test").Page, depth: number): Promise<void> {
  await page.goto("/#/settings/markdown");
  const input = page.getByLabel("Embedded documents, levels deep");
  await input.fill(String(depth));
  await expect(input).toHaveValue(String(depth));
}

test("embeds nest, stop at the configured depth, and stop in a cycle", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const leaf = await createDocument(request, baseURL!, "# Leaf\n\nthe leaf body\n");
  const middle = await createDocument(request, baseURL!, `# Middle\n\nthe middle body\n\n![](doc://${leaf})\n`);
  const top = await createDocument(request, baseURL!, `# Top\n\nthe top body\n\n![](doc://${middle})\n`);

  await setDepth(page, 4);
  await openDocument(page, top);
  await page.getByRole("tab", { name: "Read" }).click();
  await expect(page.locator(`[data-embed="${middle}"]`)).toContainText("the middle body");
  await expect(page.locator(`[data-embed="${middle}"] [data-embed="${leaf}"]`)).toContainText("the leaf body");

  await setDepth(page, 1);
  await openDocument(page, top);
  await page.getByRole("tab", { name: "Read" }).click();
  await expect(page.locator(`[data-embed="${middle}"]`)).toContainText("the middle body");
  await expect(page.locator(`[data-embed="${leaf}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-embed="${middle}"] a[href="doc://${leaf}"]`)).toBeVisible();

  await setDepth(page, 4);
  const self = await createDocument(request, baseURL!, "# Self\n\nme again\n");
  await openDocument(page, self);
  await page.getByRole("tab", { name: "Edit" }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`\n![](doc://${self})`);
  await page.getByRole("tab", { name: "Read" }).click();
  await expect(page.getByText("me again")).toBeVisible();
  await expect(page.locator(`a[href="doc://${self}"]`)).toBeVisible();
  await expect(page.locator(`[data-embed]`)).toHaveCount(0);
});
