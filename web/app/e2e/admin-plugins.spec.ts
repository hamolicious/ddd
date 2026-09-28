/**
 * Admin → Plugins: the notice is never folded, each plugin is a compact row with icon
 * actions and details on demand, and Uninstall asks in a modal that carries the purge
 * choice. The first test removes nothing: the suite shares one server. The second
 * disables the example plugin and puts it back through a wiring rollback, which is the
 * point of that test (PLUGIN-PROTOCOLS §7) and leaves the server as it found it.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

/** The `<section>` the Wiring card renders, found by its heading. */
const wiringCard = (page: Page): Locator => page.getByRole("region", { name: "Wiring", exact: true });

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
  await expect(details.getByText("Consumes")).toBeVisible();
  await expect(details.getByText("lm/context-menu ^1.0, lm/markdown-renderer ^1.0, lm/router ^1.0, lm/shell ^1.0")).toBeVisible();

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
 * Rollback without the graph (PLUGIN-PROTOCOLS §7). Disabling from the list writes a
 * wiring version (unplug is disable, §10); rolling back to the version before it is an
 * ordinary apply that plugs the plugin back in and lands in the history as `rollback`.
 */
test("a disable from the list can be rolled back from the Wiring card", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/admin/plugins");

  // The example plugin: not base, so nothing the shell needs goes away with it.
  const disable = page.getByRole("button", { name: "Disable Extra task states" });
  await expect(disable).toBeVisible();

  const card = wiringCard(page);
  await expect(card.getByText(/^Live version \d+$/)).toBeVisible();

  // Version 0 is the workspace before any change and has no stored record to roll back
  // to, so on a fresh workspace write two versions first: the rollback target must exist.
  const enable = page.getByRole("button", { name: "Enable Extra task states" });
  await disable.click();
  await expect(enable).toBeVisible();
  await enable.click();
  await expect(disable).toBeVisible();
  await expect(card.getByText(/^Live version [1-9]\d*$/)).toBeVisible();
  const before = Number(/\d+/.exec((await card.getByText(/^Live version \d+$/).textContent()) ?? "")?.[0]);
  await expect(card.locator(`tr[data-wiring-version="${before}"]`)).toBeVisible();

  await disable.click();
  await expect(page.getByRole("button", { name: "Enable Extra task states" })).toBeVisible();

  // One version written: the card reloads with the list and says so.
  await expect(card.getByText(`Live version ${before + 1}`)).toBeVisible();
  await expect(card.locator(`tr[data-wiring-version="${before + 1}"]`)).toContainText("live");

  // Roll back to the version before the disable. The confirm names the version.
  await card.getByRole("button", { name: `Roll back to version ${before}` }).click();
  const dialog = page.getByRole("dialog", { name: `Roll back to wiring version ${before}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Roll back" }).click();
  await expect(dialog).toHaveCount(0);

  // The plugin is enabled again, and the history gained a `rollback` entry as the new live.
  await expect(page.getByRole("button", { name: "Disable Extra task states" })).toBeVisible();
  const after = wiringCard(page);
  await expect(after.getByText(`Live version ${before + 2}`)).toBeVisible();
  const newest = after.locator(`tr[data-wiring-version="${before + 2}"]`);
  await expect(newest).toContainText("rollback");
  await expect(newest).toContainText("live");
  // The live row has no Roll back; the two older ones do.
  await expect(newest.getByRole("button", { name: /Roll back/ })).toHaveCount(0);
  await expect(after.getByRole("button", { name: `Roll back to version ${before + 1}` })).toBeVisible();
});
