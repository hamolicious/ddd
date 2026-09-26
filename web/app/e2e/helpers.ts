/**
 * Shared helpers for the M3 journeys.
 *
 * Two rules the suite follows, both deliberate:
 *
 * 1. **Drive the UI, not the kernel.** The app never exposes a kernel handle on
 *    `window`, and a test that reached for one would stop proving that a *user* can do
 *    the thing. The one exception is `rawText`, which reads a document straight from
 *    the REST API — the point there is to check what the client *wrote*, and that has
 *    to be read from outside the client.
 * 2. **Select by role and accessible name.** SPEC §8 makes keyboard operability and
 *    landmarks requirements, so selectors that go through the accessibility tree are
 *    not just less brittle, they are part of what is being tested. There is not one
 *    `data-testid` in the base distribution, and it does not need one.
 */

import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** The first-user account. Fresh database per run, so this always registers. */
export const ADMIN = { email: "admin@e2e.test", password: "e2e-admin-password-1" };
export const SECOND_USER = { email: "second@e2e.test", password: "e2e-second-password-1" };

/**
 * Register (first user) or log in, then wait for the shell and the first sync.
 *
 * The wait is on the sync indicator rather than on a timer: "Synced" is the shell's
 * own statement that the bootstrap finished and the socket is up, which is exactly
 * the precondition every journey below needs.
 */
export async function signIn(
  page: Page,
  credentials: { email: string; password: string } = ADMIN,
  options: { readonly invite?: string; readonly path?: string } = {},
): Promise<void> {
  // Armed before the navigation, because the message it waits for can arrive within a
  // few hundred milliseconds of the first paint.
  const loaded = pluginsActivated(page);
  // `path` exists for the safe-mode specs: `?safe=1` is a query on the *app* URL, and a
  // fresh context has no session, so the flag has to survive the sign-in — which it
  // does, because the gate never navigates.
  await page.goto(options.path ?? "/");
  const email = page.locator("#email");
  await expect(email).toBeVisible();
  await email.fill(credentials.email);
  await page.locator("#password").fill(credentials.password);

  if (options.invite !== undefined) {
    // Registering with an invite is a deliberate second mode of the gate: once the
    // workspace has a first user, the default is sign-in and "I have an invite"
    // switches to registration (SPEC §5.1 — invite-only after the first account).
    await page.getByRole("button", { name: /i have an invite/i }).click();
    const invite = page.locator("#invite");
    await expect(invite).toBeVisible();
    await invite.fill(options.invite);
  }

  // By type, not by name: the gate's label is "Create account" or "Sign in" depending
  // on its mode, and the mode *switch* next to it reads "Back to sign in" — matching on
  // text picks up both and fails as a strict-mode violation rather than as anything
  // informative.
  await page.locator("form.lm-auth-form button[type=submit]").click();

  await expect(page.locator("main")).toBeVisible();
  await waitSynced(page);
  await loaded;
}

/**
 * Resolve once the loader has finished activating the distribution.
 *
 * **The app is interactive before this happens, and that is deliberate.** `AppFrame`
 * renders before `activatePlugins` (see `app/src/main.tsx`), and `shell-ui` takes the
 * mount inside its own `activate()`, so the shell appears while the plugins behind it
 * are still arriving — which is the right trade (one slow plugin must not hold the
 * whole app behind a boot screen) and is why every consumer of a registry point has to
 * be live (SPEC §6.4).
 *
 * For a *test* it is a race: "Synced" is about the socket, not the loader, and a
 * journey that clicks at 900 ms can hit a half-populated registry — which is exactly
 * how the `document.mode` re-render bug was found. So the suite waits for the loader's
 * own completion line rather than guessing with a timeout.
 */
export function pluginsActivated(page: Page): Promise<unknown> {
  return page.waitForEvent("console", {
    predicate: (message) => /\[loader\]\s+\d+ activated/.test(message.text()),
    timeout: 60_000,
  });
}

/** Wait until the shell's sync indicator says everything reached the server. */
export async function waitSynced(page: Page): Promise<void> {
  await expect(page.getByRole("status", { name: /everything is saved to the server/i })).toBeVisible(
    { timeout: 30_000 },
  );
}

/** Move one document-list row to Trash through its ⋯ menu. */
export async function trashRow(page: Page, row: Locator): Promise<void> {
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: /^Move to Trash/ }).click();
}

/** The document list's rows, as the list renders them. */
export function docRows(page: Page): Locator {
  return page.locator(".doclist-item");
}

