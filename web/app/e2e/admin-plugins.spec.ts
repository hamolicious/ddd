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

test("package sources are set up in a modal, browsed with a filter, and checked for updates", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/admin/plugins");

  await expect(page.getByText("Choose a package")).toBeVisible();
  await page.getByRole("button", { name: "Browse packages" }).click();
  const browser = page.getByRole("dialog", { name: "Browse packages" });
  await expect(browser.getByText("Add a package source with the ⚙ button")).toBeVisible();
  await browser.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Package sources" }).click();
  const sources = page.getByRole("dialog", { name: "Package sources" });
  await expect(sources.getByText("No sources yet.")).toBeVisible();

  const fromLink = sources.getByRole("form", { name: "Add a source from a link" });
  await fromLink.getByLabel("Paste a link to the project").fill("https://nothing.invalid/");
  await fromLink.getByRole("button", { name: "Set up" }).click();
  await expect(sources.getByRole("alert")).toContainText("No source type recognises that link");
  await expect(sources.getByRole("button", { name: "Add a GitLab source" })).toBeVisible();

  await fromLink.getByLabel("Paste a link to the project").fill("https://gitlab.invalid/tools/ddd-plugins/-/packages");
  await fromLink.getByRole("button", { name: "Set up" }).click();
  const setup = sources.getByRole("form", { name: "New GitLab source" });
  await expect(setup.getByLabel("Name")).toHaveValue("ddd-plugins on gitlab.invalid");
  await expect(setup.getByLabel("GitLab address")).toHaveValue("https://gitlab.invalid");
  await expect(setup.getByLabel("Project ID or path")).toHaveValue("tools/ddd-plugins");
  await expect(setup.getByRole("status")).toContainText("could not reach https://gitlab.invalid");

  await setup.getByLabel("Name").fill("Lab");
  await setup.getByLabel("Token", { exact: true }).selectOption("access");
  await setup.getByRole("button", { name: "Test" }).click();
  await expect(setup.getByRole("status")).toHaveText(/enter the token/);
  await setup.getByRole("button", { name: "Save" }).click();
  await expect(setup.getByRole("alert")).toHaveText(/enter the token/);
  await setup.getByLabel("Token", { exact: true }).selectOption("none");
  await setup.getByRole("button", { name: "Save" }).click();

  const saved = sources.getByRole("list", { name: "Your sources" });
  await expect(saved.getByText("Lab", { exact: true })).toBeVisible();
  await sources.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Browse packages" }).click();
  const filter = browser.getByLabel("Source", { exact: true });
  await expect(filter.locator("option")).toHaveText(["All sources", "Lab"]);
  const failure = browser.getByRole("status").filter({ hasText: /^Lab: / });
  await expect(failure).toBeVisible();
  await expect(failure).not.toContainText("no installed plugin provides");
  await browser.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("No installed plugin came from one of your sources.")).toBeVisible();

  await page.getByRole("button", { name: "Package sources" }).click();
  await sources.getByRole("button", { name: "Edit Lab" }).click();
  const edit = sources.getByRole("form", { name: "Edit Lab" });
  await expect(edit.getByLabel("Project ID or path")).toHaveValue("tools/ddd-plugins");
  await edit.getByRole("button", { name: "Delete", exact: true }).click();
  await edit.getByRole("button", { name: "Delete Lab" }).click();
  await expect(sources.getByText("No sources yet.")).toBeVisible();
});
