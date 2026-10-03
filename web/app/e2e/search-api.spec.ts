import { expect, test, type Page } from "@playwright/test";

import { ADMIN, createDocument, signIn } from "./helpers.js";
import { network } from "./network.js";

type Plan = { readonly source?: string; readonly stages?: readonly unknown[] };

interface Probe {
  run(plan: Plan): Promise<{ rows: Record<string, unknown>[]; total?: number }>;
  watch(plan: Plan): Promise<number>;
  latest(handle: number): { rows: Record<string, unknown>[]; total: number } | undefined;
  updates(handle: number): number;
}

async function probe(page: Page): Promise<void> {
  await page.waitForFunction(() => "dddSearchProbe" in globalThis, undefined, { timeout: 30_000 });
}

function run(page: Page, plan: Plan) {
  return page.evaluate((p) => (globalThis as unknown as { dddSearchProbe: Probe }).dddSearchProbe.run(p), plan);
}

function eq(field: string, value: string) {
  return { where: { cmp: { field, op: "eq", value: { str: value } } } };
}

test("a plugin runs a search pipeline and its watch follows edits", async ({ page, request, baseURL }) => {
  const tag = `probe${Date.now()}`;
  await createDocument(request, baseURL!, `---\nprobe: ${tag}\nclient: acme\n---\n# Probe ${tag}\n\n- [ ] first ${tag}\n`);
  await signIn(page, ADMIN);
  await probe(page);

  const openTasks: Plan = {
    source: "tasks",
    stages: [eq("doc.fm.probe", tag), eq("state", "open"), { select: [{ field: "text" }] }, { sort: ["text"] }],
  };
  await expect.poll(async () => (await run(page, openTasks)).rows, { timeout: 30_000 }).toEqual([{ text: `first ${tag}` }]);

  const grouped = await run(page, {
    source: "fm",
    stages: [eq("doc.fm.probe", tag), { group_by: ["key"] }, { count: { as: "n" } }],
  });
  expect(grouped.rows).toEqual([
    { key: "client", n: 1 },
    { key: "probe", n: 1 },
  ]);

  const handle = await page.evaluate(
    (p) => (globalThis as unknown as { dddSearchProbe: Probe }).dddSearchProbe.watch(p),
    openTasks,
  );
  await createDocument(request, baseURL!, `---\nprobe: ${tag}\n---\n# Second ${tag}\n\n- [ ] second ${tag}\n`);
  await expect
    .poll(
      () => page.evaluate((h) => (globalThis as unknown as { dddSearchProbe: Probe }).dddSearchProbe.latest(h)?.rows, handle),
      { timeout: 30_000 },
    )
    .toEqual([{ text: `first ${tag}` }, { text: `second ${tag}` }]);
});

test("offline, new and edited notes are searchable at once without any search request", async ({ page, context }) => {
  const tag = `offline${Date.now()}`;
  const net = await network(page, context);
  await signIn(page, ADMIN);
  await probe(page);
  await net.offline();

  const searchRequests: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (/\/api\/(query|search)|[?&]search=/.test(url)) searchRequests.push(url);
  });

  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("combobox", { name: /command/i }).fill("New document");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /^Edit/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: /^Edit/ }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`# Train ${tag}\n\n- [ ] written offline ${tag}\n`);

  await expect
    .poll(async () => (await run(page, { stages: [{ text: `${tag} ` }, { select: [{ field: "title" }] }] })).rows, {
      timeout: 20_000,
    })
    .toEqual([{ title: `Train ${tag}` }]);
  await expect
    .poll(async () => (await run(page, { source: "tasks", stages: [{ text: `${tag} ` }, { select: [{ field: "text" }] }] })).rows)
    .toEqual([{ text: `written offline ${tag}` }]);

  await page.keyboard.type(`- [x] also done ${tag}\n`);
  await expect
    .poll(async () => (await run(page, { source: "tasks", stages: [{ text: `${tag} ` }, eq("state", "done"), { select: [{ field: "text" }] }] })).rows)
    .toEqual([{ text: `also done ${tag}` }]);

  expect(searchRequests).toEqual([]);

  await net.online();
  await expect
    .poll(async () => (await run(page, { stages: [{ text: `${tag} ` }, { select: [{ field: "title" }, { field: "materialized_version" }] }] })).rows[0]?.materialized_version, {
      timeout: 30_000,
    })
    .not.toBe("local");
  expect((await run(page, { source: "tasks", stages: [{ text: `${tag} ` }, { select: [{ field: "text" }] }, { sort: ["text"] }] })).rows).toEqual([
    { text: `also done ${tag}` },
    { text: `written offline ${tag}` },
  ]);
});

test("two tabs share one search database, and the second takes over when the first closes", async ({ page, context, request, baseURL }) => {
  const tag = `tabs${Date.now()}`;
  await createDocument(request, baseURL!, `# Shared ${tag}\n`);
  await signIn(page, ADMIN);
  await probe(page);
  const second = await context.newPage();
  await second.goto("/");
  await probe(second);

  const titles: Plan = { stages: [{ text: `${tag} ` }, { select: [{ field: "title" }] }, { sort: ["title"] }] };
  await expect.poll(async () => (await run(second, titles)).rows, { timeout: 30_000 }).toEqual([{ title: `Shared ${tag}` }]);

  await second.bringToFront();
  await second.getByRole("button", { name: "Commands" }).click();
  await second.getByRole("combobox", { name: /command/i }).fill("New document");
  await second.getByRole("option", { name: /New document/ }).click();
  await expect(second.getByRole("tab", { name: /^Edit/ })).toBeVisible({ timeout: 20_000 });
  await second.getByRole("tab", { name: /^Edit/ }).click();
  await second.locator(".cm-content").click();
  await second.keyboard.press("ControlOrMeta+a");
  await second.keyboard.type(`# Typed in tab two ${tag}\n`);

  await expect
    .poll(async () => (await run(page, titles)).rows, { timeout: 20_000 })
    .toEqual([{ title: `Shared ${tag}` }, { title: `Typed in tab two ${tag}` }]);

  await page.close();
  await expect
    .poll(async () => (await run(second, titles)).rows, { timeout: 30_000 })
    .toEqual([{ title: `Shared ${tag}` }, { title: `Typed in tab two ${tag}` }]);
});
