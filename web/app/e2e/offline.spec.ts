/**
 * Offline editing, end to end: the promise of SPEC §4.1 and `dev-docs/resolved/HISTORY.md`, checked
 * the way a person would meet it.
 *
 * "Offline" here is both halves of the wire: `context.setOffline` stops HTTP, and the
 * sync socket is cut and refused by `routeWebSocket` (`setOffline` alone leaves an open
 * WebSocket connected). `network.online()` lets both back and nudges a reconnect.
 *
 * What each test asserts is the user's outcome: the text on the server, the text on
 * every device, the history's times, and what the screen said in between.
 */

import { expect, test, type Page } from "@playwright/test";

import { ADMIN, createDocument, openDocument, rawText, signIn, waitSynced } from "./helpers.js";
import { network, typeAfter, typeAtEnd, workerInControl } from "./network.js";

// Offline boot is the service worker's job, and the suite blocks workers by default
// (`playwright.app.config.ts`, to keep plugin builds fresh between tests).
test.use({ serviceWorkers: "allow" });
test.setTimeout(150_000);

async function changes(page: Page, id: string) {
  return page.evaluate(async (doc) => {
    const response = await fetch(`/api/documents/${doc}/changes`, { credentials: "include" });
    return (await response.json()) as {
      groups: { started_at: string; ended_at: string; offline: boolean; inserted_excerpt: string }[];
    };
  }, id);
}

const unsynced = (page: Page) => page.locator("[title$='unsynced']");

test("an edit made offline reaches the server on reconnect, with the time it was made", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Field notes\n\nfirst line\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);

  await net.offline();
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  const madeAt = Date.now();
  await typeAtEnd(page, "written with no signal");
  await expect(unsynced(page)).toBeVisible();
  // The edit stays on this device while the wire is down.
  await page.waitForTimeout(4_000);
  expect(await rawText(request, baseURL!, id)).not.toContain("written with no signal");

  await net.online();
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("written with no signal");
  await expect(unsynced(page)).toHaveCount(0);

  // History says it was made offline, when it was made, not when it arrived.
  const history = await changes(page, id);
  const offline = history.groups.find((group) => group.inserted_excerpt.includes("no signal"));
  expect(offline?.offline).toBe(true);
  expect(Math.abs(Date.parse(offline!.started_at) - madeAt)).toBeLessThan(3_000);
});

test("an offline edit survives closing the tab: it syncs from the next visit, times intact", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Packing\n\ntent\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await workerInControl(page);
  await openDocument(page, id);

  await net.offline();
  const madeAt = Date.now();
  await typeAtEnd(page, "\nstove");
  // Past the local save's debounce.
  await page.waitForTimeout(1_500);

  // A new visit, still offline: the app starts from the device and the edit is there.
  await page.reload();
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  await page.goto(`/#/doc/${id}`);
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toContainText("stove");
  await page.waitForTimeout(3_000);

  await net.online();
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("stove");
  const history = await changes(page, id);
  const offline = history.groups.find((group) => group.inserted_excerpt.includes("stove"));
  expect(offline?.offline).toBe(true);
  expect(Math.abs(Date.parse(offline!.started_at) - madeAt)).toBeLessThan(3_000);
});

