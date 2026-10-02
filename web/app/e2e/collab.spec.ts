import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

import { ADMIN, createDocument, currentDocumentId, openDocument, rawText, signIn, waitSynced } from "./helpers.js";
import { network, typeAfter, typeAtEnd, workerInControl } from "./network.js";

test.use({ serviceWorkers: "allow" });
test.setTimeout(150_000);

const COLLABORATOR = { email: "collab@e2e.test", password: "e2e-collab-password-1" };

test.beforeAll(async ({ playwright, baseURL }) => {
  const visitor = await playwright.request.newContext({ baseURL });
  try {
    if ((await visitor.post("/api/auth/login", { data: COLLABORATOR })).ok()) return;
    const admin = await playwright.request.newContext({ baseURL });
    const bootstrap = (await (await admin.get("/api/auth/bootstrap")).json()) as { needs_first_user?: boolean };
    const signedIn = await admin.post(bootstrap.needs_first_user ? "/api/auth/register" : "/api/auth/login", {
      data: ADMIN,
    });
    expect(signedIn.ok(), await signedIn.text()).toBe(true);
    const invite = await admin.post("/api/admin/invites", { data: { email: COLLABORATOR.email } });
    expect(invite.ok(), await invite.text()).toBe(true);
    const { token } = (await invite.json()) as { token: string };
    const registered = await visitor.post("/api/auth/register", { data: { ...COLLABORATOR, invite: token } });
    expect(registered.ok(), await registered.text()).toBe(true);
    await admin.dispose();
  } finally {
    await visitor.dispose();
  }
});

interface Person {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly net: Awaited<ReturnType<typeof network>>;
}

async function twoPeople(browser: Browser, baseURL: string, id: string) {
  const person = async (credentials: typeof ADMIN): Promise<Person> => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const net = await network(page, context);
    await signIn(page, credentials);
    await openDocument(page, id);
    await page.getByRole("tab", { name: /^Edit/ }).click();
    await expect(page.locator(".cm-content")).toBeVisible();
    return { page, context, net };
  };
  const alice = await person(ADMIN);
  const bob = await person(COLLABORATOR);
  return {
    alice,
    bob,
    close: async () => {
      await alice.context.close();
      await bob.context.close();
    },
  };
}

const editorText = async (page: Page) =>
  (await page.locator(".cm-content").innerText()).replace(/\s+/g, " ").trim();
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

async function allAgree(request: Parameters<typeof rawText>[0], baseURL: string, id: string, pages: Page[]) {
  const server = await rawText(request, baseURL, id);
  for (const page of pages) await expect.poll(() => editorText(page), { timeout: 20_000 }).toBe(flat(server));
  return server;
}

