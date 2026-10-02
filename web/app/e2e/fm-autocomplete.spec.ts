import { expect, test } from "@playwright/test";

import { ADMIN, createDocument, openDocument, signIn, waitSynced } from "./helpers.js";

test("frontmatter keys, then their values, are suggested while typing", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  await waitSynced(page);
  await createDocument(request, baseURL as string, "---\ntitle: Alpha\nmood: grumpy\n---\n\nbody\n");
  await createDocument(request, baseURL as string, "---\ntitle: Beta\nmood: happy\n---\n\nbody\n");
  await createDocument(request, baseURL as string, "---\ntitle: Gamma\nmood: happy\n---\n\nbody\n");
  const id = await createDocument(request, baseURL as string, "---\ntitle: Fresh\n---\n\nbody\n");

  await openDocument(page, id);
  await page.getByRole("tab", { name: "Edit" }).click();
  const content = page.locator(".cm-content");
  await expect(content).toBeVisible();

  await content.getByText("title: Fresh").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("moo");

  const menu = page.getByRole("listbox", { name: "Suggestions" });
  await expect(menu.getByRole("option").first()).toContainText("mood");
  await expect(page.getByText(/could not be read/i)).toHaveCount(0);
  await page.keyboard.press("Enter");

  await expect(menu.getByRole("option")).toHaveText([/happy/, /grumpy/]);
  await page.keyboard.type("g");
  await expect(menu.getByRole("option")).toHaveText([/grumpy/]);
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(content).toContainText("mood: grumpy");

  await page.keyboard.press("Enter");
  await expect(content).toContainText("mood: grumpy");
  await expect(menu).toHaveCount(0);
});
