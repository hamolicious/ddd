import { expect, test } from "@playwright/test";

import { ADMIN, createDocument, openDocument, signIn, waitSynced } from "./helpers.js";

test("the graph shows notes and links, and opens a note", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  await waitSynced(page);
  const target = await createDocument(request, baseURL as string, "---\ntitle: Graph target\n---\n\nleaf\n");
  const hub = await createDocument(
    request,
    baseURL as string,
    `---\ntitle: Graph hub\n---\n\nSee [the target](doc://${target}).\n`,
  );

  await page.goto("/#/graph");
  const canvas = page.getByRole("img", { name: /^Graph of \d+ notes and \d+ links$/ });
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width).toBeGreaterThan(200);
  expect(box?.height).toBeGreaterThan(200);

  await expect(page.getByRole("button", { name: "Graph hub, 1 link" })).toBeAttached();
  await expect(page.getByRole("button", { name: "Graph target, 1 link" })).toBeAttached();

  await page.getByRole("button", { name: "Graph settings" }).click();
  await page.getByRole("searchbox", { name: /Show notes whose title/ }).fill("Graph t");
  await expect(page.getByRole("img", { name: "Graph of 1 notes and 0 links" })).toBeVisible();
  await page.getByRole("searchbox", { name: /Show notes whose title/ }).fill("");
  await page.getByRole("button", { name: "Display" }).click();
  await expect(page.getByRole("switch", { name: "Size by links" })).toBeChecked();

  if (process.env["GRAPH_SHOTS"]) {
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${process.env["GRAPH_SHOTS"]}/global.png` });
  }

  const hubButton = page.getByRole("button", { name: "Graph hub, 1 link" });
  await hubButton.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/doc/${hub}$`));

  await openDocument(page, target);
  await page.getByRole("button", { name: "Show the side panel" }).click();
  const local = page.getByRole("img", { name: /within 1 links of this one/ });
  await expect(local).toBeAttached();

  const cog = page.getByRole("button", { name: "Local graph settings" });
  const controls = page.locator(".graph-local-controls");
  await page.mouse.move(5, 400);
  await expect(controls).toHaveCSS("opacity", "0");
  await local.hover();
  await expect(controls).toHaveCSS("opacity", "1");
  await cog.click();
  const depth = page.getByRole("slider");
  await expect(depth).toBeVisible();
  if (process.env["GRAPH_SHOTS"]) await page.screenshot({ path: `${process.env["GRAPH_SHOTS"]}/local-open.png` });
  await page.mouse.move(5, 400);
  await expect(depth).toHaveCount(0);
  await expect(controls).toHaveCSS("opacity", "0");

  const canvasBefore = await local.elementHandle();
  await page.locator(".graph-view").getByRole("button", { name: "Graph hub, 1 link" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/doc/${hub}$`));
  expect(await canvasBefore!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByRole("treeitem", { name: /Graph hub/ })).toHaveAttribute("aria-selected", "true");
  if (process.env["GRAPH_SHOTS"]) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${process.env["GRAPH_SHOTS"]}/local-moved.png` });
  }

  await local.hover();
  await page.getByRole("button", { name: "Open the full graph" }).click();
  await expect(page).toHaveURL(new RegExp(`#/graph\\?focus=${hub}$`));
  await expect(page.getByRole("img", { name: /^Graph of \d+ notes and \d+ links$/ })).toBeVisible();
  if (process.env["GRAPH_SHOTS"]) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env["GRAPH_SHOTS"]}/expand-early.png` });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${process.env["GRAPH_SHOTS"]}/expand-late.png` });
  }
  if (process.env["GRAPH_SHOTS"]) {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${process.env["GRAPH_SHOTS"]}/local.png` });
  }
});
