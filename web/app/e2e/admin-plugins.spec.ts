/**
 * Admin → Plugins: the notice is never folded, each plugin is a compact row with icon
 * actions and details on demand, and Uninstall asks in a modal that carries the purge
 * choice. Nothing here disables or removes a plugin: the suite shares one server.
 */

import { expect, test } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

test("plugin rows are compact, with icon actions and details on demand", async ({ page }) => {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
  await signIn(page, ADMIN);
  await page.goto("/#/admin/plugins");

  // The recovery line is on screen without opening anything.
  await expect(page.getByText("If a plugin breaks the app:")).toBeVisible();
  await expect(page.getByText("Choose a package")).toBeVisible();

  const toggle = page.getByRole("button", { name: "Details for Snapshots" });
  await expect(page.getByRole("button", { name: "Disable Snapshots" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#admin-plugin-details-snapshots")).toBeHidden();
  await toggle.click();
  const details = page.locator("#admin-plugin-details-snapshots");
  await expect(details).toBeVisible();
  await expect(details.getByText("Depends on")).toBeVisible();
  await expect(details.getByText("context-menu ^1.0, shell-ui ^1.0")).toBeVisible();

  await page.getByRole("button", { name: "Uninstall Snapshots" }).click();
  const modal = page.getByRole("dialog", { name: "Uninstall Snapshots?" });
  await expect(modal.getByText("?safe=bare")).toBeVisible();
  const purge = modal.getByRole("checkbox", { name: "Also delete its data" });
  await expect(purge).not.toBeChecked();
  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disable Snapshots" })).toBeVisible();
});
