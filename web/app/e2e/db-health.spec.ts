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

test("duplicate notes name what links to each copy, and the unused copy goes in one click", async ({ page }) => {
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
  const group = page.getByRole("rowgroup").filter({ hasText: title });
  await expect(group).toContainText("2 copies");
  // The copy another note links to names that note; the other is unused, so it can go.
  await expect(group.getByRole("row").filter({ hasText: ids.newer })).toContainText("Links to the twin");
  await expect(group.getByRole("row").filter({ hasText: ids.older })).toContainText("Unused, safe to remove");

  await group.getByRole("button", { name: "Remove 1 unused copy" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  // One copy left: no longer a duplicate.
  await expect(group).toHaveCount(0);
});
