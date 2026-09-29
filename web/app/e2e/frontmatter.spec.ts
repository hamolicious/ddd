/**
 * **Frontmatter, where a person can see it** — the owner's 2026-09-25 asks, end to end.
 *
 * Three behaviours that only exist assembled, one file because they are one decision:
 * *frontmatter is human-owned (SPEC §3.3), so stop hiding it from the human.*
 *
 * 1. **Read mode renders it as a pretty header** (`viewer`), typed the way the
 *    properties panel types it — dates formatted, lists as chips, booleans as words —
 *    while the `%%%` machine sections stay hidden, because those are not.
 * 2. **Edit mode shows the raw block, unfolded** (`editor`). It used to collapse
 *    itself on open behind a per-user setting no screen rendered, which meant the one
 *    surface built for editing frontmatter opened with the frontmatter shut.
 * 3. **"Open documents in" is a setting you can reach** (`document-surface`). The
 *    `defaultMode` key has existed since M3 and nothing rendered it (POLISH-BACKLOG
 *    item 2), so the app's most common action — new document — always landed in read
 *    mode on an empty page with no way to change that (item 1).
 *
 * The header is **display-only** and this file pins that too: the properties panel and
 * edit mode are the two ways to change a value, and a third one that looked like a
 * label would need the whole splice discipline of SPEC §3.3 to be correct.
 *
 * And `fm_parse_error` (SPEC §3.4) is asserted **in both modes, once per mode**. It is
 * one rule with two failure directions and this file has now caught both: saying it
 * twice on one screen (the surface's full-width notice above `viewer`'s header), and
 * saying it nowhere at all (edit mode, after that notice was removed — where the
 * read-mode warning's own advice sends the reader, and where the properties panel is a
 * drawer that starts closed at 390 px).
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN, createDocument, modeSwitch, openDocument, signIn, waitSynced } from "./helpers.js";

/** SPEC §6.5's acceptance viewport — the header has to hold it like everything else. */
const PHONE = { width: 390, height: 844 };

const FIXTURE = [
  "---",
  "# a comment the splice discipline must never eat",
  "title: Frontmatter on show",
  "path: sweep/visible",
  "date: 2026-09-23",
  "tags: [home, urgent]",
  "draft: true",
  "due: null",
  "---",
  "",
  "# Frontmatter on show",
  "",
  "The body, and nothing above it.",
  "",
  "%%% sweep-demo",
  "source-uid: abc123@example.com",
  "%%%",
  "",
].join("\n");

/**
 * The header's rows as key → printed value.
 *
 * Read out of the DOM rather than asserted per element, because the claim being made is
 * about *pairing* (this key shows this value), which a per-element assertion cannot
 * state. Each row is a `<tr>` with the key in its `<th>` and the value in its `<td>`.
 */
async function headerRows(page: Page): Promise<Record<string, string>> {
  return await page.locator(".viewer-properties-list").evaluate((list) => {
    const rows: Record<string, string> = {};
    for (const row of list.querySelectorAll(".viewer-property")) {
      const key = row.querySelector("th")?.textContent?.trim() ?? "";
      rows[key] = row.querySelector("td")?.textContent?.trim() ?? "";
    }
    return rows;
  });
}

