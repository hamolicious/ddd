/**
 * `syntax-highlight` in the real app: a Rust block offers to install Rust, installing it
 * colours the block in read mode and in the editor, a claimed fence (none here) and an
 * unknown language stay as they were, and Settings → Code languages removes it again.
 *
 * Also the CSP check the unit tests cannot make: tree-sitter compiles wasm in the page,
 * which the policy allows (`'wasm-unsafe-eval'`) and nothing else it does may need more.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { ADMIN, createDocument, openDocument, signIn, waitSynced } from "./helpers.js";

test("a code block's language is installed from the block, highlighted, and removed in Settings", async ({
  page,
  request,
  baseURL,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (/content security policy|syntax-highlight|web-tree-sitter/i.test(message.text())) problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));

  await signIn(page, ADMIN);
  await waitSynced(page);
  const id = await createDocument(
    request,
    baseURL as string,
    "---\ntitle: Code\n---\n\n```rust\nfn main() {\n    let s = \"hi\";\n}\n```\n\n```cobol\nDISPLAY 'HI'.\n```\n",
  );
  await openDocument(page, id);

  // Read mode: plain, with an offer to install.
  const rustBlock = page.locator(".lmsh-block").filter({ hasText: "fn main" });
  await expect(rustBlock).toBeVisible();
  await expect(rustBlock.locator(".lmsh-keyword")).toHaveCount(0);
  const unknown = page.locator(".lmsh-block").filter({ hasText: "DISPLAY" });
  await expect(unknown.getByRole("button")).toHaveCount(0);

  await rustBlock.getByRole("button", { name: "Highlight as Rust" }).click();
  await expect(rustBlock.getByRole("button")).toHaveCount(0);
  await expect(rustBlock.locator(".lmsh-keyword").first()).toHaveText("fn");
  await expect(rustBlock.locator(".lmsh-string")).toHaveText('"hi"');
  await expect(rustBlock.locator(".lmsh-function")).toHaveText("main");

  // Edit mode: the same block, coloured by the editor extension.
  await page.getByRole("tab", { name: "Edit" }).click();
  const content = page.locator(".cm-content");
  await expect(content).toBeVisible();
  await expect(content.locator(".lmsh-keyword").filter({ hasText: /^let$/ })).toHaveCount(1);
  await expect(content.locator(".lmsh-string").first()).toContainText('"hi"');

  // Settings lists it as installed; removing it returns the block to plain text.
  await page.goto("/#/settings");
  await page.getByRole("link", { name: "Code languages" }).click();
  const row = page.locator(".lmsh-row").filter({ hasText: "Rust" });
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row.getByRole("button", { name: "Install" })).toBeVisible();

  // It reopens in Edit, the mode it was left in: uncoloured there too, then in Read.
  await openDocument(page, id);
  await expect(content).toContainText("fn main");
  await expect(content.locator(".lmsh-keyword")).toHaveCount(0);
  await page.getByRole("tab", { name: "Read" }).click();
  await expect(rustBlock.getByRole("button", { name: "Highlight as Rust" })).toBeVisible();
  await expect(rustBlock.locator(".lmsh-keyword")).toHaveCount(0);

  expect(problems).toEqual([]);
});

test("a grammar uploaded in Settings highlights its own fences, and a broken one is refused", async ({
  page,
  request,
  baseURL,
}) => {
  // The built plugin's own grammars, at whatever version the manifest says.
  const plugin = new URL("../../../plugins/base/syntax-highlight/manifest.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(plugin, "utf8")) as { version: string };
  const built = fileURLToPath(
    new URL(`../../../plugins/base/dist/syntax-highlight/${version}/frontend/languages/`, import.meta.url),
  );
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));

  await signIn(page, ADMIN);
  await waitSynced(page);
  await page.goto("/#/settings");
  await page.getByRole("link", { name: "Code languages" }).click();
  const form = page.getByRole("form", { name: "Add your own" });

  // A query written for another grammar does not fit this one: refused, nothing saved.
  await form.getByLabel("Name", { exact: true }).fill("Broken");
  await form.getByLabel("Grammar (.wasm)").setInputFiles(`${built}json/grammar.wasm`);
  await form.getByLabel("Highlights (.scm)").setInputFiles(`${built}rust/highlights.scm`);
  await form.getByRole("button", { name: "Add language" }).click();
  await expect(form.getByRole("alert")).toContainText("does not fit the grammar");
  await expect(page.locator(".lmsh-row").filter({ hasText: "Broken" })).toHaveCount(0);

  // The Rust grammar under a name of our own.
  await form.getByLabel("Name", { exact: true }).fill("Rusty");
  await form.getByLabel("Other names").fill("rsty");
  await form.getByLabel("Grammar (.wasm)").setInputFiles(`${built}rust/grammar.wasm`);
  await form.getByLabel("Highlights (.scm)").setInputFiles(`${built}rust/highlights.scm`);
  await form.getByRole("button", { name: "Add language" }).click();
  await expect(form.getByRole("status")).toContainText("Rusty is installed");
  const row = page.locator(".lmsh-row").filter({ hasText: "Rusty" });
  await expect(row).toContainText("yours");

  const id = await createDocument(request, baseURL as string, "---\ntitle: Mine\n---\n\n```rsty\nfn mine() {}\n```\n");
  await openDocument(page, id);
  await page.getByRole("tab", { name: "Read" }).click();
  const block = page.locator(".lmsh-block").filter({ hasText: "fn mine" });
  await expect(block.locator(".lmsh-keyword").first()).toHaveText("fn");
  await expect(block.getByRole("button")).toHaveCount(0);

  // Deleted: gone from the list, and the fence is plain again with nothing to offer.
  await page.goto("/#/settings");
  await page.getByRole("link", { name: "Code languages" }).click();
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  await openDocument(page, id);
  await page.getByRole("tab", { name: "Read" }).click();
  await expect(block).toBeVisible();
  await expect(block.locator(".lmsh-keyword")).toHaveCount(0);
  await expect(block.getByRole("button")).toHaveCount(0);

  expect(problems).toEqual([]);
});
