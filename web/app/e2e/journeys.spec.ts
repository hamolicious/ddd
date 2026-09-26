/**
 * The M3 journeys, end to end, against the real app on the real server.
 *
 * These are **journeys, not unit tests**: each one is a thing a person does, and it
 * fails if any layer between the keypress and Mongo is wrong. That is deliberately a
 * different job from the 650 unit tests — those prove the pieces, this proves the
 * assembly, and the assembly is what M3 actually delivered (the loader, the import
 * map, the registries, sixteen plugins that have never run in the same page before).
 *
 * Ordering matters and parallelism is off: they share one workspace and one
 * first-user account, in that order, exactly like a real session (SPEC §5.1 —
 * registration is first-user-only).
 */

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  ADMIN,
  createDocument,
  currentDocumentId,
  docRows,
  openDocument,
  pluginRegistry,
  rawText,
  runCommand,
  showSidebar,
  signIn,
  waitSynced,
} from "./helpers.js";

/**
 * What `plugins/base/dist` holds, plus the one example plugin the suite installs.
 *
 * The 16 of SPEC §6.5's table plus `extra-task-states`. M4's two proof plugins
 * (`calendar`, `agenda`) were removed on 2026-09-24; on 2026-09-26 `header` was split
 * out of `shell-ui`, `notices` and `sync-status` out of `header`, and `properties` was
 * removed. The base distribution and `BASE_PLUGIN_IDS` — what `?safe=1` boots — are the
 * same sixteen. `safe-mode.spec.ts` is what pins that.
 */
const EXPECTED_PLUGINS = 17;

/**
 * `--lm-bg` as the `midnight` theme paints it (`plugins/base/themes/src/index.tsx`).
 * Named rather than read back from the page, so the theme journey can tell "the theme
 * was applied" apart from "the page kept whatever it already had".
 */
const MIDNIGHT_BG = "#0d1117";

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// 1. Boot: register, welcome documents, every plugin active
// ---------------------------------------------------------------------------

test("registering the first user boots the whole plugin distribution", async ({
  page,
  request,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
  page.on("console", (message) => {
    // A plugin that fails to *import* or to *activate* shows up here first; the
    // aggregated notice is the user-visible half of the same fact.
    if (message.type() !== "error") return;
    const text = message.text();
    // The one expected 401: the boot sequence asks `/api/auth/me` before it knows
    // whether there is a session, and the browser logs every 4xx response as a
    // console error. It is the auth gate working, not a failure.
    if (/status of 401/.test(text)) return;
    errors.push(`console: ${text}`);
  });

  await signIn(page);

  // The shell's landmarks and skip link are SPEC §8 requirements, not decoration, and
  // they are also the cheapest proof that `shell-ui` took the single `kernel.ui.mount`.
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("link", { name: /skip to content/i })).toBeAttached();

  // First run seeds deletable welcome documents demonstrating frontmatter, `fm.path`,
  // task lists and a directive (SPEC §6.5).
  //
  // Scoped to the main region, not the whole page. The assertion means "`doc-list` is
  // showing them", and any sidebar plugin that links the same documents by title is
  // another plugin's business — an unscoped lookup matches two buttons and fails on
  // strict mode, which is how `agenda` (since removed) broke this once already.
  const main = page.locator("#shell-main");
  for (const title of [
    "Welcome to Life Manager",
    "Tasks and lists",
    "Folders come from frontmatter",
    "Directives and machine sections",
  ]) {
    await expect(main.getByRole("button", { name: title })).toBeVisible();
  }
  await expect(docRows(page).first()).toBeVisible();

  // Contributions from across the distribution are on screen, which is the real
  // assertion "every plugin activated" is standing in for: the bar is `header`'s, the
  // admin and settings entries are `admin`'s and `settings`'s, and the palette —
  // `commands`', mounted as a `shell.overlay` — answers Mod+K.
  await expect(page.getByRole("banner").getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("combobox", { name: /command/i })).toBeVisible();
  await page.keyboard.press("Escape");

  const registry = await pluginRegistry(request, baseURL as string);
  expect(registry.problems).toHaveLength(0);
  expect(registry.plugins).toHaveLength(EXPECTED_PLUGINS);

  // The loader's failure path is one aggregated notice naming the plugins (SPEC §6.4).
  // Nothing should have taken it.
  await expect(page.getByText(/plugin[s]? failed|failed to load/i)).toHaveCount(0);
  expect(errors, "no console errors during boot").toEqual([]);
});

