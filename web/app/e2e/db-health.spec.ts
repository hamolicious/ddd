/**
 * Settings → Database health → Orphan files: icon actions, and each file opens on the
 * viewer's file page (`#/file/<id>`) without being put in any document.
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

  await page.goto("/#/settings/db-health");
  await page.getByRole("button", { name: "Run the scan now" }).click();
  const link = page.getByRole("link", { name });
  await expect(link).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh orphan files" })).toBeVisible();

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

test("duplicate notes list each copy with its links, and one goes to the Trash", async ({ page }) => {
  await signIn(page, ADMIN);
  const title = `Twin ${Date.now()}`;
  const ids = await page.evaluate(async (heading) => {
    const create = async (content: string): Promise<string> => {
      const response = await fetch("/api/documents", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      return ((await response.json()) as { id: string }).id;
    };
    const text = `# ${heading}\n\nThe same text.\n`;
    const older = await create(text);
    const newer = await create(text);
    await create(`# Links to the twin\n\n[twin](doc://${newer})\n`);
    return { older, newer };
  }, title);

  await page.goto("/#/settings/db-health");
  const rows = page.getByRole("row").filter({ hasText: title });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: ids.newer })).toContainText("1 note");
  await expect(rows.filter({ hasText: ids.older })).toContainText("Nothing");

  await page.getByRole("button", { name: `Move this copy of ${title} to the Trash` }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  await expect(rows).toHaveCount(0);
});