test.describe("read mode shows the frontmatter as a properties header", () => {
  test("renders the document's own title, path and date, typed", async ({
    page,
    request,
    baseURL,
  }) => {
    const id = await createDocument(request, baseURL as string, FIXTURE);
    await signIn(page, ADMIN);
    await openDocument(page, id);

    const read = page.getByRole("tabpanel", { name: "Read" });
    await expect(page.locator(".viewer-properties")).toBeVisible();

    const rows = await headerRows(page);
    // Order comes from the shared `PREFERRED_KEY_ORDER`: the keys the whole app reads
    // are first, the rest alphabetical. A reader should not have to hunt for `title`.
    expect(Object.keys(rows)).toEqual(["title", "path", "date", "due", "tags", "draft"]);

    expect(rows["title"]).toBe("Frontmatter on show");
    expect(rows["path"]).toBe("sweep/visible");

    // The date is *formatted*, not echoed — and the stored ISO value is kept on the
    // element, which is both what a reader can inspect and what this test can assert
    // without pinning the runner's locale.
    expect(rows["date"]).not.toBe("2026-09-23");
    expect(rows["date"]).toContain("2026");
    await expect(page.locator(".viewer-property-value time")).toHaveAttribute(
      "datetime",
      "2026-09-23",
    );

    // A list is chips, a boolean is a word, and a key that is set but holds nothing
    // still gets a row — the header and the panel beside it must agree about which
    // properties exist.
    await expect(page.locator(".viewer-property-chip")).toHaveText(["home", "urgent"]);
    expect(rows["draft"]).toBe("Yes");
    expect(rows["due"]).toBe("—");

    // The body is still the body, and the machine section is still hidden: the header
    // shows frontmatter, which is human-owned, and nothing else (SPEC §3.3).
    await expect(read.getByRole("heading", { name: "Frontmatter on show" })).toBeVisible();
    await expect(read).toContainText("The body, and nothing above it.");
    await expect(read).not.toContainText("source-uid");
    await expect(read).not.toContainText("%%%");
    // Nor the raw block itself — a header, not a dump of the text.
    await expect(read).not.toContainText("tags: [home, urgent]");
  });

  test("is display-only: no control, and the text is untouched", async ({
    page,
    request,
    baseURL,
  }) => {
    const id = await createDocument(request, baseURL as string, FIXTURE);
    await signIn(page, ADMIN);
    await openDocument(page, id);
    await expect(page.locator(".viewer-properties")).toBeVisible();

    // Editing lives in the properties panel and in edit mode. A header that quietly
    // became a third editor would need SPEC §3.3's splice discipline to be correct,
    // and this is the cheapest statement that it did not.
    const header = page.locator(".viewer-properties");
    expect(await header.locator("input, select, textarea, button, [contenteditable]").count()).toBe(
      0,
    );
  });

  test("renders nothing at all for a document with no frontmatter", async ({
    page,
    request,
    baseURL,
  }) => {
    // An empty bordered strip above every unadorned note is worse than no header, and
    // most notes are unadorned.
    const id = await createDocument(
      request,
      baseURL as string,
      "# Just prose\n\nNo frontmatter here.\n",
    );
    await signIn(page, ADMIN);
    await openDocument(page, id);

    await expect(page.getByRole("tabpanel", { name: "Read" })).toContainText("No frontmatter here.");
    await expect(page.locator(".viewer-properties")).toHaveCount(0);
  });

  test("warns inline when a frontmatter line could not be read", async ({
    page,
    request,
    baseURL,
  }) => {
    // SPEC §3.4: a malformed line is dropped and `fm_parse_error` is set, with the text
    // left untouched. The header is therefore *incomplete*, and a reader comparing it
    // against the raw block needs to know which of the two is lying.
    const id = await createDocument(
      request,
      baseURL as string,
      '---\ntitle: Half readable\nbroken: "unterminated\n---\n\nbody\n',
    );
    await signIn(page, ADMIN);
    await openDocument(page, id);

    await expect(page.locator(".viewer-properties-warning")).toContainText(
      /could not be read/i,
    );
    // Exactly one statement of it on the document surface. `document-surface` used to
    // announce it too, in a full-width notice directly above, which made "one line is
    // missing" a thing the app said twice in two different voices on one screen.
    expect(
      await page.locator(".docsurface-root").getByText(/could not be read/i).count(),
    ).toBe(1);

    const rows = await headerRows(page);
    expect(rows["title"]).toBe("Half readable");
    expect(rows["broken"]).toBeUndefined();

    // ...and **not in edit mode**. A line is malformed for a moment every time a key is
    // typed (`stat` before its `:`), and a notice that came and went on those keystrokes
    // pushed the text being typed up and down. The malformed line is right there in the
    // text, and read mode says what it costs.
    await page.getByRole("tab", { name: "Edit" }).click();
    await expect(page.locator(".cm-content")).toBeVisible();
    expect(
      await page.locator(".docsurface-root").getByText(/could not be read/i).count(),
    ).toBe(0);
    // The text itself is untouched — the malformed line is right there to be fixed.
    await expect(page.locator(".cm-content")).toContainText('broken: "unterminated');
  });

  test("says nothing about parsing when there is nothing wrong", async ({
    page,
    request,
    baseURL,
  }) => {
    // Read mode's warning is a consequence of `fm_parse_error`, not decoration.
    const id = await createDocument(request, baseURL as string, FIXTURE);
    await signIn(page, ADMIN);
    await openDocument(page, id);
    await expect(page.locator(".viewer-properties")).toBeVisible();
    expect(
      await page.locator(".docsurface-root").getByText(/could not be read/i).count(),
    ).toBe(0);
  });

  test("holds the page at 390 px", async ({ page, request, baseURL }) => {
    await page.setViewportSize(PHONE);
    const id = await createDocument(
      request,
      baseURL as string,
      [
        "---",
        "title: A phone-hostile header",
        "path: sweep/deeply/nested/folder/with/a/long/unbreakable-segment-nobody-would-type",
        "tags: [alpha, beta, gamma, delta, epsilon, zeta, eta, theta]",
        "url: https://example.com/" + "segment-".repeat(30) + "end",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
    );
    await signIn(page, ADMIN);
    await openDocument(page, id);
    await expect(page.locator(".viewer-properties")).toBeVisible();

    // Wait for this plugin's stylesheet, not just for its markup. `style.css` is a
    // `<link>` the kernel adds when the plugin activates (SPEC §6.4), so the rows can
    // be in the DOM a frame before the CSS that lays them out applies — and measuring
    // then measures the *user agent's* table: auto layout, where one long value widens
    // the whole table past the screen. It fails, and it fails for a reason that has
    // nothing to do with the rule under test.
    await expect
      .poll(() =>
        page
          .locator(".viewer-properties-list")
          .evaluate((node) => getComputedStyle(node).tableLayout),
      )
      .toBe("fixed");

    // The same rule `mobile-routes.spec.ts` enforces everywhere, stated here against
    // the one surface this wave added: nothing scrolls the page sideways, and nothing
    // is clipped outside a container that scrolls itself.
    const report = await page.evaluate(() => {
      const root = document.documentElement;
      const offenders = [...document.querySelectorAll<HTMLElement>(".viewer-properties *")]
        .filter((element) => element.clientWidth > 0 && element.clientHeight > 0)
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders };
    });
    expect(report.scrollWidth, "the page scrolls sideways").toBeLessThanOrEqual(
      report.clientWidth,
    );
    expect(report.offenders, "a header row is clipped").toEqual([]);
  });
});

