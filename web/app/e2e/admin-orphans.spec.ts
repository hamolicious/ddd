/**
 * Admin → Orphan files: icon actions, and each file opens on the viewer's file page
 * (`#/file/<id>`) without being put in any document.
 */

import { expect, test } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

test("an orphan file opens in the viewer, and Delete asks first", async ({ page }) => {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
  await signIn(page, ADMIN);

  // A file no document references.
  const name = `orphan-${Date.now()}.txt`;
  const id = await page.evaluate(async (fileName) => {
    const body = new FormData();
    body.append("file", new File(["left behind on purpose\n"], fileName, { type: "text/plain" }));
    const response = await fetch("/api/attachments", { method: "POST", credentials: "include", body });
    return ((await response.json()) as { attachment: { id: string } }).attachment.id;
  }, name);

  await page.goto("/#/admin/orphans");
  await page.getByRole("button", { name: "Run the scan now" }).click();
  const link = page.getByRole("link", { name });
  await expect(link).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();

  await link.click();
  expect(new URL(page.url()).hash).toBe(`#/file/${id}`);
  await expect(page.getByText("left behind on purpose")).toBeVisible();
  await expect(page.locator("figcaption")).toContainText(name);

  // Looking changed nothing: it is still an orphan.
  await page.goBack();
  const remove = page.getByRole("button", { name: `Delete ${name}` });
  await remove.click();
  const modal = page.getByRole("dialog", { name: `Delete ${name} permanently?` });
  await modal.getByRole("button", { name: "Delete" }).click();
  await expect(link).toHaveCount(0);
});