test("two devices edit the same note offline: both edits survive, everywhere", async ({
  browser,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Plan\n\nmorning\n\nevening\n");
  const a = await browser.newContext({ baseURL });
  const b = await browser.newContext({ baseURL });
  try {
    const pageA = await a.newPage();
    const pageB = await b.newPage();
    const netA = await network(pageA, a);
    const netB = await network(pageB, b);
    await signIn(pageA, ADMIN);
    await signIn(pageB, ADMIN);
    await openDocument(pageA, id);
    await openDocument(pageB, id);
    // Both devices need the note on them to edit it offline.
    await pageA.getByRole("tab", { name: /^Edit/ }).click();
    await pageB.getByRole("tab", { name: /^Edit/ }).click();
    await expect(pageA.locator(".cm-content")).toContainText("evening");
    await expect(pageB.locator(".cm-content")).toContainText("evening");

    await netA.offline();
    await netB.offline();
    await typeAfter(pageA, "morning", ": run");
    await typeAfter(pageB, "evening", ": read");
    // And one line both of them changed, at the same place.
    await typeAfter(pageA, "Plan", " A");
    await typeAfter(pageB, "Plan", " B");
    await pageA.waitForTimeout(1_000);

    await netA.online();
    await netB.online();

    await expect
      .poll(() => rawText(request, baseURL!, id), { timeout: 20_000 })
      .toMatch(/morning: run[\s\S]*evening: read/);
    const server = await rawText(request, baseURL!, id);
    expect(server).toMatch(/# Plan( A B| B A)/);
    // Every device ends up with exactly the server's text.
    await expect(pageA.locator(".cm-content")).toContainText("evening: read", { timeout: 20_000 });
    await expect(pageB.locator(".cm-content")).toContainText("morning: run", { timeout: 20_000 });
    const text = async (page: Page) => (await page.locator(".cm-content").innerText()).replace(/\s+/g, " ").trim();
    const flat = server.replace(/\s+/g, " ").trim();
    await expect.poll(() => text(pageA)).toBe(flat);
    await expect.poll(() => text(pageB)).toBe(flat);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a device that was offline catches up on edits made meanwhile, and sends its own", async ({
  browser,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Shared\n\nline one\n");
  const a = await browser.newContext({ baseURL });
  const b = await browser.newContext({ baseURL });
  try {
    const pageA = await a.newPage();
    const pageB = await b.newPage();
    const netA = await network(pageA, a);
    await signIn(pageA, ADMIN);
    await signIn(pageB, ADMIN);
    await openDocument(pageA, id);
    await openDocument(pageB, id);
    await pageA.getByRole("tab", { name: /^Edit/ }).click();
    await expect(pageA.locator(".cm-content")).toContainText("line one");

    await netA.offline();
    await typeAtEnd(pageA, "\nfrom the offline device");
    await typeAtEnd(pageB, "\nfrom the online device");
    await expect.poll(() => rawText(request, baseURL!, id)).toContain("from the online device");

    await netA.online();
    await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("from the offline device");
    await expect(pageA.locator(".cm-content")).toContainText("from the online device", { timeout: 20_000 });
    await expect(pageB.locator(".cm-content")).toContainText("from the offline device", { timeout: 20_000 });
  } finally {
    await a.close();
    await b.close();
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("two tabs of one browser, both editing offline: neither tab's edit is lost", async ({
  context,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Two tabs\n\nbase\n");
  const one = await context.newPage();
  const netOne = await network(one, context);
  await signIn(one, ADMIN);
  await openDocument(one, id);
  await one.getByRole("tab", { name: /^Edit/ }).click();
  await expect(one.locator(".cm-content")).toContainText("base");
  const two = await context.newPage();
  const netTwo = await network(two, context);
  await two.goto("/");
  await waitSynced(two);
  await openDocument(two, id);
  await two.getByRole("tab", { name: /^Edit/ }).click();
  await expect(two.locator(".cm-content")).toContainText("base");

  await netOne.offline();
  await netTwo.offline().catch(() => undefined);
  await typeAtEnd(one, "\nfrom tab one");
  await one.waitForTimeout(1_500);
  await typeAtEnd(two, "\nfrom tab two");
  await two.waitForTimeout(1_500);
  // Tab one is closed while still offline: its edit only exists on this device now.
  await one.close();

  await netTwo.online();
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("from tab two");
  // Reopening the note on this device must not have dropped tab one's edit.
  const three = await context.newPage();
  await three.goto(`/#/doc/${id}`);
  await waitSynced(three);
  await three.getByRole("tab", { name: /^Edit/ }).click();
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("from tab one");
});

test("a note trashed elsewhere while this device edits it offline: kept there, said so, restorable", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Doomed\n\nkeep me\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toContainText("keep me");

  await net.offline();
  await typeAtEnd(page, "\nwritten after it was trashed");
  await page.waitForTimeout(1_000);
  const trashed = await request.delete(`${baseURL}/api/documents/${id}`);
  expect(trashed.ok()).toBe(true);

  await net.online();
  // The edit is kept, in Trash…
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("written after it was trashed");
  // …and the person is told, with a way back.
  const bell = page.getByRole("button", { name: /notice/i }).first();
  const panel = page.getByRole("group", { name: "Notices" });
  await expect(async () => {
    if (!(await panel.isVisible())) await bell.click();
    await expect(panel.getByText("“Doomed” was moved to Trash while you were offline. Your changes are kept there.")).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await panel.getByRole("button", { name: "Restore" }).click();
  await expect
    .poll(async () => ((await (await request.get(`${baseURL}/api/documents/${id}`)).json()) as { deleted: boolean }).deleted, {
      timeout: 20_000,
    })
    .toBe(false);
});

test("an offline edit that pushes a note over the size limit", async ({ page, context, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# Big\n\nsmall start\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toContainText("small start");

  await net.offline();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  // ~1.1 MB: over MAX_DOCUMENT_BYTES (1 MB).
  await page.keyboard.insertText("x".repeat(1_100_000));
  await page.waitForTimeout(1_500);
  await net.online().catch(() => undefined);
  await page.waitForTimeout(3_000);

  const server = await rawText(request, baseURL!, id);
  const alerts = await page.getByRole("alert").allTextContents();
  const status = await page.locator("[role=status][aria-live=polite]").first().getAttribute("title").catch(() => null);
  const notice = await page.getByRole("button", { name: /notice/i }).first().getAttribute("aria-label").catch(() => null);
  console.log(`[too-large] server bytes=${server.length} alerts=${JSON.stringify(alerts)} status=${status} notice=${notice}`);
  // The server must not have taken it (the limit holds)...
  expect(server.length).toBeLessThan(1_000_000);
  // ...the person is told, and the status does not claim it is saved...
  const bell = page.getByRole("button", { name: /notice/i }).first();
  if ((await bell.getAttribute("aria-expanded")) !== "true") await bell.click();
  await expect(page.getByText(/over the size limit/)).toBeVisible();
  await expect(page.getByRole("status", { name: /everything is saved to the server/i })).toHaveCount(0);
  await expect(unsynced(page)).toBeVisible();
  // ...and trimming it saves again, and clears the notice.
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("# Big\n\ntrimmed back down\n");
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("trimmed back down");
  await expect(unsynced(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText(/over the size limit/)).toHaveCount(0);
});

test("server-only screens show what they last loaded, marked as possibly out of date", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# History offline\n\ntext\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  // Load them once while online.
  await page.goto("/#/admin/users");
  const admin = page.locator("#shell-main");
  await expect(admin.getByText(ADMIN.email).first()).toBeVisible({ timeout: 20_000 });
  await openDocument(page, id);
  const toggle = page.locator(".shell-altbar-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const altbar = page.getByRole("complementary", { name: "Side panel" });
  await expect(altbar.getByRole("button", { name: "Refresh" })).toBeVisible();
  await net.offline();

  // The Changes panel: asked again offline, it shows the last answer and says so.
  await altbar.getByRole("button", { name: "Refresh" }).click();
  await expect(altbar.getByText(/You are offline\. This is what was loaded/)).toBeVisible({ timeout: 20_000 });
  await expect(altbar.getByRole("alert")).toHaveCount(0);

  // Admin → Users: the list, marked.
  await page.goto("/#/admin/users");
  await expect(admin.getByText(/You are offline\. This is what was loaded/)).toBeVisible({ timeout: 20_000 });
  await expect(admin.getByText(ADMIN.email).first()).toBeVisible();

  // A screen never loaded on this device still says it needs the server.
  await page.goto("/#/admin/audit");
  await expect(admin.getByRole("alert").first()).toBeVisible({ timeout: 20_000 });

  // Back online, the mark goes.
  await net.online();
  await page.goto("/#/admin/users");
  await expect(admin.getByText(ADMIN.email).first()).toBeVisible({ timeout: 20_000 });
  await expect(admin.getByText(/You are offline\. This is what was loaded/)).toHaveCount(0);
});

test("a note made offline: editable at once, in the list, and on the server after reconnect", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await net.offline();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: /command/i }).fill("New document");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /^Edit/ })).toBeVisible({ timeout: 20_000 });
  const id = /#\/doc\/([^?]+)/.exec(page.url())?.[1];
  expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  const title = `Written on the train ${Date.now()}`;
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`# ${title}\n\nno signal here\n`);
  await expect(unsynced(page)).toBeVisible();
  // In the list already, under its title.
  await page.goto("/#/");
  await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible({ timeout: 20_000 });
  // Not on the server yet (asked with the suite's own session, over REST).
  expect((await request.post(`${baseURL}/api/auth/login`, { data: ADMIN })).ok()).toBe(true);
  expect((await request.get(`${baseURL}/api/documents/${id}`)).status()).toBe(404);

  await net.online();
  await expect.poll(() => rawText(request, baseURL!, id!), { timeout: 30_000 }).toContain("no signal here");
  // Once, not twice.
  expect((await rawText(request, baseURL!, id!)).split("no signal here").length).toBe(2);
  await expect(unsynced(page)).toHaveCount(0, { timeout: 20_000 });
});

test("a session that expired while offline: sign in again, and the offline edit still arrives", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Long trip\n\nday one\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);

  await net.offline();
  await typeAtEnd(page, "\nday two, no signal");
  await page.waitForTimeout(1_000);
  // Meanwhile the session ends on the server (signed out elsewhere, or it expired).
  const out = await context.request.post(`${baseURL}/api/auth/logout`);
  expect(out.status()).toBeLessThan(500);

  // Let the wire back: the session is gone, so the app must ask to sign in again.
  await net.release();
  await page.getByRole("button", { name: "Offline. Reconnect" }).click({ timeout: 2_000 }).catch(() => undefined);
  const dialog = page.getByRole("dialog", { name: "Your session expired" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // It knows who was signed in, says nothing local was lost, and asks for the password.
  await expect(dialog.getByLabel("Email")).toHaveValue(ADMIN.email);
  await expect(page.getByText(/local edits have not reached the server/).first()).toBeVisible();
  // Someone who cannot sign in again can still keep what did not sync.
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Save my unsent changes to a file" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^unsent-changes-\d{4}-\d{2}-\d{2}\.md$/);
  const saved = await (await import("node:fs/promises")).readFile((await file.path())!, "utf8");
  expect(saved).toContain("day two, no signal");
  expect(saved).toContain("# Long trip");
  // The note, and the settings document (Edit mode is remembered there, offline too).
  await expect(dialog.getByText(/^Saved \d+ notes? to a file\.$/)).toBeVisible();
  await dialog.getByLabel("Password").fill(ADMIN.password);
  await dialog.getByRole("button", { name: /sign in/i }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 30_000 }).toContain("day two, no signal");
});

test("trash, restore and any note's edits, offline: shown at once, sent on reconnect", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const stamp = Date.now();
  const trashTitle = `Offline chores ${stamp}`;
  const trashId = await createDocument(request, baseURL!, `---\ntitle: ${trashTitle}\n---\n\nto be trashed\n`);
  const editTitle = `Never opened ${stamp}`;
  const editId = await createDocument(request, baseURL!, `---\ntitle: ${editTitle}\n---\n\nnever opened here\n`);
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await expect(page.getByRole("button", { name: trashTitle, exact: true })).toBeVisible();
  // Every note gets an editable copy on the device while online (dev-docs/resolved/SYNC-DECISIONS.md §7).
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open("life-manager");
              open.onsuccess = () => {
                const get = open.result.transaction("docs").objectStore("docs").get(id);
                get.onsuccess = () => resolve(get.result !== undefined);
                get.onerror = () => resolve(false);
              };
              open.onerror = () => resolve(false);
            }),
          editId,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await net.offline();

  // Move to Trash: gone from the list at once.
  // A note the folder tree knows: `folders`' Delete, which asks first.
  await page.getByRole("button", { name: `Actions for ${trashTitle}` }).first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByRole("button", { name: trashTitle, exact: true })).toHaveCount(0);
  await expect(page.locator("#shell-main").getByRole("alert")).toHaveCount(0);

  // A note this device never opened: editable offline, and a new title shows in the list.
  await page.goto(`/#/doc/${editId}`);
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toContainText("never opened here");
  await page.locator(".cm-line", { hasText: `title: ${editTitle}` }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (renamed)");
  await page.goto("/#/");
  await expect(page.getByRole("button", { name: `${editTitle} (renamed)`, exact: true })).toBeVisible({ timeout: 20_000 });

  // The theme still switches.
  await page.goto("/#/settings/themes");
  await page.getByRole("radio", { name: "Dark" }).check();
  await expect(page.getByText("Showing dark")).toBeVisible();

  await net.online();
  await expect
    .poll(async () => ((await (await request.get(`${baseURL}/api/documents/${trashId}`)).json()) as { deleted: boolean }).deleted, {
      timeout: 20_000,
    })
    .toBe(true);
  await expect.poll(() => rawText(request, baseURL!, editId), { timeout: 20_000 }).toContain(`title: ${editTitle} (renamed)`);
  await expect(unsynced(page)).toHaveCount(0, { timeout: 20_000 });
});