test.describe("edit mode shows the raw frontmatter block", () => {
  test("is unfolded on open, and still highlighted", async ({ page, request, baseURL }) => {
    const id = await createDocument(request, baseURL as string, FIXTURE);
    await signIn(page, ADMIN);
    await openDocument(page, id);
    await page.getByRole("tab", { name: "Edit" }).click();

    const content = page.locator(".cm-content");
    await expect(content).toBeVisible();

    // Every line of the block, from the moment the editor mounts — including the
    // comment, which is the thing SPEC §3.3's splice rule exists to protect and which
    // no other surface in the app shows.
    await expect(content).toContainText("title: Frontmatter on show");
    await expect(content).toContainText("tags: [home, urgent]");
    await expect(content).toContainText("a comment the splice discipline must never eat");

    // The `%%%` section is still folded: it is machine-owned, and the prose is what
    // the user came for. One placeholder, not two.
    const placeholders = page.locator(".cm-foldPlaceholder");
    await expect(placeholders).toHaveCount(1);
    await expect(placeholders.nth(0)).toHaveAttribute("aria-label", "Expand sweep-demo data");

    // And there is no fold to *re*-collapse the frontmatter with: the fold service
    // offers the region no range at all, so nothing — a gutter arrow, `foldAll`, a
    // contributed extension — can put it away again. `regions.test.ts` pins that at
    // the unit level; here the statement is simply that the block is on screen.
    const fmLine = page.locator(".cm-line", { hasText: "title: Frontmatter on show" }).first();
    await expect(fmLine).toBeVisible();

    // Highlighting survives: a key inside the block is a styled token, not a bare text
    // node. (CodeMirror only wraps text in a `<span>` when the highlighter claimed it.)
    expect(await fmLine.locator("span").count()).toBeGreaterThan(0);
  });
});