// ---------------------------------------------------------------------------
// 2. Create through the command palette; edit in CodeMirror; the list follows
// ---------------------------------------------------------------------------

test("a document created from the palette is edited in CodeMirror and the list follows live", async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page);

  await runCommand(page, /New document/);
  await expect.poll(() => currentDocumentId(page)).toBeTruthy();
  const id = currentDocumentId(page) as string;

  // `document-surface` owns the route and the mode registry; `viewer` and `editor`
  // are symmetric contributions to it (SPEC §6.5).
  const tabs = page.getByRole("tablist", { name: /document mode/i });
  await expect(tabs.getByRole("tab", { name: "Read" })).toBeVisible();
  await tabs.getByRole("tab", { name: "Edit" }).click();

  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();

  // Type a new title into the frontmatter through CodeMirror. The title the list
  // shows is materialized by the *shared Rust core* from `fm.title` (SPEC §3.4), so
  // this one assertion covers CodeMirror → y-codemirror.next → Y.Text → socket →
  // server materialization → change feed → projection → live local query.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("---\ntitle: Palette-made note\n---\n\nbody text here\n");
  await waitSynced(page);

  await expect(page.getByRole("heading", { level: 1, name: "Palette-made note" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Palette-made note" })).toBeVisible();

  // And the server agrees, which is the difference between "the client rendered it"
  // and "the workspace has it".
  expect(await rawText(request, baseURL as string, id)).toContain("title: Palette-made note");
});

// ---------------------------------------------------------------------------
// 3. Tasks: click to toggle, and a registry-contributed custom state
// ---------------------------------------------------------------------------

test("clicking a task toggles it and the state menu sets a plugin-contributed marker", async ({
  page,
  request,
  baseURL,
}) => {
  const id = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Task journey", "---", "", "- [ ] first", "- [ ] second", ""].join("\n"),
  );

  await signIn(page);
  await openDocument(page, id);

  // Read mode is where the rendered checkboxes live (`viewer` + `markdown`).
  const checkboxes = page.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.first()).not.toBeChecked();

  await checkboxes.first().click();
  await expect(checkboxes.first()).toBeChecked();
  await waitSynced(page);
  expect(await rawText(request, baseURL as string, id)).toContain("- [x] first");

  // The custom state comes from `extra-task-states`, a non-base plugin: `[/]` is
  // recognised by no markdown parser, only by the task-state registry (SPEC §6.6).
  // Right-click (the shipped interaction, replaceable) opens the state menu.
  await checkboxes.nth(1).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /in progress/i })).toBeVisible();
  await menu.getByRole("menuitem", { name: /in progress/i }).click();

  await waitSynced(page);
  const text = await rawText(request, baseURL as string, id);
  expect(text).toContain("- [/] second");
  // The first task is untouched: a marker write is a **one-character splice**, not a
  // re-render of the body (SPEC §3.3).
  expect(text).toContain("- [x] first");
});

// ---------------------------------------------------------------------------
// 4. Folders: the tree comes from fm.path, and a move is a splice
// ---------------------------------------------------------------------------

