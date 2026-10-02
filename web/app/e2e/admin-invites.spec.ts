import { expect, test } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

test("an invite link from Admin → Invites registers a new account", async ({ page, browser }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/admin/invites");
  await page.getByRole("button", { name: "Create invite" }).click();

  const link = (await page.locator(".admin-secret code").textContent())!.trim();
  expect(link).toMatch(/^https?:\/\/.+#\/invite\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(page.getByText("A lost token cannot be recovered")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Revoke invite for / }).first()).toBeVisible();

  const other = await browser.newContext();
  const visitor = await other.newPage();
  await visitor.goto(link);
  await expect(visitor.getByRole("button", { name: "Create account" })).toBeVisible();
  await expect(visitor.locator("#invite")).toHaveValue(link.split("#/invite/")[1]!);
  await visitor.locator("#email").fill(`invited-${Date.now()}@e2e.test`);
  await visitor.locator("#password").fill("invited-password-123");
  await visitor.getByRole("button", { name: "Create account" }).click();
  await expect(visitor.locator("main")).toBeVisible();
  expect(new URL(visitor.url()).hash).not.toContain("invite");
  await other.close();

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".admin-secret")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".admin-status-used").first()).toBeVisible();
});

test("revoking an invite asks first, in a modal", async ({ page }) => {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
  await signIn(page, ADMIN);
  await page.goto("/#/admin/invites");
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.locator(".admin-secret")).toBeVisible();
  const pending = page.locator(".admin-table tbody tr").first();
  await expect(pending.locator(".admin-status-pending")).toBeVisible();
  const revoke = pending.getByRole("button", { name: /^Revoke invite for / });

  await revoke.click();
  const modal = page.getByRole("dialog", { name: /^Revoke the invite for / });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Cancel" })).toBeFocused();
  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toHaveCount(0);
  await expect(revoke).toBeFocused();
  await expect(pending.locator(".admin-status-pending")).toBeVisible();

  await revoke.click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(pending.locator(".admin-status-pending")).toBeVisible();

  await revoke.click();
  await modal.getByRole("button", { name: "Revoke" }).click();
  await expect(modal).toHaveCount(0);
  await expect(pending.locator(".admin-status-revoked")).toBeVisible();
});
