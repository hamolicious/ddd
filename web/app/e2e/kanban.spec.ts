import { expect, test } from "@playwright/test";

import { ADMIN, createDocument, openDocument, signIn } from "./helpers.js";

test("a card with a long body scrolls inside itself instead of growing", async ({ page, request, baseURL }) => {
  const base = baseURL as string;
  const needle = `kanbanscroll${Date.now().toString(36)}`;
  const lines = Array.from({ length: 60 }, (_, index) => `Line ${String(index + 1)} of a long card body.`);
  await createDocument(
    request,
    base,
    ["---", "title: Long card", "status: todo", "---", "", needle, "", ...lines, ""].join("\n"),
  );
  const board = await createDocument(
    request,
    base,
    [
      "---",
      "title: Card scroll board",
      `saved-search: "q=${needle}"`,
      "type: kanban",
      "---",
      "",
      "%%% kanban",
      "group: fm.status",
      "columns: todo",
      "card: title,content",
      "%%%",
      "",
    ].join("\n"),
  );

  await signIn(page, ADMIN);
  await openDocument(page, board);

  const text = page.locator("[data-card-text]");
  await expect(text).toContainText("Line 1 of a long card body.");
  const size = await text.evaluate((element) => ({
    height: element.clientHeight,
    content: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  expect(size.height).toBeLessThanOrEqual(200);
  expect(size.content).toBeGreaterThan(size.height);
  expect(size.overflow).toBe("auto");

  await text.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => text.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator(".kanban-lifted")).toHaveCount(0);
});
