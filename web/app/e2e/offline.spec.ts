/**
 * Offline editing, end to end: the promise of SPEC §4.1 and `docs/HISTORY.md`, checked
 * the way a person would meet it.
 *
 * "Offline" here is both halves of the wire: `context.setOffline` stops HTTP, and the
 * sync socket is cut and refused by `routeWebSocket` (`setOffline` alone leaves an open
 * WebSocket connected). `network.online()` lets both back and nudges a reconnect.
 *
 * What each test asserts is the user's outcome: the text on the server, the text on
 * every device, the history's times, and what the screen said in between.
 */

import { expect, test, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

import { ADMIN, createDocument, openDocument, rawText, signIn, waitSynced } from "./helpers.js";

// Offline boot is the service worker's job, and the suite blocks workers by default
// (`playwright.app.config.ts`, to keep plugin builds fresh between tests).
test.use({ serviceWorkers: "allow" });
test.setTimeout(150_000);

/** Both halves of the wire, cut and restored together. */
async function network(page: Page, context: BrowserContext) {
  let refuse = false;
  const live = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/api\/sync/, (ws) => {
    if (refuse) {
      void ws.close({ code: 1006 }).catch(() => undefined);
      return;
    }
    live.add(ws);
    ws.connectToServer();
  });
  return {
    /** Cut the wire; resolves once the app says so, and returns how long that took. */
    async offline(): Promise<number> {
      refuse = true;
      const cut = Date.now();
      await context.setOffline(true);
      for (const ws of live) await ws.close({ code: 1006 }).catch(() => undefined);
      live.clear();
      await expect(page.getByRole("button", { name: "Offline. Reconnect" })).toBeVisible({ timeout: 60_000 });
      const noticed = Date.now() - cut;
      console.log(`[offline] the app showed offline after ${noticed} ms`);
      return noticed;
    },
    /** Let the wire back without waiting for the app to say it is synced. */
    async release(): Promise<void> {
      refuse = false;
      await context.setOffline(false);
    },
    async online(): Promise<void> {
      refuse = false;
      await context.setOffline(false);
      const reconnect = page.getByRole("button", { name: "Offline. Reconnect" });
      // The app often reconnects on its own first; the button is then gone.
      if (await reconnect.isVisible()) await reconnect.click({ timeout: 2_000 }).catch(() => undefined);
      await waitSynced(page);
    },
  };
}

/** Wait until the service worker controls the page: only then can it start offline. */
async function workerInControl(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload();
    await waitSynced(page);
  }
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

/** Put the caret at the end of the note in Edit mode and type. */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  const edit = page.getByRole("tab", { name: /^Edit/ });
  if ((await edit.getAttribute("aria-selected")) !== "true") await edit.click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

/** Put the caret at the very start of the body line matching `after` and type. */
async function typeAfter(page: Page, after: string, text: string): Promise<void> {
  const edit = page.getByRole("tab", { name: /^Edit/ });
  if ((await edit.getAttribute("aria-selected")) !== "true") await edit.click();
  await page.locator(".cm-line", { hasText: after }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

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

test("a note trashed elsewhere while this device edits it offline", async ({ page, context, request, baseURL }) => {
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
  await page.waitForTimeout(3_000);
  // Record what happens: is the offline edit kept (in Trash), and does the screen say so?
  const server = await request.get(`${baseURL}/api/documents/${id}`);
  const body = (await server.json()) as { content?: string; deleted?: boolean; deleted_at?: string };
  console.log(`[trashed-offline] status=${server.status()} deleted=${JSON.stringify(body.deleted ?? body.deleted_at ?? null)} kept=${body.content?.includes("written after it was trashed")}`);
  const bell = page.getByRole("button", { name: /notice/i }).first();
  if ((await bell.getAttribute("aria-expanded")) !== "true") await bell.click();
  const notices = await page.getByRole("group", { name: "Notices" }).getByRole("listitem").allTextContents();
  console.log(`[trashed-offline] notices: ${JSON.stringify(notices)}`);
  expect(body.content ?? "").toContain("written after it was trashed");
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

test("server-only screens say they need the server instead of spinning", async ({ page, context, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# History offline\n\ntext\n");
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await openDocument(page, id);
  await net.offline();

  // The Changes panel.
  const toggle = page.locator(".shell-altbar-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const altbar = page.getByRole("complementary", { name: "Side panel" });
  // It loaded while online; ask it again now.
  await altbar.getByRole("button", { name: "Refresh" }).click();
  await expect(altbar.getByRole("alert").first()).toBeVisible({ timeout: 20_000 });
  console.log(`[server-only] changes panel: ${JSON.stringify(await altbar.getByRole("alert").allTextContents())}`);

  // Admin → Users.
  await page.goto("/#/admin/users");
  const admin = page.locator("#shell-main");
  await expect(admin.getByRole("alert").first()).toBeVisible({ timeout: 20_000 });
  console.log(`[server-only] admin users: ${JSON.stringify(await admin.getByRole("alert").allTextContents())}`);
  await expect(admin.getByText("Loading users…")).toHaveCount(0);
});

test("creating a note offline: it says so, and Try again works once back online", async ({ page, context }) => {
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await net.offline();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: /command/i }).fill("New document");
  await page.keyboard.press("Enter");
  const bell = page.getByRole("button", { name: /notice/i }).first();
  await expect(bell).toHaveAccessibleName(/notice/, { timeout: 20_000 });
  const panel = page.getByRole("group", { name: "Notices" });
  await expect(async () => {
    if (!(await panel.isVisible())) await bell.click();
    await expect(panel.getByText("Could not create the document")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await net.online();
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(page.getByRole("tab", { name: /^Edit/ }).or(page.locator(".cm-content")).first()).toBeVisible({ timeout: 20_000 });
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
  await dialog.getByLabel("Password").fill(ADMIN.password);
  await dialog.getByRole("button", { name: /sign in/i }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 30_000 }).toContain("day two, no signal");
});

test("things that need the server, tried offline: each one says so, in words", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const title = `Offline chores ${Date.now()}`;
  const id = await createDocument(request, baseURL!, `---\ntitle: ${title}\n---\n\nnever opened here\n`);
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
  await net.offline();

  // Move to Trash: refused, said plainly, and the note stays.
  await page.getByRole("button", { name: `Actions for ${title}` }).first().click();
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(page.locator("#shell-main").getByRole("alert")).toContainText(/offline/i);
  await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();

  // A note this device never opened: readable, not editable, one sentence saying why.
  await page.goto(`/#/doc/${id}`);
  await expect(page.getByText("never opened here").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await expect(page.getByText(/has not been opened on this device before/)).toHaveCount(1);
  await expect(page.getByText(/Opening for editing/)).toHaveCount(0);
  await expect(page.getByText(new RegExp(id))).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveCount(0);

  // The theme still switches.
  await page.goto("/#/settings/themes");
  await page.getByRole("radio", { name: "Dark" }).check();
  await expect(page.getByText("Showing dark")).toBeVisible();

  await net.online();
  // Nothing was trashed behind the person's back.
  expect((await (await request.get(`${baseURL}/api/documents/${id}`)).json()).deleted).toBe(false);
  // Record whether the theme choice made offline survived a reload.
  await page.reload();
  await waitSynced(page);
  await page.goto("/#/settings/themes");
  console.log(`[needs-server] theme after reconnect: ${await page.getByText(/^Showing/).innerText()}`);
});
