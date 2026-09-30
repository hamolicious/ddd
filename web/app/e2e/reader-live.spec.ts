/**
 * Read mode follows the note: an edit made anywhere else — another device, or another
 * mode on this one — shows in a reader already open, without reopening it.
 */

import { expect, test } from "@playwright/test";

import { ADMIN, createDocument, modeSwitch, openDocument, runCommand, signIn } from "./helpers.js";

test("a reader open on one device shows an edit made on another", async ({ browser, request, baseURL }) => {
  const reader = await (await browser.newContext()).newPage();
  const writer = await (await browser.newContext()).newPage();
  // Closed at the end: two more signed-in devices left open would act on what the next
  // tests do (auto-fm adds its properties on every device that sees a note change).
  try {
    await signIn(reader, ADMIN);
    await signIn(writer, ADMIN);
    const id = await createDocument(request, baseURL!, "---\ntitle: Live\n---\n\n# Live\n\nfirst line\n");

    await openDocument(reader, id);
    await reader.getByRole("tab", { name: "Read" }).click();
    await expect(reader.locator("article")).toContainText("first line");

    await openDocument(writer, id);
    await writer.getByRole("tab", { name: "Edit" }).click();
    await writer.locator(".cm-line", { hasText: "first line" }).click();
    await writer.keyboard.press("End");
    await writer.keyboard.type(" and more");

    await expect(reader.locator("article")).toContainText("first line and more");
  } finally {
    await reader.context().close();
    await writer.context().close();
  }
});

test("the reader shows an edit made in edit mode on the same page", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "---\ntitle: Same\n---\n\n# Same\n\nfirst line\n");
  await openDocument(page, id);
  await page.getByRole("tab", { name: "Edit" }).click();
  await page.locator(".cm-line", { hasText: "first line" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await page.getByRole("tab", { name: "Read" }).click();
  await expect(page.locator("article")).toContainText("first line and more");
});

test("a new note's reader shows the properties auto-fm adds", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/settings/auto-fm");
  await page.getByRole("button", { name: "Add property" }).click();
  await page.getByLabel("Property", { exact: true }).last().fill("autostatus");
  await page.getByLabel("Value", { exact: true }).last().fill("fresh");
  // Past the settings write's debounce.
  await page.waitForTimeout(1_000);

  await runCommand(page, "New document");
  await expect(modeSwitch(page)).toBeVisible();
  await page.getByRole("tab", { name: "Read" }).click();
  // In the reader: the sidebar may list a note titled "Fresh" of another spec's.
  const reader = page.getByRole("tabpanel", { name: "Read" });
  await expect(reader.getByText("autostatus")).toBeVisible();
  await expect(reader.getByText("fresh", { exact: true })).toBeVisible();
});