/**
 * This plugin's section of the per-user settings document, as the **server** holds it.
 *
 * The setting under test is per-user, persistent, and shared by every spec in this
 * suite (one worker, one account, one workspace — `playwright.app.config.ts`), so
 * leaving it on Edit would silently change what every later file sees when it opens a
 * document. A green "the select says Read" is not enough to rule that out: the control
 * is optimistic and its write goes through a CRDT splice into a document, so the
 * checked claim has to be about the stored text, not about the widget.
 *
 * Read over REST for the reason `helpers.rawText` is: what the client *wrote* can only
 * be verified from outside the client. The `request` fixture already has a session by
 * the time this runs, because the test creates its fixture document first.
 */
async function storedSurfaceSettings(
  request: APIRequestContext,
  baseURL: string,
): Promise<string> {
  const response = await request.get(`${baseURL}/api/documents?limit=200`);
  if (!response.ok()) return "";
  const body = (await response.json()) as {
    documents?: { fm?: Record<string, unknown>; content?: string }[];
  };
  const settings = (body.documents ?? []).find((row) => typeof row.fm?.["settings-owner"] === "string");
  return /%%% document-surface\n([\s\S]*?)\n%%%/.exec(settings?.content ?? "")?.[1] ?? "";
}

test.describe('the "Open documents in" setting', () => {
  // A reload straight into a document boots the plugins one at a time, and `editor`
  // activates before `viewer`: the surface used to settle on Edit — the only mode loaded
  // when the document first resolved — and keep it once Read arrived. The suite's
  // preference is Read (see the restore below), so no setting is changed here.
  test("is respected on a reload straight into a document", async ({ page, request, baseURL }) => {
    const id = await createDocument(
      request,
      baseURL as string,
      "---\ntitle: Reloads in the chosen mode\npath: sweep\n---\n\nbody\n",
    );
    await signIn(page, ADMIN);
    await openDocument(page, id);
    await page.reload();
    await expect(modeSwitch(page)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Read" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("is reachable, and decides how the next document opens", async ({
    page,
    request,
    baseURL,
  }) => {
    const api = baseURL as string;
    const id = await createDocument(
      request,
      api,
      "---\ntitle: Opens in the chosen mode\npath: sweep\n---\n\nbody\n",
    );
    await signIn(page, ADMIN);

    const select = page.getByLabel("Open documents in");

    /** Choose a mode and wait until the *server* has it. See `storedSurfaceSettings`. */
    const choose = async (modeId: string): Promise<void> => {
      await page.goto("/#/settings/documents");
      await expect(select).toBeVisible();
      await select.selectOption(modeId);
      await waitSynced(page);
      await expect
        .poll(() => storedSurfaceSettings(request, api), { timeout: 20_000 })
        .toContain(`defaultMode: ${modeId}`);
    };

    // The restore is a `finally` and it waits for the stored value, not for the widget:
    // an earlier version navigated away as soon as the select changed, which lost the
    // write and left every spec after this one opening documents in Edit.
    try {
      await page.goto("/#/settings/documents");
      await expect(select).toBeVisible();
      // The options come from the `document.mode` registry, not from a list in
      // `document-surface` — that symmetry is what M3's acceptance test rests on.
      await expect(select.locator("option")).toHaveText(["Read", "Edit"]);

      await choose("edit");

      // A document with no remembered mode of its own now opens in the editor.
      await openDocument(page, id);
      await expect(page.locator(".cm-editor")).toBeVisible();
      await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.locator(".cm-content")).toContainText("title: Opens in the chosen mode");

      // And a reload of that document opens in the editor too: the preference is read
      // on a cold boot, not only from the value this tab just wrote.
      await page.reload();
      await expect(modeSwitch(page)).toBeVisible();
      await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.locator(".cm-editor")).toBeVisible();

      // "Unless the mode switch says otherwise": a per-document choice still wins, and
      // it survives leaving the document and coming back.
      await page.getByRole("tab", { name: "Read" }).click();
      await expect(page.getByRole("tabpanel", { name: "Read" })).toBeVisible();
      await page.goto("/#/");
      await openDocument(page, id);
      await expect(page.getByRole("tab", { name: "Read" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    } finally {
      await choose("read");
      // And drop the remembered choice made above, so the next spec file starts from
      // the state this one found.
      const forget = page.getByRole("button", { name: /forget remembered modes/i });
      if ((await forget.count()) > 0) {
        await forget.click();
        await waitSynced(page);
        await expect
          .poll(() => storedSurfaceSettings(request, api), { timeout: 20_000 })
          .not.toContain(id);
      }
    }
  });
});