/** Open the command palette (`Mod+K`) and run the command whose title matches. */
export async function runCommand(page: Page, title: string | RegExp): Promise<void> {
  // The palette is a portal into `document.body` (the single `kernel.ui.mount` belongs
  // to `shell-ui`), so it is not inside `main`.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("combobox", { name: /command/i });
  await expect(palette).toBeVisible();
  await palette.fill(typeof title === "string" ? title : "");
  const option = page.getByRole("option", { name: title });
  await expect(option.first()).toBeVisible();
  await option.first().click();
  await expect(palette).toBeHidden();
}

/** The document id in the address bar, or `undefined` off a document route. */
export function currentDocumentId(page: Page): string | undefined {
  return /#\/doc\/([^?]+)/.exec(page.url())?.[1];
}

/**
 * Give the test's API context a session of its own.
 *
 * Playwright's `request` fixture has a **separate cookie jar from the page**, which is
 * the right default (an API context that silently inherited browser state would hide
 * exactly the auth bugs it should catch) and means every REST helper here has to log
 * in for itself. It is cheap — `GET /api/auth/me` answers in a millisecond — and it
 * makes the helpers order-independent: a test may create its fixture document before
 * it ever opens a page.
 *
 * It registers only when the workspace genuinely has no users, so it never competes
 * with the UI journey that owns the first-user transition.
 */
async function ensureApiSession(
  request: APIRequestContext,
  baseURL: string,
  credentials = ADMIN,
): Promise<void> {
  if ((await request.get(`${baseURL}/api/auth/me`)).ok()) return;

  const bootstrap = await request.get(`${baseURL}/api/auth/bootstrap`);
  const needsFirstUser = bootstrap.ok()
    ? Boolean(((await bootstrap.json()) as { needs_first_user?: boolean }).needs_first_user)
    : false;

  const response = needsFirstUser
    ? await request.post(`${baseURL}/api/auth/register`, { data: credentials })
    : await request.post(`${baseURL}/api/auth/login`, { data: credentials });
  expect(
    response.ok(),
    `API sign-in failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

/**
 * The document's text as the **server** holds it.
 *
 * This is how the suite tells a splice apart from a rewrite: a minimal splice leaves
 * the rest of the frontmatter block byte-for-byte alone — comments, key order, blank
 * lines — and a parse→re-serialize→replace round trip silently loses all three
 * (SPEC §3.3). Only the stored text can answer that, so it is read over REST.
 */
export async function rawText(
  request: APIRequestContext,
  baseURL: string,
  id: string,
): Promise<string> {
  await ensureApiSession(request, baseURL);
  const response = await request.get(`${baseURL}/api/documents/${id}`);
  expect(response.ok(), `GET /api/documents/${id} -> ${response.status()}`).toBe(true);
  const body = (await response.json()) as { content: string };
  return body.content;
}

/** Create a document over REST with exact text — the fixture for splice assertions. */
export async function createDocument(
  request: APIRequestContext,
  baseURL: string,
  text: string,
): Promise<string> {
  await ensureApiSession(request, baseURL);
  const response = await request.post(`${baseURL}/api/documents`, { data: { content: text } });
  expect(response.ok(), `POST /api/documents -> ${response.status()}`).toBe(true);
  const body = (await response.json()) as { id?: string; _id?: string };
  const id = body.id ?? body._id;
  expect(id, "created document has an id").toBeTruthy();
  return id as string;
}

/**
 * Open a document by id and wait for the surface's mode switch — the header tabs on a
 * wide screen, the floating button on a phone.
 */
export async function openDocument(page: Page, id: string): Promise<void> {
  await page.goto(`/#/doc/${id}`);
  await expect(modeSwitch(page)).toBeVisible();
}

/** The document surface's mode switch, whichever form this viewport shows. */
export function modeSwitch(page: Page): Locator {
  // Both are in the page at every width; only one is shown.
  return page
    .getByRole("tablist", { name: /document mode/i })
    .or(page.locator(".docsurface-mode-bubble"))
    .filter({ visible: true });
}

/** The installed plugin registry as `/api/plugins` reports it, with a session. */
export async function pluginRegistry(
  request: APIRequestContext,
  baseURL: string,
): Promise<{ plugins: { manifest: { id: string } }[]; problems: unknown[]; disabled?: boolean }> {
  await ensureApiSession(request, baseURL);
  const response = await request.get(`${baseURL}/api/plugins`);
  expect(response.ok(), `GET /api/plugins -> ${response.status()}`).toBe(true);
  return await response.json();
}

/** Show the sidebar if it is collapsed (the state is per-device localStorage). */
export async function showSidebar(page: Page): Promise<void> {
  const toggle = page.locator(".shell-sidebar-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByRole("complementary", { name: /sidebar/i })).toBeVisible();
}
