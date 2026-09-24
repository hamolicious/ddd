/**
 * The one end-to-end smoke of SPEC §8, driven against the demo page:
 * register → create → edit → reload → offline edit → reconnect → converge.
 *
 * It needs a running server (`mise run dev`); with none, it skips rather than
 * fails, because a red suite that means "you forgot to start Mongo" trains people
 * to ignore red suites. In CI the server is up and this is the gate.
 *
 * It drives the page, never the kernel: `window.lm` exists for debugging, and a
 * smoke that reaches for it stops proving that a user can do any of this.
 */

import { expect, test, type Page } from "@playwright/test";

/**
 * One **stable** account, not a fresh random one per run.
 *
 * Registration only works for the *first* user; after that the workspace is
 * invite-only (SPEC §5.1). A per-run random email therefore succeeds exactly once
 * per database and then fails on every later run — as a 15-second timeout waiting
 * for a sync status, which says nothing about the actual cause. With a fixed
 * account, run 1 registers it and every later run logs in.
 *
 * The defaults deliberately match `harness/src/scenario.ts`'s `DEFAULT_CONFIG`: the
 * smoke and the convergence harness are normally pointed at the same dev server,
 * and with different default accounts whichever ran first would claim the
 * first-user slot and lock the other out of the workspace for good. The workspace
 * is shared by design (SPEC §2), so sharing the dev account is the honest default.
 */
const email = process.env["LM_SMOKE_EMAIL"] ?? process.env["LM_EMAIL"] ?? "harness@example.com";
const password =
  process.env["LM_SMOKE_PASSWORD"] ?? process.env["LM_PASSWORD"] ?? "harness-password-1";

/** `needs_first_user` decides register-vs-login; unreachable means skip. */
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

  // Say *why* when the credentials are refused, instead of timing out on the sync
  // status: the overwhelmingly likely cause is a workspace that already has a
  // different first user, which no amount of waiting fixes.
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

  // Create. The id comes from the editor pane, which names the document actually
  // open — *not* from the first row of the list: the workspace is seeded (SPEC
  // §6.5), so at the moment of the click the first row is a welcome document and
  // the new one has not come back through the feed yet. Reading the id there meant
  // every later step addressed the wrong document.
  await page.click("#new");
  const openTitle = page.locator("#open-title");
  await expect(openTitle).toHaveAttribute("data-doc-id", /^[0-9A-Z]{26}$/, { timeout: 15_000 });
  const id = await openTitle.getAttribute("data-doc-id");
  expect(id).toBeTruthy();

  // Edit: the textarea is bound to the hydrated Y.Text. `fill` waits for the
  // field to be editable, which is the demo's signal that the bind has happened —
  // before it, keystrokes would go nowhere and be overwritten by the bind.
  const row = page.locator(`#docs li[data-id="${id}"]`);
  const online = "online edit\n";
  await page.fill("#text", `---\ntitle: Smoke\n---\n\n${online}`);
  // The new title arrives back through the change feed, not from the local edit.
  await expect(row).toContainText("Smoke", { timeout: 15_000 });

  // Reload: the list is served from IndexedDB, before any socket connects — that
  // is the offline-first claim of SPEC §4.1, and it is asserted here with no wait
  // for the socket at all.
  await page.reload();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("Smoke");

  // *Then* open it. The wait for `synced` is not incidental: the list sorts by
  // `-updated_at` and re-renders on every feed batch, so clicking while catch-up
  // is still arriving means clicking at coordinates the list has since moved out
  // from under — which opens whichever document now occupies that pixel. A user
  // clicks a settled list; so does this.
  await expect(page.locator("#status")).toHaveAttribute("data-status", "synced", {
    timeout: 20_000,
  });
  await row.click();
  await expect(page.locator("#open-title")).toHaveAttribute("data-doc-id", id!);
  await expect(page.locator("#text")).toHaveValue(new RegExp(online.trim()));

  // Search runs locally: the index was persisted, not rebuilt.
  await page.fill("#search", "online");
  await expect(row).toBeVisible();
  await page.fill("#search", "");

  // Offline edit: an open document stays editable with the network gone.
  await page.context().setOffline(true);
  await expect(page.locator("#status")).toHaveAttribute("data-status", /offline|error/, {
    timeout: 20_000,
  });
  await page.locator("#text").click();
  await page.locator("#text").press("End");
  await page.locator("#text").pressSequentially("offline edit\n");

  // Querying offline too, not just editing: the filter runs in the Wasm core and
  // the search index is local, so both work with no network at all (SPEC §4.2).
  await page.fill("#search", "online");
  await expect(row).toBeVisible();
  await page.fill("#search", "a-term-no-document-contains");
  await expect(row).toBeHidden();
  await page.fill("#search", "");
  await expect(row).toBeVisible();

  // Reconnect and converge: the server's materialization comes back over the feed.
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
  // Both edits survive: the online one the server already had, and the offline one
  // the CRDT queued and flushed on reconnect (SPEC §4.1).
  await expect(page.locator("#text")).toHaveValue(/online edit/, { timeout: 20_000 });
  await expect(page.locator("#text")).toHaveValue(/offline edit/);
});

/**
 * Live collaboration: two independent browser contexts, one document, one socket
 * each (PROTOCOL.md §3.4 — the server fans an applied update out to every
 * subscriber *except* the originator).
 *
 * Two contexts rather than two tabs: separate cookie jars and separate IndexedDB,
 * so nothing can pass between them except through the server. A test that shared
 * storage could pass on a purely local echo.
 */
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

    // Bob arrives afterwards: the document reaches him through the feed, and its
    // text through the CRDT handshake on subscribe.
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

    // Now the live half: Alice types while Bob is already subscribed.
    const second = `${marker}-second`;
    await alicePage.locator("#text").click();
    await alicePage.locator("#text").press("End");
    await alicePage.locator("#text").pressSequentially(`from alice again ${second}\n`);
    await expect(bobPage.locator("#text")).toHaveValue(new RegExp(second), { timeout: 20_000 });

    // And the other direction, which also proves Bob's socket is a writer and not
    // just a reader.
    const back = `${marker}-bob`;
    await bobPage.locator("#text").click();
    await bobPage.locator("#text").press("End");
    await bobPage.locator("#text").pressSequentially(`from bob ${back}\n`);
    await expect(alicePage.locator("#text")).toHaveValue(new RegExp(back), { timeout: 20_000 });

    // Both edits, on both sides: convergence, not last-writer-wins.
    for (const page of [alicePage, bobPage]) {
      await expect(page.locator("#text")).toHaveValue(new RegExp(second));
      await expect(page.locator("#text")).toHaveValue(new RegExp(back));
    }
  } finally {
    await alice.close();
    await bob.close();
  }
});
