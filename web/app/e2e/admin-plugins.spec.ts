/**
 * Admin → Plugins: the notice is never folded, each plugin is a compact row with icon
 * actions and details on demand, and Uninstall asks in a modal that carries the purge
 * choice. The first test removes nothing: the suite shares one server. The second
 * disables the example plugin and enables it again — each a change to the plugin set, so
 * each reloads the page (`plugins.changed`, `@kernel` 3.0: no hot reload) — and leaves the
 * server as it found it.
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

  const toggle = page.getByRole("button", { name: "Details for Changes" });
  await expect(page.getByRole("button", { name: "Disable Changes" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#admin-plugin-details-changes")).toBeHidden();
  await toggle.click();
  const details = page.locator("#admin-plugin-details-changes");
  await expect(details).toBeVisible();
  // The dependency graph, not ports: what Changes depends on.
  await expect(details.getByText("Depends on")).toBeVisible();
  await expect(details.getByText(/context-menu/)).toBeVisible();

  await page.getByRole("button", { name: "Uninstall Changes" }).click();
  const modal = page.getByRole("dialog", { name: "Uninstall Changes?" });
  await expect(modal.getByText("?safe=bare")).toBeVisible();
  const purge = modal.getByRole("checkbox", { name: "Also delete its data" });
  await expect(purge).not.toBeChecked();
  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disable Changes" })).toBeVisible();
});

/**
 * Disable and enable from the list. Each is a change to the plugin set: the server sends
 * `plugins.changed` and every open page — this one included — reloads, then shows the new
 * state.
 */
test("disabling and enabling a plugin reloads the page into the new plugin set", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/admin/plugins");

  // The example plugin: not base, so nothing the shell needs goes away with it.
  const disable = page.getByRole("button", { name: "Disable Extra task states" });
  const enable = page.getByRole("button", { name: "Enable Extra task states" });
  await expect(disable).toBeVisible();

  let reloaded = page.waitForEvent("load");
  await disable.click();
  await reloaded;
  await expect(enable).toBeVisible({ timeout: 30_000 });

  reloaded = page.waitForEvent("load");
  await enable.click();
  await reloaded;
  await expect(disable).toBeVisible({ timeout: 30_000 });
});