test("dragging a document between folders splices fm.path and leaves the rest of the block alone", async ({
  page,
  request,
  baseURL,
}) => {
  // The fixture is written by hand so the assertion can be exact. A comment, an
  // unusual key order and a blank line inside the block are the three things a
  // parse→re-serialize→replace round trip destroys and a splice keeps (SPEC §3.3).
  const original = [
    "---",
    "# where this note lives — keep this comment",
    "path: journeys/from",
    "title: Moves by splice",
    "",
    "tags: [alpha, beta]",
    "---",
    "",
    "# Moves by splice",
    "",
    "body stays put",
    "",
    "%%% reminders",
    "source-uid: keep-me@example.com",
    "%%%",
    "",
  ].join("\n");
  const id = await createDocument(request, baseURL as string, original);

  await signIn(page);
  await page.goto("/");
  await showSidebar(page);

  const tree = page.getByRole("tree", { name: /folders/i });
  await expect(tree).toBeVisible();
  // `folders` builds the tree from `fm.path`, implied ancestors included.
  await expect(tree.getByRole("button", { name: "from", exact: true })).toBeVisible();

  // A second folder to drop into. Created by moving nothing — just a second document
  // whose path names it, which is all a folder is.
  const otherId = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Already there", "path: journeys/to", "---", "", "x", ""].join("\n"),
  );
  await expect(tree.getByRole("button", { name: "to", exact: true })).toBeVisible();

  const row = page.getByRole("button", { name: "Moves by splice" });
  await expect(row).toBeVisible();
  await row.dragTo(tree.getByRole("button", { name: "to", exact: true }));

  await waitSynced(page);

  await expect
    .poll(async () => await rawText(request, baseURL as string, id), { timeout: 15_000 })
    .toContain("path: journeys/to");

  const moved = await rawText(request, baseURL as string, id);
  // The splice replaced exactly one value span. Everything else is byte-identical.
  expect(moved).toBe(original.replace("path: journeys/from", "path: journeys/to"));
  expect(moved).toContain("# where this note lives — keep this comment");
  expect(moved).toContain("%%% reminders");
  expect(otherId).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 5. Offline: search finds body text, and the document is readable
// ---------------------------------------------------------------------------

test("search finds body text with the network down, and the document still opens", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const needle = "peculiarsearchtoken";
  const id = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Offline searchable", "---", "", `a body containing ${needle} in it`, ""].join("\n"),
  );

  await signIn(page);
  // Wait for the row to have reached the local projection before cutting the wire —
  // offline search reads IndexedDB, and a row that never arrived is not a bug.
  await expect(page.getByRole("button", { name: "Offline searchable" })).toBeVisible();

  await context.setOffline(true);
  try {
    // SPEC §4.1/§4.2: every document is readable *and searchable* offline, through the
    // local index and the Wasm filter evaluator. The default provider is the local one.
    await page.goto(`/#/search?q=${needle}`);
    const results = page.getByRole("link", { name: /Offline searchable/i }).or(
      page.getByRole("button", { name: /Offline searchable/i }),
    );
    await expect(results.first()).toBeVisible({ timeout: 20_000 });

    await page.goto(`/#/doc/${id}`);
    // Read mode renders from `row.content` — the projection — so it works with no
    // socket and no hydrated replica.
    await expect(page.getByText(needle)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Read" })).toBeVisible();

    // Both modes are still *offered* — whether editing works is hydration's business,
    // and that is the next test, which can actually create the precondition.
    await expect(page.getByRole("tab", { name: "Edit" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  await waitSynced(page);
});

// ---------------------------------------------------------------------------
// 6. Two browsers, one document, live
// ---------------------------------------------------------------------------

test("a second browser context sees an edit live", async ({ page, browser, request, baseURL }) => {
  const id = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Collaborative", "---", "", "start", ""].join("\n"),
  );

  await signIn(page);
  await openDocument(page, id);
  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page.locator(".cm-content")).toBeVisible();

  const second: BrowserContext = await browser.newContext({ baseURL: baseURL as string });
  try {
    const other: Page = await second.newPage();
    await signIn(other);
    await openDocument(other, id);
    await other.getByRole("tab", { name: "Edit" }).click();
    await expect(other.locator(".cm-content")).toBeVisible();

    const marker = "typed-in-the-first-browser";
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(`\n${marker}\n`);

    // No reload, no polling: the per-document CRDT sync over the one WebSocket
    // (SPEC §4.3) carries it.
    await expect(other.locator(".cm-content")).toContainText(marker, { timeout: 20_000 });
  } finally {
    await second.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Themes: a pick survives a reload, because settings are a document
// ---------------------------------------------------------------------------

test("a theme choice persists across a reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/settings/themes");

  const appearance = page.getByRole("radio", { name: /^dark$/i });
  await expect(appearance).toBeVisible();
  await appearance.check();

  // The dark-scheme theme slot, chosen per scheme so `system` is correct by
  // construction (a theme is never repainted into the other scheme).
  const midnight = page.getByRole("radio", { name: /midnight/i });
  await expect(midnight).toBeVisible();
  await midnight.check();

  const background = (): Promise<string> =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--lm-bg").trim(),
    );

  // `themes` applies only through `kernel.ui.tokens.apply` (SPEC §6.5 — it overrides
  // kernel tokens, it never writes CSS variables itself), so the painted token is the
  // honest check that the pick took effect.
  await expect.poll(background).toBe(MIDNIGHT_BG);

  await waitSynced(page);
  await page.reload();
  // Both halves of the choice, asserted separately, because they persist by different
  // routes and used to disagree: the *theme* comes back through `kernel.settings`,
  // while the *appearance* is re-derived from the settings document at activation and
  // pushed into `kernel.ui.setColorSchemePreference`. A settings document that arrives
  // after `themes` activates — a cold client whose bootstrap is still in flight — used
  // to restore the theme and silently drop the appearance, leaving a dark theme unused
  // behind a light appearance.
  await expect.poll(background).toBe(MIDNIGHT_BG);
  await expect(page.getByRole("radio", { name: /midnight/i })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^dark$/i })).toBeChecked();
});

