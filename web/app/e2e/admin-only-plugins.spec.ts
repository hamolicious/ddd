/**
 * Plugins are an administrator's business: a member can neither see the plugin screen nor
 * install, approve or configure anything, by the UI or by calling the API directly.
 */

import { expect, test } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

test("a member cannot view or install plugins", async ({ page, browser }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/admin/invites");
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = (await page.locator(".admin-secret code").textContent())!.trim();
  const token = link.split("#/invite/")[1]!;

  const other = await browser.newContext();
  const member = await other.newPage();
  await signIn(member, { email: `member-${Date.now()}@e2e.test`, password: "member-password-123" }, { invite: token });

  // The API refuses, whatever the UI does.
  const api = member.request;
  expect((await api.get("/api/admin/plugins")).status()).toBe(403);
  const upload = await api.post("/api/admin/plugins", {
    multipart: { package: { name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("PK") } },
  });
  expect(upload.status()).toBe(403);
  expect((await api.post("/api/admin/plugins/folders/enable")).status()).toBe(403);
  expect((await api.get("/api/admin/plugins/folders/config")).status()).toBe(403);

  // The loader's list still works — every user needs it to boot — but names no problems.
  const installed = await api.get("/api/plugins");
  expect(installed.status()).toBe(200);
  expect((await installed.json()).problems).toEqual([]);

  // No way in from the UI, and a direct link says why.
  await expect(member.getByRole("button", { name: "Admin" })).toHaveCount(0);
  await member.goto("/#/settings");
  await expect(member.getByRole("link", { name: "Plugins", exact: true })).toHaveCount(0);
  await member.goto("/#/admin/plugins");
  await expect(member.getByText(/not an administrator/i)).toBeVisible();

  await other.close();
});
