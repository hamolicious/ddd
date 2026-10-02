import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

export const ADMIN = { email: "admin@e2e.test", password: "e2e-admin-password-1" };
export const SECOND_USER = { email: "second@e2e.test", password: "e2e-second-password-1" };

export async function signIn(
  page: Page,
  credentials: { email: string; password: string } = ADMIN,
  options: { readonly invite?: string; readonly path?: string } = {},
): Promise<void> {
  const loaded = pluginsActivated(page);
  await page.goto(options.path ?? "/");
  const email = page.locator("#email");
  await expect(email).toBeVisible();
  await email.fill(credentials.email);
  await page.locator("#password").fill(credentials.password);

  if (options.invite !== undefined) {
    await page.getByRole("button", { name: /i have an invite/i }).click();
    const invite = page.locator("#invite");
    await expect(invite).toBeVisible();
    await invite.fill(options.invite);
  }

  await page.locator("form.ddd-auth-form button[type=submit]").click();

  await expect(page.locator("main")).toBeVisible();
  await waitSynced(page);
  await loaded;
}

export function pluginsActivated(page: Page): Promise<unknown> {
  return page.waitForEvent("console", {
    predicate: (message) => /\[loader\]\s+\d+ activated/.test(message.text()),
    timeout: 60_000,
  });
}

export async function waitSynced(page: Page): Promise<void> {
  await expect(page.getByRole("status", { name: /everything is saved to the server/i })).toBeVisible(
    { timeout: 30_000 },
  );
}

export async function trashRow(page: Page, row: Locator): Promise<void> {
  await row.getByRole("button", { name: /^Actions for/ }).click();
  const item = page.getByRole("menuitem", { name: /^(Move to Trash|Delete)/ });
  const label = (await item.first().innerText()).trim();
  await item.first().click();
  if (label.startsWith("Delete")) {
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  }
}

export function docRows(page: Page): Locator {
  return page.locator(".search-item");
}

export async function runCommand(page: Page, title: string | RegExp): Promise<void> {
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("combobox", { name: /command/i });
  await expect(palette).toBeVisible();
  await palette.fill(typeof title === "string" ? title : "");
  const option = page.getByRole("option", { name: title });
  await expect(option.first()).toBeVisible();
  await option.first().click();
  await expect(palette).toBeHidden();
}

export function currentDocumentId(page: Page): string | undefined {
  return /#\/doc\/([^?]+)/.exec(page.url())?.[1];
}

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

export async function trashAllDocuments(request: APIRequestContext, baseURL: string): Promise<void> {
  await ensureApiSession(request, baseURL);
  const response = await request.get(`${baseURL}/api/documents?limit=500`);
  expect(response.ok(), `GET /api/documents -> ${response.status()}`).toBe(true);
  const { documents } = (await response.json()) as {
    documents: { id: string; fm: { machine?: unknown } | null }[];
  };
  for (const document of documents) {
    if (document.fm?.machine === true) continue;
    const deleted = await request.delete(`${baseURL}/api/documents/${document.id}`);
    expect(deleted.ok(), `DELETE ${document.id} -> ${deleted.status()}`).toBe(true);
  }
}

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

export async function openDocument(page: Page, id: string): Promise<void> {
  await page.goto(`/#/doc/${id}`);
  await expect(modeSwitch(page)).toBeVisible();
}

export function modeSwitch(page: Page): Locator {
  return page
    .getByRole("tablist", { name: /document mode/i })
    .or(page.locator(".docsurface-mode-bubble"))
    .filter({ visible: true });
}

export async function pluginRegistry(
  request: APIRequestContext,
  baseURL: string,
): Promise<{ plugins: { manifest: { id: string } }[]; problems: unknown[]; disabled?: boolean }> {
  await ensureApiSession(request, baseURL);
  const response = await request.get(`${baseURL}/api/plugins`);
  expect(response.ok(), `GET /api/plugins -> ${response.status()}`).toBe(true);
  return await response.json();
}

export async function showSidebar(page: Page): Promise<void> {
  const toggle = page.locator(".shell-sidebar-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByRole("complementary", { name: /sidebar/i })).toBeVisible();
}
