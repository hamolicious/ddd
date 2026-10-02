import { expect, test, type Page } from "@playwright/test";

const email = process.env["DDD_SMOKE_EMAIL"] ?? process.env["DDD_EMAIL"] ?? "harness@example.com";
const password =
  process.env["DDD_SMOKE_PASSWORD"] ?? process.env["DDD_PASSWORD"] ?? "harness-password-1";

let needsFirstUser: boolean | undefined;

test.beforeEach(async ({ request, baseURL }) => {
  const state = await request
    .get(`${baseURL}/api/auth/bootstrap`)
    .then(async (response) => (response.ok() ? await response.json() : undefined))
    .catch(() => undefined);
  test.skip(state === undefined, "no server on /api — run `mise run dev`");
  needsFirstUser = Boolean(state?.needs_first_user);
});

async function signIn(page: Page): Promise<void> {
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click(needsFirstUser ? "#register" : "#sign-in");

  const notice = page.locator("#notice");
  await expect
    .poll(
      async () =>
        (await notice.isVisible().catch(() => false))
          ? `refused: ${(await notice.textContent()) ?? ""}`
          : ((await page.locator("#status").getAttribute("data-status")) ?? ""),
      { timeout: 15_000 },
    )
    .toMatch(/^(synced|syncing)$/);
}

test("register, create, edit, reload, edit offline, reconnect, converge", async ({ page }) => {
  await page.goto("/");
  await signIn(page);

  await page.click("#new");
  const openTitle = page.locator("#open-title");
  await expect(openTitle).toHaveAttribute("data-doc-id", /^[0-9A-Z]{26}$/, { timeout: 15_000 });
  const id = await openTitle.getAttribute("data-doc-id");
  expect(id).toBeTruthy();

  const row = page.locator(`#docs li[data-id="${id}"]`);
  const online = "online edit\n";
  await page.fill("#text", `---\ntitle: Smoke\n---\n\n${online}`);
  await expect(row).toContainText("Smoke", { timeout: 15_000 });

  await page.reload();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("Smoke");

  await expect(page.locator("#status")).toHaveAttribute("data-status", "synced", {
    timeout: 20_000,
  });
  await row.click();
  await expect(page.locator("#open-title")).toHaveAttribute("data-doc-id", id!);
  await expect(page.locator("#text")).toHaveValue(new RegExp(online.trim()));

  await page.fill("#search", "online");
  await expect(row).toBeVisible();
  await page.fill("#search", "");

  await page.context().setOffline(true);
  await expect(page.locator("#status")).toHaveAttribute("data-status", /offline|error/, {
    timeout: 20_000,
  });
  await page.locator("#text").click();
  await page.locator("#text").press("End");
  await page.locator("#text").pressSequentially("offline edit\n");

  await page.fill("#search", "online");
  await expect(row).toBeVisible();
  await page.fill("#search", "a-term-no-document-contains");
  await expect(row).toBeHidden();
  await page.fill("#search", "");
  await expect(row).toBeVisible();

  await page.context().setOffline(false);
  await expect(page.locator("#status")).toHaveAttribute("data-status", /synced|syncing/, {
    timeout: 30_000,
  });
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("data-status", "synced", {
    timeout: 20_000,
  });
  await row.click();
  await expect(page.locator("#open-title")).toHaveAttribute("data-doc-id", id!);
  await expect(page.locator("#text")).toHaveValue(/online edit/, { timeout: 20_000 });
  await expect(page.locator("#text")).toHaveValue(/offline edit/);
});

test("a second browser sees an edit live", async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  try {
    const alicePage = await alice.newPage();
    await alicePage.goto("/");
    await signIn(alicePage);

    await alicePage.click("#new");
    const aliceTitle = alicePage.locator("#open-title");
    await expect(aliceTitle).toHaveAttribute("data-doc-id", /^[0-9A-Z]{26}$/, {
      timeout: 15_000,
    });
    const id = await aliceTitle.getAttribute("data-doc-id");
    const marker = `live-${Date.now()}`;
    await alicePage.fill("#text", `---\ntitle: Collab\n---\n\nfrom alice ${marker}\n`);

    const bobPage = await bob.newPage();
    await bobPage.goto("/");
    await signIn(bobPage);
    const bobRow = bobPage.locator(`#docs li[data-id="${id}"]`);
    await expect(bobRow).toBeVisible({ timeout: 20_000 });
    await expect(bobPage.locator("#status")).toHaveAttribute("data-status", "synced", {
      timeout: 20_000,
    });
    await bobRow.click();
    await expect(bobPage.locator("#open-title")).toHaveAttribute("data-doc-id", id!);
    await expect(bobPage.locator("#text")).toHaveValue(new RegExp(marker), { timeout: 20_000 });

    const second = `${marker}-second`;
    await alicePage.locator("#text").click();
    await alicePage.locator("#text").press("End");
    await alicePage.locator("#text").pressSequentially(`from alice again ${second}\n`);
    await expect(bobPage.locator("#text")).toHaveValue(new RegExp(second), { timeout: 20_000 });

    const back = `${marker}-bob`;
    await bobPage.locator("#text").click();
    await bobPage.locator("#text").press("End");
    await bobPage.locator("#text").pressSequentially(`from bob ${back}\n`);
    await expect(alicePage.locator("#text")).toHaveValue(new RegExp(back), { timeout: 20_000 });

    for (const page of [alicePage, bobPage]) {
      await expect(page.locator("#text")).toHaveValue(new RegExp(second));
      await expect(page.locator("#text")).toHaveValue(new RegExp(back));
    }
  } finally {
    await alice.close();
    await bob.close();
  }
});
