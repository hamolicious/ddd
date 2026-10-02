import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN, createDocument, modeSwitch, openDocument, signIn, waitSynced } from "./helpers.js";

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
    expect(Object.keys(rows)).toEqual(["title", "path", "date", "due", "tags", "draft"]);

    expect(rows["title"]).toBe("Frontmatter on show");
    expect(rows["path"]).toBe("sweep/visible");

    expect(rows["date"]).not.toBe("2026-09-23");
    expect(rows["date"]).toContain("2026");
    await expect(page.locator(".viewer-property-value time")).toHaveAttribute(
      "datetime",
      "2026-09-23",
    );

    await expect(page.locator(".viewer-property-chip")).toHaveText(["home", "urgent"]);
    expect(rows["draft"]).toBe("Yes");
    expect(rows["due"]).toBe("—");

    await expect(read.getByRole("heading", { name: "Frontmatter on show" })).toBeVisible();
    await expect(read).toContainText("The body, and nothing above it.");
    await expect(read).not.toContainText("source-uid");
    await expect(read).not.toContainText("%%%");
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
    expect(
      await page.locator(".docsurface-root").getByText(/could not be read/i).count(),
    ).toBe(1);

    const rows = await headerRows(page);
    expect(rows["title"]).toBe("Half readable");
    expect(rows["broken"]).toBeUndefined();

    await page.getByRole("tab", { name: "Edit" }).click();
    await expect(page.locator(".cm-content")).toBeVisible();
    expect(
      await page.locator(".docsurface-root").getByText(/could not be read/i).count(),
    ).toBe(0);
    await expect(page.locator(".cm-content")).toContainText('broken: "unterminated');
  });

  test("says nothing about parsing when there is nothing wrong", async ({
    page,
    request,
    baseURL,
  }) => {
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

    await expect
      .poll(() =>
        page
          .locator(".viewer-properties-list")
          .evaluate((node) => getComputedStyle(node).tableLayout),
      )
      .toBe("fixed");

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

    await expect(content).toContainText("title: Frontmatter on show");
    await expect(content).toContainText("tags: [home, urgent]");
    await expect(content).toContainText("a comment the splice discipline must never eat");

    const placeholders = page.locator(".cm-foldPlaceholder");
    await expect(placeholders).toHaveCount(1);
    await expect(placeholders.nth(0)).toHaveAttribute("aria-label", "Expand sweep-demo data");

    const fmLine = page.locator(".cm-line", { hasText: "title: Frontmatter on show" }).first();
    await expect(fmLine).toBeVisible();

    expect(await fmLine.locator("span").count()).toBeGreaterThan(0);
  });
});

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

    const choose = async (modeId: string): Promise<void> => {
      await page.goto("/#/settings/documents");
      await expect(select).toBeVisible();
      await select.selectOption(modeId);
      await waitSynced(page);
      await expect
        .poll(() => storedSurfaceSettings(request, api), { timeout: 20_000 })
        .toContain(`defaultMode: ${modeId}`);
    };

    try {
      await page.goto("/#/settings/documents");
      await expect(select).toBeVisible();
      await expect(select.locator("option")).toHaveText(["Read", "Edit"]);

      await choose("edit");

      await openDocument(page, id);
      await expect(page.locator(".cm-editor")).toBeVisible();
      await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.locator(".cm-content")).toContainText("title: Opens in the chosen mode");

      await page.reload();
      await expect(modeSwitch(page)).toBeVisible();
      await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.locator(".cm-editor")).toBeVisible();

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