// ---------------------------------------------------------------------------
// 8. Trash: delete and restore
// ---------------------------------------------------------------------------

test("a document moves to Trash and comes back", async ({ page, request, baseURL }) => {
  const id = await createDocument(
    request,
    baseURL as string,
    ["---", "title: Doomed then saved", "---", "", "text", ""].join("\n"),
  );

  await signIn(page);
  await page.goto("/");
  const row = docRows(page).filter({ hasText: "Doomed then saved" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: /move to trash/i }).click();
  await expect(docRows(page).filter({ hasText: "Doomed then saved" })).toHaveCount(0);

  await page.goto("/#/trash");
  const trashed = page.locator(".doclist-item").filter({ hasText: "Doomed then saved" });
  await expect(trashed).toHaveCount(1);
  await trashed.getByRole("button", { name: /restore/i }).click();
  await expect(page.locator(".doclist-item").filter({ hasText: "Doomed then saved" })).toHaveCount(0);

  await page.goto("/");
  await expect(docRows(page).filter({ hasText: "Doomed then saved" })).toHaveCount(1);
  expect(await rawText(request, baseURL as string, id)).toContain("Doomed then saved");
});

// ---------------------------------------------------------------------------
// 9. Admin: an invite, and a second user who uses it
// ---------------------------------------------------------------------------

test("an admin invite lets a second user register", async ({ page, browser, baseURL }) => {
  await signIn(page);
  await page.goto("/#/settings/admin.invites");

  const invites = page.getByRole("region", { name: "Invites", exact: true });
  await expect(invites).toBeVisible();
  await invites.getByRole("button", { name: "Create invite" }).click();

  // The token is shown **once** (SPEC §5.1: single-use, 7-day) — the listing keeps only
  // a hash — so the UI has to put it on screen where it can be copied, and that live
  // region is the only place the test can read it either.
  const shown = invites.getByRole("status");
  await expect(shown).toContainText(/shown once/i);
  const value = ((await shown.locator("code").first().textContent()) ?? "").trim();
  expect(value.length, `token looked wrong: ${value}`).toBeGreaterThan(15);

  // It shows up as a pending invite in the listing, which is the admin-visible half.
  await expect(invites.getByRole("row").filter({ hasText: "pending" })).toHaveCount(1);

  const second = await browser.newContext({ baseURL: baseURL as string });
  try {
    const other = await second.newPage();
    await signIn(
      other,
      { email: "invited@e2e.test", password: "e2e-invited-password-1" },
      { invite: value },
    );
    // A second real session in the same shared workspace (SPEC §2).
    await expect(other.getByRole("banner")).toBeVisible();
    await expect(other.getByRole("button", { name: "Welcome to Life Manager" })).toBeVisible();
  } finally {
    await second.close();
  }
});