test("a file pasted offline waits on the device and goes in on reconnect", async ({ page, context, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# Receipts\n\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toContainText("Receipts");
  await net.offline();

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.locator(".cm-content").evaluate((editor) => {
    const data = new DataTransfer();
    data.items.add(new File(["total: 4.20\n"], "receipt.txt", { type: "text/plain" }));
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".cm-content")).toContainText(/!\[Uploading receipt\.txt…\]\(attachment:\/\/waiting-[0-9a-f]{8}\)/, { timeout: 20_000 });

  await net.online();
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 30_000 }).toMatch(/\[receipt\.txt\]\(attachment:\/\/[0-9A-Z]{26}\)/);
  expect(await rawText(request, baseURL!, id)).not.toContain("Uploading");
});

test("several files pasted offline all wait, and all go in on reconnect", async ({ page, context, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# Scans\n\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toContainText("Scans");
  await net.offline();

  const paste = (names: readonly string[]) =>
    page.locator(".cm-content").evaluate((editor, list) => {
      const data = new DataTransfer();
      for (const name of list) data.items.add(new File([`${name}\n`], name, { type: "text/plain" }));
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, names);

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  // Three in one paste, then one more on its own.
  await paste(["a.txt", "b.txt", "c.txt"]);
  for (const name of ["a", "b", "c"]) {
    await expect(page.locator(".cm-content")).toContainText(new RegExp(`Uploading ${name}\\.txt…\\]\\(attachment://waiting-[0-9a-f]{8}\\)`), { timeout: 20_000 });
  }
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await paste(["d.txt"]);
  await expect(page.locator(".cm-content")).toContainText(/Uploading d\.txt…\]\(attachment:\/\/waiting-[0-9a-f]{8}\)/, { timeout: 20_000 });

  await net.online();
  for (const name of ["a", "b", "c", "d"]) {
    await expect
      .poll(() => rawText(request, baseURL!, id), { timeout: 30_000 })
      .toMatch(new RegExp(`\\[${name}\\.txt\\]\\(attachment://[0-9A-Z]{26}\\)`));
  }
  expect(await rawText(request, baseURL!, id)).not.toContain("Uploading");
});

test("files attached with /attach offline all wait, two picks in a row", async ({ page, context, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# Picks\n\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toContainText("Picks");
  await net.offline();

  const attach = async (names: readonly string[]) => {
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/attach");
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await chooser).setFiles(names.map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from(`${name}\n`) })));
  };

  await attach(["p.txt", "q.txt"]);
  for (const name of ["p", "q"]) {
    await expect(page.locator(".cm-content")).toContainText(new RegExp(`Uploading ${name}\\.txt…`), { timeout: 20_000 });
  }
  await attach(["r.txt"]);
  await expect(page.locator(".cm-content")).toContainText(/Uploading r\.txt…/, { timeout: 20_000 });

  await net.online();
  for (const name of ["p", "q", "r"]) {
    await expect
      .poll(() => rawText(request, baseURL!, id), { timeout: 30_000 })
      .toMatch(new RegExp(`\\[${name}\\.txt\\]\\(attachment://[0-9A-Z]{26}\\)`));
  }
});

test("an image pasted offline is shown from the device while it waits", async ({ page, context, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# Photos\n\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.locator(".cm-content")).toContainText("Photos");
  await net.offline();

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  // A 1×1 PNG.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await page.locator(".cm-content").evaluate((editor, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  await expect(page.locator(".cm-content")).toContainText(/attachment:\/\/waiting-[0-9a-f]{8}/, { timeout: 20_000 });

  // Read mode draws the picture from the device, and says it has not gone up yet.
  await page.getByRole("tab", { name: /^Read/ }).click();
  const read = page.getByRole("tabpanel", { name: "Read" });
  await expect(read.locator("[data-waiting-upload] img")).toHaveAttribute("src", /^blob:/);
  await expect(read).toContainText(/uploads when you are back online/i);
  await expect(read).not.toContainText("Uploading dot.png");

  await net.online();
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 30_000 }).toMatch(/!\[dot\.png\]\(attachment:\/\/[0-9A-Z]{26}\)/);
  await expect(read.locator("[data-waiting-upload]")).toHaveCount(0, { timeout: 20_000 });
  await expect(read.locator("img")).toHaveCount(1);
});
