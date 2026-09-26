/**
 * Pasting files into the editor (`editor.paste` → `attachments`) and showing them
 * (`markdown.attachment` → `attachments.viewer` → `native-preview`).
 *
 * The paste is a real `ClipboardEvent` (and the drop a real `DragEvent`) carrying real
 * `File`s, dispatched at CodeMirror's content element, so everything from the editor's
 * handler to the stored text runs as it does for a user.
 */

import { expect, test, type Page } from "@playwright/test";

import { ADMIN, createDocument, openDocument, rawText, signIn } from "./helpers.js";

/** A 1 × 1 transparent PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

interface Pasted {
  readonly name: string;
  readonly type: string;
  /** Base64 bytes, or plain text. */
  readonly base64?: string;
  readonly text?: string;
}

async function paste(page: Page, files: readonly Pasted[]): Promise<void> {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.evaluate((list) => {
    const transfer = new DataTransfer();
    for (const file of list) {
      const bytes = file.base64
        ? Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(file.text ?? "");
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    const target = document.querySelector(".cm-content");
    if (!target) throw new Error("no editor on the page");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, files);
}

async function edit(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
}

async function read(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Read" }).click();
}

test("a pasted screenshot is uploaded, embedded, and shown as an image", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  // Prose around it, or a heading plus one embed is a file document and `viewer` shows
  // the whole page as that file.
  const id = await createDocument(request, baseURL!, "# Pasted image\n\nToday's screenshot:\n\n");
  await openDocument(page, id);
  await edit(page);

  await paste(page, [{ name: "shot.png", type: "image/png", base64: PNG }]);
  await expect
    .poll(() => rawText(request, baseURL!, id), { timeout: 15_000 })
    .toMatch(/!\[shot\.png\]\(attachment:\/\/[0-9A-Z]{26}\)/);
  await expect(page.locator(".cm-content")).not.toContainText("Uploading");

  await read(page);
  const image = page.locator('img[alt="shot.png"]');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", /^blob:/);

  // The file's menu flips it to a link and back: one `!` each way.
  await image.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show as link" }).click();
  await expect
    .poll(() => rawText(request, baseURL!, id))
    .toMatch(/(?<!!)\[shot\.png\]\(attachment:\/\//);
  const chip = page.getByRole("button", { name: /shot\.png/ });
  await chip.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show as preview" }).click();
  await expect.poll(() => rawText(request, baseURL!, id)).toMatch(/!\[shot\.png\]\(attachment:\/\//);
  await expect(image).toBeVisible();
});

test("a PDF is a link by default, and two files land in order", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "# Pasted files\n\n");
  await openDocument(page, id);
  await edit(page);

  await paste(page, [
    { name: "first.pdf", type: "application/pdf", text: "%PDF-1.4\n%%EOF\n" },
    { name: "second.png", type: "image/png", base64: PNG },
  ]);
  await expect
    .poll(() => rawText(request, baseURL!, id), { timeout: 15_000 })
    .toMatch(/(?<!!)\[first\.pdf\]\(attachment:\/\/[0-9A-Z]{26}\)\n!\[second\.png\]\(attachment:\/\/[0-9A-Z]{26}\)/);
});

test("a type switched to Preview in settings is shown by its viewer", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  await page.goto("/#/settings/attachments");
  const txt = page.getByRole("radiogroup", { name: "Pasted .txt files" });
  await txt.getByRole("radio", { name: "Preview" }).click();
  await expect(txt.getByRole("radio", { name: "Preview" })).toHaveAttribute("aria-checked", "true");
  // More than one viewer never claims .txt in the base distribution.
  await expect(page.getByText("Shown with Browser: plain text").first()).toBeVisible();

  const id = await createDocument(request, baseURL!, "# Pasted text\n\n");
  await openDocument(page, id);
  await edit(page);
  await paste(page, [{ name: "notes.txt", type: "text/plain", text: "milk, eggs, bread" }]);
  await expect
    .poll(() => rawText(request, baseURL!, id), { timeout: 15_000 })
    .toMatch(/!\[notes\.txt\]\(attachment:\/\//);

  await read(page);
  await expect(page.getByLabel("notes.txt")).toHaveText("milk, eggs, bread");
});

test("a dropped file lands where it was dropped", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "# Dropped\n\nfirst line\n\nlast line\n");
  await openDocument(page, id);
  await edit(page);

  const line = page.locator(".cm-line", { hasText: "first line" });
  const box = (await line.boundingBox())!;
  await page.evaluate(
    ({ x, y, png }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "drop.png", { type: "image/png" }));
      document
        .querySelector(".cm-content")!
        .dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    { x: box.x + box.width - 2, y: box.y + box.height / 2, png: PNG },
  );
  await expect
    .poll(() => rawText(request, baseURL!, id), { timeout: 15_000 })
    .toMatch(/first line!\[drop\.png\]\(attachment:\/\/[0-9A-Z]{26}\)\n\nlast line/);
});

test("promoting an embed replaces it with a link to the new document", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "# Promote\n\nThe scan:\n\n");
  await openDocument(page, id);
  await edit(page);
  await paste(page, [{ name: "scan.png", type: "image/png", base64: PNG }]);
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 15_000 }).toMatch(/attachment:\/\//);

  await read(page);
  await page.locator('img[alt="scan.png"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Promote to document" }).click();

  await expect.poll(() => rawText(request, baseURL!, id)).toMatch(/(?<!!)\[scan\.png\]\(doc:\/\/[0-9A-Z]{26}\)/);
  const promoted = /doc:\/\/([0-9A-Z]{26})/.exec(await rawText(request, baseURL!, id))![1]!;
  expect(await rawText(request, baseURL!, promoted)).toMatch(/!\[scan\.png\]\(attachment:\/\//);
  await expect(page).toHaveURL(new RegExp(`#/doc/${promoted}`));
});
