/**
 * Admin → Users: row actions are icon buttons, and a reset link is a real link that
 * opens a "set a new password" form on the sign-in screen.
 */

import { expect, test } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

test("a reset link from Admin → Users sets a new password", async ({ page, browser, request, baseURL }) => {
  await signIn(page, ADMIN);

  // A user to reset, registered with an invite.
  const email = `reset-${Date.now()}@e2e.test`;
  const invite = await page.evaluate(async () => {
    const response = await fetch("/api/admin/invites", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return ((await response.json()) as { token: string }).token;
  });
  const registered = await request.post(`${baseURL}/api/auth/register`, {
    data: { email, password: "first-password-123", invite },
  });
  expect(registered.ok()).toBe(true);

  await page.goto("/#/admin/users");
  const reset = page.getByRole("button", { name: `Reset link for ${email}` });
  await expect(reset).toBeVisible();
  await expect(page.getByRole("button", { name: `Delete ${email}` })).toBeVisible();
  await expect(page.getByText("Everyone signed in can read")).toHaveCount(0);

  await reset.click();
  const link = (await page.locator(".admin-secret code").textContent())!.trim();
  expect(link).toMatch(/#\/reset\/[A-Za-z0-9_-]+$/);

  // Someone else's browser, signed out.
  const other = await browser.newContext();
  const visitor = await other.newPage();
  await visitor.goto(link);
  await expect(visitor.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await visitor.getByLabel("New password", { exact: true }).fill("second-password-456");
  await visitor.getByLabel("New password again").fill("second-password-456");
  await visitor.getByRole("button", { name: "Set password" }).click();
  await expect(visitor.getByText("Your password is changed. Sign in with it.")).toBeVisible();
  expect(new URL(visitor.url()).hash).toBe("");

  await visitor.getByLabel("Email").fill(email);
  await visitor.getByLabel("Password").fill("second-password-456");
  await visitor.getByRole("button", { name: "Sign in" }).click();
  await expect(visitor.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  await other.close();
});

test("the users table lines up, and the admin box is labelled on a phone", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/admin/users");
  const row = page.locator(".admin-table tbody tr").first();
  await expect(row).toBeVisible();
  // Every cell in a row starts and ends on the same lines: no cell is taller than its row.
  const heights = await row.evaluate((tr) =>
    [...tr.children].map((cell) => Math.round((cell as HTMLElement).getBoundingClientRect().height)),
  );
  expect(new Set(heights).size, `cell heights ${heights.join(", ")}`).toBe(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".admin-checkbox").first()).toContainText("Administrator");
  await expect(page.locator(".admin-checkbox").first()).toBeVisible();
});
