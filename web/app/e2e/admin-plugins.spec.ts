import { expect, test } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

test("plugin rows are compact, with icon actions and details on demand", async ({ page }) => {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
  await signIn(page, ADMIN);
  await page.goto("/#/admin/plugins");

  await expect(page.getByText("If a plugin breaks the app:")).toBeVisible();
  await expect(page.getByText("Choose a package")).toBeVisible();

  const toggle = page.getByRole("button", { name: "Details for Changes" });
  await expect(page.getByRole("button", { name: "Disable Changes" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#admin-plugin-details-changes")).toBeHidden();
  await toggle.click();
  const details = page.locator("#admin-plugin-details-changes");
  await expect(details).toBeVisible();
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

test("disabling and enabling a plugin reloads the page into the new plugin set", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/admin/plugins");

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

test("packages install from every registered source, and a blocked download says why", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/admin/plugins");

  const sources = page.getByRole("tablist", { name: "Where the package comes from" });
  await expect(sources.getByRole("tab", { name: "Upload", selected: true })).toBeVisible();
  await expect(page.getByText("Choose a package")).toBeVisible();

  await sources.getByRole("tab", { name: "GitLab" }).click();
  const form = page.getByRole("form", { name: "Install from GitLab" });
  await form.getByLabel("GitLab address").fill("http://127.0.0.1:9");
  await form.getByLabel("Project ID or path").fill("tools/ddd-plugins");
  await form.getByLabel("Package name").fill("extra-task-states");
  await form.getByLabel("Version").fill("1.2.0");
  await expect(form.getByLabel("File name")).toHaveAttribute("placeholder", "extra-task-states-1.2.0.zip");

  await form.getByRole("button", { name: "Download and install" }).click();
  await expect(form.getByRole("alert")).toHaveText(/enter the token/);

  await form.getByLabel("Token", { exact: true }).selectOption("none");
  await form.getByRole("button", { name: "Download and install" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "PLUGIN_HTTP_ALLOW_CIDRS" })).toBeVisible();

  await page.getByRole("button", { name: "Check updates" }).click();
  await expect(page.getByText("No installed plugin came from a source that can check for updates.")).toBeVisible();
});
