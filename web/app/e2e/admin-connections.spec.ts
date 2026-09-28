/**
 * Admin → Plugins → a plugin's Connections (PLUGIN-PROTOCOLS §6, §6a): the ports of a
 * plugin in list form, editing the same draft as the Wiring tab. `graph`'s index is bound
 * automatically to `indexer`; `shell-ui`'s sidebar seats are reordered from the list,
 * applied from the Plugins tab's draft bar, and a second page that was already open
 * follows without a reload. Then the order goes back, so the server is left as found.
 *
 * The second page follows `wiring.spec.ts`: the test hooks on, the sidebar's panel
 * sections read in DOM order.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { ADMIN, pluginsActivated, showSidebar, signIn } from "./helpers.js";

/** The plugin ids of the sidebar's panels, top to bottom. */
const sidebarOrder = (page: Page): Promise<string[]> =>
  page
    .getByRole("complementary", { name: /sidebar/i })
    .locator("section[data-plugin]")
    .evaluateAll((sections) => sections.map((section) => (section as HTMLElement).dataset["plugin"] ?? ""));

/** The providers of a host port, in seat order (the bench after), as the list shows them. */
const seats = (details: Locator, host: string): Promise<string[]> =>
  details
    .getByRole("list", { name: `Seats of ${host}` })
    .locator("li[data-peer]")
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset["peer"] ?? ""));

/** The Wiring card's live version. */
const liveVersion = async (page: Page): Promise<number> => {
  const text = await page.getByRole("region", { name: "Wiring", exact: true }).getByText(/^Live version \d+$/).textContent();
  return Number(/\d+/.exec(text ?? "")?.[0] ?? Number.NaN);
};

/** Apply from the Plugins tab's draft bar and wait for the next live version. */
async function applyDraft(page: Page): Promise<number> {
  const before = await liveVersion(page);
  const bar = page.getByRole("region", { name: "Wiring draft" });
  await expect(bar).toContainText("1 change");
  await bar.getByRole("button", { name: "Apply" }).click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: /^Apply v\d+/ });
  const apply = bar.getByRole("button", { name: "Apply" });
  await Promise.race([
    expect(apply).toHaveCount(0, { timeout: 20_000 }),
    confirm.waitFor({ state: "visible", timeout: 20_000 }).then(() => confirm.click()),
  ]);
  await expect(apply).toHaveCount(0, { timeout: 20_000 });
  // The list and the Wiring card reload with the new version.
  await expect(page.getByRole("region", { name: "Wiring", exact: true }).getByText(`Live version ${before + 1}`)).toBeVisible({ timeout: 20_000 });
  return before + 1;
}

test("a plugin's connections are listed and edited from the plugin list", async ({ page, request, baseURL }) => {
  test.setTimeout(180_000);
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} appeared: ${dialog.message()}`);
  });
  const bootstrap = await request.get(`${baseURL}/api/auth/bootstrap`);
  if (bootstrap.ok() && ((await bootstrap.json()) as { needs_first_user?: boolean }).needs_first_user) {
    await request.post(`${baseURL}/api/auth/register`, { data: ADMIN });
  }
  await signIn(page, ADMIN);

  // The second page, open before anything is applied.
  const second = await page.context().newPage();
  await second.goto("/");
  await expect(second.locator("main")).toBeVisible();
  await second.evaluate(() => localStorage.setItem("lm:test-hooks", "1"));
  const secondLoaded = pluginsActivated(second);
  await second.reload();
  await secondLoaded;
  await expect.poll(() => second.evaluate(() => "__lmTest" in globalThis)).toBe(true);
  await showSidebar(second);
  const initialOrder = await sidebarOrder(second);
  // The default seats follow the order hints (doc-list 10, folders 20); an earlier spec
  // may have left either first, so the two are read, not assumed.
  expect([...initialOrder.slice(0, 2)].sort()).toEqual(["doc-list", "folders"]);
  const portOf = (id: string): string => (id === "folders" ? "folders:tree" : "doc-list:list");
  const [top, next] = initialOrder.slice(0, 2).map(portOf) as [string, string];
  const reloads: string[] = [];
  second.on("load", () => reloads.push(second.url()));

  await page.goto("/#/admin/plugins");
  await expect(page.getByRole("region", { name: "Wiring", exact: true }).getByText(/^Live version \d+$/)).toBeVisible({ timeout: 30_000 });

  // graph: its index port, bound automatically to indexer.
  await page.getByRole("button", { name: "Details for Graph view" }).click();
  const graph = page.locator("#admin-plugin-details-graph");
  const connections = graph.getByRole("region", { name: "Connections of graph" });
  await expect(connections.getByRole("heading", { name: "Uses" })).toBeVisible();
  await expect(connections.getByRole("heading", { name: "Used by" })).toBeVisible();
  const index = connections.locator('li[data-port="graph:index"]');
  await expect(index).toContainText("index · lm/workspace-index@^1.0");
  await expect(index.locator("[data-bound]")).toHaveText("indexer:index", { timeout: 30_000 });
  const provider = index.getByRole("combobox", { name: "Provider for graph:index" });
  await expect(provider).toHaveValue("");
  await expect(provider.locator("option:checked")).toHaveText("Automatic");
  await expect(provider.locator('option[value="indexer:index"]')).toHaveCount(1);
  await expect(provider).toBeEnabled();

  // shell-ui: the sidebar's seats, in the order the open page renders them.
  await page.getByRole("button", { name: "Details for Shell UI" }).click();
  const shell = page.locator("#admin-plugin-details-shell-ui");
  const firstTwo = async (): Promise<string[]> => (await seats(shell, "shell-ui:sidebar")).slice(0, 2);
  await expect.poll(firstTwo).toEqual([top, next]);
  await expect(shell.getByRole("button", { name: `Move ${top} up in shell-ui:sidebar` })).toBeDisabled();

  // 1. Move the second seat up from the list: one change in the draft bar, Apply.
  await shell.getByRole("button", { name: `Move ${next} up in shell-ui:sidebar` }).click();
  await expect.poll(firstTwo).toEqual([next, top]);
  await applyDraft(page);
  await expect.poll(() => sidebarOrder(second), { timeout: 20_000 }).toEqual([initialOrder[1], initialOrder[0], ...initialOrder.slice(2)]);
  expect(reloads).toEqual([]);

  // 2. And back.
  await expect(shell.getByRole("button", { name: `Move ${top} up in shell-ui:sidebar` })).toBeEnabled();
  await shell.getByRole("button", { name: `Move ${top} up in shell-ui:sidebar` }).click();
  await expect.poll(firstTwo).toEqual([top, next]);
  await applyDraft(page);
  await expect.poll(() => sidebarOrder(second), { timeout: 20_000 }).toEqual(initialOrder);
  expect(reloads).toEqual([]);
});