test("what one person types shows up on the other's screen while they type", async ({ browser, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# Live\n\nagenda\n");
  const { alice, bob, close } = await twoPeople(browser, baseURL!, id);
  try {
    await typeAtEnd(alice.page, "\nalice: shall we start?");
    await expect(bob.page.locator(".cm-content")).toContainText("alice: shall we start?");
    await typeAtEnd(bob.page, "\nbob: yes");
    await expect(alice.page.locator(".cm-content")).toContainText("bob: yes");
    await expect.poll(() => rawText(request, baseURL!, id)).toContain("bob: yes");
    await allAgree(request, baseURL!, id, [alice.page, bob.page]);
  } finally {
    await close();
  }
});

test("both type on the same line at the same moment: both sentences, intact", async ({ browser, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# Same line\n\nnotes:\n");
  const { alice, bob, close } = await twoPeople(browser, baseURL!, id);
  try {
    await Promise.all([
      typeAfter(alice.page, "notes:", " alice was here"),
      typeAfter(bob.page, "notes:", " bob was here"),
    ]);
    await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("bob was here");
    const server = await allAgree(request, baseURL!, id, [alice.page, bob.page]);
    expect(server).toContain(" alice was here");
    expect(server).toContain(" bob was here");
    expect(server.split("was here").length).toBe(3);
  } finally {
    await close();
  }
});

test("one goes offline, keeps typing, reloads while still offline, then reconnects", async ({
  browser,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Reload offline\n\nshared\n");
  const { alice, bob, close } = await twoPeople(browser, baseURL!, id);
  try {
    await workerInControl(bob.page);
    await bob.page.getByRole("tab", { name: /^Edit/ }).click();
    await bob.net.offline();
    await typeAtEnd(bob.page, "\nbob before the reload");
    await bob.page.waitForTimeout(1_000);
    await bob.page.reload();
    await bob.page.getByRole("tab", { name: /^Edit/ }).click();
    await expect(bob.page.locator(".cm-content")).toContainText("bob before the reload", { timeout: 20_000 });
    await typeAtEnd(bob.page, "\nbob after the reload");
    await typeAtEnd(alice.page, "\nalice meanwhile");
    await expect.poll(() => rawText(request, baseURL!, id)).toContain("alice meanwhile");

    await bob.net.online();
    await expect.poll(() => rawText(request, baseURL!, id), { timeout: 30_000 }).toContain("bob after the reload");
    const server = await allAgree(request, baseURL!, id, [alice.page, bob.page]);
    for (const line of ["bob before the reload", "bob after the reload", "alice meanwhile"]) {
      expect(server.split(line).length, line).toBe(2);
    }
  } finally {
    await close();
  }
});

test("both offline, both edit, one comes back before the other", async ({ browser, request, baseURL }) => {
  const id = await createDocument(request, baseURL!, "# Staggered\n\ntop\n\nbottom\n");
  const { alice, bob, close } = await twoPeople(browser, baseURL!, id);
  try {
    await alice.net.offline();
    await bob.net.offline();
    await typeAfter(alice.page, "top", " (alice)");
    await typeAfter(bob.page, "bottom", " (bob)");
    await typeAfter(bob.page, "top", " (bob too)");
    await alice.net.online();
    await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("(alice)");
    await typeAtEnd(alice.page, "\nalice, back online");
    await bob.net.online();
    await expect.poll(() => rawText(request, baseURL!, id), { timeout: 20_000 }).toContain("(bob)");
    const server = await allAgree(request, baseURL!, id, [alice.page, bob.page]);
    expect(server).toMatch(/top( \(alice\) \(bob too\)| \(bob too\) \(alice\))/);
    expect(server).toContain("bottom (bob)");
    expect(server).toContain("alice, back online");
  } finally {
    await close();
  }
});

test("a connection that keeps dropping while someone types: every word arrives, once", async ({
  browser,
  request,
  baseURL,
}) => {
  const id = await createDocument(request, baseURL!, "# Flaky\n\n");
  const { alice, bob, close } = await twoPeople(browser, baseURL!, id);
  const live = new Set<WebSocketRoute>();
  await alice.page.routeWebSocket(/\/api\/sync/, (ws) => {
    live.add(ws);
    ws.connectToServer();
  });
  try {
    await alice.page.reload();
    await waitSynced(alice.page);
    const words: string[] = [];
    for (let n = 0; n < 8; n += 1) {
      const word = ` word${n}`;
      words.push(word);
      await typeAtEnd(alice.page, word);
      for (const ws of live) await ws.close({ code: 1006 }).catch(() => undefined);
      live.clear();
      await alice.page.waitForTimeout(300);
    }
    await waitSynced(alice.page);
    const server = await allAgree(request, baseURL!, id, [alice.page, bob.page]);
    for (const word of words) expect(server.split(word).length, word).toBe(2);
  } finally {
    await close();
  }
});

test("a note one person makes offline, the other edits once it arrives", async ({ browser, request, baseURL }) => {
  const seed = await createDocument(request, baseURL!, "# Seed\n");
  const { alice, bob, close } = await twoPeople(browser, baseURL!, seed);
  try {
    await alice.net.offline();
    await alice.page.keyboard.press("ControlOrMeta+p");
    await alice.page.getByRole("combobox", { name: /command/i }).fill("New document");
    await alice.page.keyboard.press("Enter");
    await expect.poll(() => currentDocumentId(alice.page), { timeout: 20_000 }).not.toBe(seed);
    const id = currentDocumentId(alice.page);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await alice.page.getByRole("tab", { name: /^Edit/ }).click();
    await alice.page.locator(".cm-content").click();
    await alice.page.keyboard.press("ControlOrMeta+a");
    await alice.page.keyboard.type("# Offline idea\n\nalice's draft\n");
    await alice.net.online();
    await expect.poll(() => rawText(request, baseURL!, id!), { timeout: 30_000 }).toContain("alice's draft");

    await openDocument(bob.page, id!);
    await bob.page.getByRole("tab", { name: /^Edit/ }).click();
    await typeAtEnd(bob.page, "\nbob's comment");
    await typeAtEnd(alice.page, "\nalice's follow-up");
    await expect.poll(() => rawText(request, baseURL!, id!), { timeout: 20_000 }).toContain("bob's comment");
    const server = await allAgree(request, baseURL!, id!, [alice.page, bob.page]);
    for (const line of ["alice's draft", "bob's comment", "alice's follow-up"]) {
      expect(server.split(line).length, line).toBe(2);
    }
  } finally {
    await close();
  }
});
