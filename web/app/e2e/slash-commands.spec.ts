/**
 * The `/` menu (`slash-commands`) over the CodeMirror editor's `text.surface`, and
 * `attachments`' `/attach` opening the real file picker.
 */

import { expect, test } from "@playwright/test";

import { ADMIN, createDocument, openDocument, rawText, signIn } from "./helpers.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("/attach opens the file picker and uploads where it was typed", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "# Slash\n\nbefore\n\nafter\n");
  await openDocument(page, id);
  await page.getByRole("tab", { name: "Edit" }).click();

  const menu = page.getByRole("listbox", { name: "Commands" });

  // Inside a word it stays shut.
  await page.locator(".cm-line", { hasText: "before" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" a/b");
  await expect(menu).toHaveCount(0);
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("Backspace");

  // At the start of a word it opens, narrows, and Escape shuts it.
  await page.keyboard.type(" /att");
  await expect(menu.getByRole("option", { name: /Attach file/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.keyboard.type("a");
  await expect(menu).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "pick.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });

  await expect
    .poll(() => rawText(request, baseURL!, id), { timeout: 15_000 })
    .toMatch(/before !\[pick\.png\]\(attachment:\/\/[0-9A-Z]{26}\)\n\nafter/);
  await expect(page.locator(".cm-content")).not.toContainText("/atta");
});
