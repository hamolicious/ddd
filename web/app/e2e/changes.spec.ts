/**
 * The altbar (shell-ui) and the `changes` panel in it: toggled from the top bar, only
 * on a document, and a restore puts the text back after asking.
 */

import { expect, request as apiRequest, test } from "@playwright/test";

import { ADMIN, createDocument, openDocument, rawText, signIn } from "./helpers.js";

test("a document's snapshots live in the altbar, and a restore asks first", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const original = "# Snapshot me\n\nThe first text.\n";
  const id = await createDocument(request, baseURL!, original);

  // No altbar, and no toggle, where nothing has a panel for the view.
  await page.goto("/#/");
  const toggle = page.locator(".shell-altbar-toggle");
  await expect(toggle).toHaveCount(0);

  await openDocument(page, id);
  await expect(toggle).toBeVisible();
  const altbar = page.getByRole("complementary", { name: "Side panel" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(altbar).toBeVisible();
  await expect(altbar.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-expanded", "true");

  await altbar.getByRole("button", { name: "Take a snapshot now" }).click();
  await expect(altbar.getByText("Snapshot taken.")).toBeVisible();
  const list = altbar.getByRole("list", { name: "History, newest first" });
  await expect(list.getByText("Taken by hand")).toBeVisible();

  const changed = await request.put(`${baseURL}/api/documents/${id}`, {
    data: { content: "# Snapshot me\n\nOverwritten.\n" },
  });
  expect(changed.ok()).toBe(true);

  // Cancel changes nothing; Restore puts the snapshot's text back.
  const restore = list.getByRole("listitem").filter({ hasText: "Taken by hand" }).first().getByRole("button", { name: /^Restore/ });
  await restore.click();
  const modal = page.getByRole("dialog", { name: /^Restore the snapshot from / });
  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toHaveCount(0);
  expect(await rawText(request, baseURL!, id)).toContain("Overwritten.");

  await restore.click();
  await modal.getByRole("button", { name: "Restore" }).click();
  await expect(altbar.getByText("Restored.")).toBeVisible();
  expect(await rawText(request, baseURL!, id)).toBe(original);
  // The server snapshotted the overwritten text first, so the restore can be undone.
  await expect(list.getByText("Before a restore")).toBeVisible();

  // The toggle closes it, and the choice sticks on this device.
  await toggle.click();
  await expect(altbar).toBeHidden();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("on a phone the altbar is a drawer from the right, one drawer at a time", async ({ page, request, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "# Phone\n\nText.\n");
  await openDocument(page, id);

  const toggle = page.locator(".shell-altbar-toggle");
  const altbar = page.getByRole("complementary", { name: "Side panel" });
  await expect(altbar).toBeHidden();
  await toggle.click();
  await expect(altbar).toBeVisible();
  const box = await altbar.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(391);
  expect(box?.x ?? 0).toBeGreaterThan(0);

  // Opening the sidebar closes the altbar; Escape closes the drawer.
  await page.keyboard.press("Escape");
  await expect(altbar).toBeHidden();
  await toggle.click();
  await expect(altbar).toBeVisible();
  await page.locator(".shell-sidebar-toggle").click({ force: true });
  await expect(altbar).toBeHidden();
  await expect(page.getByRole("complementary", { name: /sidebar/i })).toBeVisible();
});

test("View shows a snapshot read only, detached from the current text", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const original = "# Then\n\n- [ ] a task back then\n";
  const id = await createDocument(request, baseURL!, original);
  await openDocument(page, id);

  const toggle = page.locator(".shell-altbar-toggle");
  const altbar = page.getByRole("complementary", { name: "Side panel" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await altbar.getByRole("button", { name: "Take a snapshot now" }).click();
  await expect(altbar.getByText("Snapshot taken.")).toBeVisible();
  const changed = await request.put(`${baseURL}/api/documents/${id}`, { data: { content: "# Now\n\nDifferent.\n" } });
  expect(changed.ok()).toBe(true);

  const row = altbar.getByRole("listitem").filter({ hasText: "Taken by hand" }).first();
  await row.getByRole("button", { name: /^View the snapshot from / }).click();
  expect(new URL(page.url()).hash).toMatch(new RegExp(`^#/doc/${id}/snapshot/[A-Za-z0-9]+$`));

  const banner = page.getByRole("region", { name: "Snapshot" });
  await expect(banner).toContainText("Read only");
  await expect(page.getByRole("heading", { name: "Then" })).toBeVisible();
  // The altbar stays, and marks the snapshot on screen.
  await expect(row).toHaveAttribute("aria-current", "true");

  // Read only: the old task's checkbox writes nothing.
  const checkbox = page.getByRole("checkbox").first();
  if (await checkbox.isEnabled()) await checkbox.click({ force: true });
  expect(await rawText(request, baseURL!, id)).toBe("# Now\n\nDifferent.\n");

  await banner.getByRole("link", { name: "Current version" }).click();
  expect(new URL(page.url()).hash).toBe(`#/doc/${id}`);

  // Restore from the view puts it back and returns to the current version.
  await row.getByRole("button", { name: /^View the snapshot from / }).click();
  await banner.getByRole("button", { name: "Restore this" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/doc/${id}`);
  expect(await rawText(request, baseURL!, id)).toBe(original);
});

test("a change shows as a diff, reverts, and a conflicting revert says who was in the way", async ({
  page,
  request,
  baseURL,
}) => {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "# Plan\n\nstep one\nstep two\n");
  const put = (content: string) => request.put(`${baseURL}/api/documents/${id}`, { data: { content } });
  expect((await put("# Plan\n\nstep one, done\nstep two\n")).ok()).toBe(true);

  await openDocument(page, id);
  const toggle = page.locator(".shell-altbar-toggle");
  const altbar = page.getByRole("complementary", { name: "Side panel" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const list = altbar.getByRole("list", { name: "History, newest first" });
  const mine = list.getByRole("listitem").filter({ hasText: ", done" }).first();
  await expect(mine).toBeVisible();

  // View: the diff, read only, with the row marked.
  await mine.getByRole("button", { name: /^View the change by / }).click();
  await expect(page.getByRole("region", { name: "Change" })).toContainText("Read only");
  const diff = page.locator(".change-view pre").first();
  await expect(diff.locator("[data-kind=removed]")).toContainText("step one");
  await expect(diff.locator("[data-kind=inserted]")).toContainText("step one, done");
  await expect(mine).toHaveAttribute("aria-current", "true");
  // The whole note as it was right after the change, read only.
  await page.getByRole("tab", { name: "Document then" }).click();
  await expect(page.locator(".change-view article")).toContainText("step one, done");
  await page.getByRole("tab", { name: "Changes" }).click();

  // A second person changes the same line afterwards.
  const invite = await page.evaluate(async () => {
    const response = await fetch("/api/admin/invites", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return ((await response.json()) as { token: string }).token;
  });
  const other = await apiRequest.newContext({ baseURL });
  const email = `changes-${Date.now()}@e2e.test`;
  expect((await other.post("/api/auth/register", { data: { email, password: "other-password-123", invite } })).ok()).toBe(true);
  expect(
    (await other.put(`/api/documents/${id}`, { data: { content: "# Plan\n\nstep one, done twice\nstep two\n" } })).ok(),
  ).toBe(true);
  await altbar.getByRole("button", { name: "Refresh" }).click();

  // Reverting the first change is refused, and says who changed it since.
  await page.getByRole("region", { name: "Change" }).getByRole("button", { name: "Revert this" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revert" }).click();
  await expect(page.getByRole("alert")).toContainText("changed the same text later");
  expect(await rawText(request, baseURL!, id)).toContain("step one, done twice");

  // Reverting the second person's change works, and the revert shows as its own row.
  const theirs = list.getByRole("listitem").filter({ hasText: "twice" }).first();
  await theirs.getByRole("button", { name: /^Revert the change by / }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revert" }).click();
  await expect(altbar.getByText("Reverted.")).toBeVisible();
  expect(await rawText(request, baseURL!, id)).toBe("# Plan\n\nstep one, done\nstep two\n");
  await expect(list.getByText("Reverted an earlier change")).toBeVisible();
  await other.dispose();
});
