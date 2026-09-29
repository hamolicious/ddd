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

test("an upload still lands when the keyboard rewrote its placeholder line with the same text", async ({ page, request, baseURL }) => {
  // Android's keyboard (Chrome reconciling the IME's DOM changes) replaces a line with
  // identical text often enough: the characters look the same and are new ones, so the
  // editor's handle on the placeholder loses them. The upload must still find it.
  const id = await createDocument(request, baseURL as string, "# Phone\n\n");
  await signIn(page, ADMIN);
  await openDocument(page, id);
  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page.locator(".cm-content")).toContainText("Phone");

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/uploads/*/complete", async (route) => {
    await held;
    await route.continue();
  });

  await paste(page, [
    { name: "one.png", type: "image/png", base64: PNG },
    { name: "two.png", type: "image/png", base64: PNG },
  ]);
  await expect(page.locator(".cm-content")).toContainText(/Uploading two\.png…/);

  // Rewrite every placeholder line with exactly the text it already has.
  await page.locator(".cm-content").evaluate((content) => {
    type View = {
      state: { doc: { lines: number; line(n: number): { from: number; to: number; text: string } } };
      dispatch(spec: unknown): void;
    };
    // `EditorView.findFromDOM`, without importing CodeMirror into the page.
    const view = (content as unknown as { cmTile?: { root?: { view?: View } } }).cmTile?.root?.view;
    if (!view) throw new Error("no CodeMirror view on .cm-content");
    for (let n = 1; n <= view.state.doc.lines; n += 1) {
      const line = view.state.doc.line(n);
      if (!line.text.includes("Uploading")) continue;
      view.dispatch({ changes: { from: line.from, to: line.to, insert: line.text }, userEvent: "input.type" });
    }
  });
  release();

  for (const name of ["one", "two"]) {
    await expect
      .poll(() => rawText(request, baseURL as string, id), { timeout: 20_000 })
      .toMatch(new RegExp(`!\\[${name}\\.png\\]\\(attachment://[0-9A-Z]{26}\\)`));
  }
  expect(await rawText(request, baseURL as string, id)).not.toContain("Uploading");
  await expect(page.getByText(/placeholder was changed/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Chunked uploads: interrupted, paused, reloaded — and carried on, not restarted
// ---------------------------------------------------------------------------

/** A file big enough for three chunks (a chunk is just under 4 MiB). */
const BIG_BYTES = 9 * 1024 * 1024;

async function pasteBig(page: Page, name: string): Promise<void> {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.evaluate(
    ({ name, size }) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: "application/octet-stream" }));
      document
        .querySelector(".cm-content")
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    },
    { name, size: BIG_BYTES },
  );
}

/** Every chunk the page sends, by offset. */
function chunksSent(page: Page): Map<number, number> {
  const sent = new Map<number, number>();
  page.on("request", (request) => {
    if (request.method() !== "PATCH") return;
    const offset = new URL(request.url()).searchParams.get("offset");
    if (offset === null || !request.url().includes("/api/uploads/")) return;
    sent.set(Number(offset), (sent.get(Number(offset)) ?? 0) + 1);
  });
  return sent;
}

/** The first chunk after the first one: held until `release`, then passed or failed. */
function holdSecondChunk(page: Page): { reached: Promise<void>; release: (how: "continue" | "abort") => void } {
  let reached!: () => void;
  let release!: (how: "continue" | "abort") => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const decided = new Promise<"continue" | "abort">((resolve) => (release = resolve));
  let held = false;
  void page.route("**/api/uploads/*?offset=*", async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    if (held || offset === 0) return route.continue();
    held = true;
    reached();
    const how = await decided;
    await (how === "abort" ? route.abort("failed") : route.continue()).catch(() => undefined);
  });
  return { reached: arrived, release };
}

/** The notice panel, opened: progress notices leave it closed. */
async function notices(page: Page) {
  const bell = page.locator(".notices-bell");
  if ((await bell.getAttribute("aria-expanded")) !== "true") await bell.click();
  return page.getByRole("group", { name: "Notices" });
}

const uploaded = (name: string): RegExp => new RegExp(`\\[${name.replace(".", "\\.")}\\]\\(attachment://[0-9A-Z]{26}\\)`);

test("an upload shows its progress, where it goes and the time left, and carries on after a dropped chunk", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "---\ntitle: Tax return\n---\n\nThe scan:\n\n");
  await openDocument(page, id);
  await edit(page);
  const sent = chunksSent(page);
  const hold = holdSecondChunk(page);

  await pasteBig(page, "scan.bin");
  await hold.reached;

  // The notice: what, where, how far, how long, and what can be done about it. It does
  // not open the panel over the editor by itself; the bell carries a bar instead.
  await expect(page.getByRole("group", { name: "Notices" })).toBeHidden();
  const notice = (await notices(page)).locator("li", { hasText: "scan.bin" });
  await expect(notice).toContainText("Uploading scan.bin to “Tax return”");
  const bar = notice.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "44");
  await expect(bar).toContainText(/4\.2 MB of 9\.4 MB · (.* left|working out time left…)/);
  await expect(notice.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Open" })).toBeVisible();

  // The connection drops mid-chunk: the upload waits, then carries on from that chunk.
  hold.release("abort");
  await expect(notice).toContainText("Waiting for a connection: scan.bin");
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 30_000 }).toMatch(uploaded("scan.bin"));
  expect(sent.get(0), "the first chunk went once").toBe(1);
  await expect(page.getByText(/could not be uploaded/)).toHaveCount(0);
});

test("an upload paused from its notice stops, and resumed carries on where it stopped", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "# Paused upload\n\nHere:\n\n");
  await openDocument(page, id);
  await edit(page);
  const sent = chunksSent(page);
  const hold = holdSecondChunk(page);

  await pasteBig(page, "pause.bin");
  await hold.reached;
  const notice = (await notices(page)).locator("li", { hasText: "pause.bin" });
  await notice.getByRole("button", { name: "Pause" }).click();
  hold.release("continue");
  await expect(notice).toContainText("Paused: pause.bin");
  await expect(notice.getByRole("progressbar")).toContainText("paused");

  // Paused means paused: nothing goes in while it is.
  await page.waitForTimeout(1_500);
  expect(await rawText(request, baseURL!, id)).toContain("Uploading pause.bin…");

  await notice.getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 30_000 }).toMatch(uploaded("pause.bin"));
  expect(sent.get(0)).toBe(1);
});

test("an upload cut off by a reload carries on after it", async ({ page, request, baseURL }) => {
  await signIn(page, ADMIN);
  const id = await createDocument(request, baseURL!, "# Reloaded upload\n\nHere:\n\n");
  await openDocument(page, id);
  await edit(page);
  const sent = chunksSent(page);
  const hold = holdSecondChunk(page);

  await pasteBig(page, "reload.bin");
  await hold.reached;
  // The placeholder has to be on the server before the reload, or there is nothing to
  // swap the file into.
  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 15_000 }).toContain("Uploading reload.bin…");
  await page.reload();
  hold.release("abort");

  await expect.poll(() => rawText(request, baseURL!, id), { timeout: 30_000 }).toMatch(uploaded("reload.bin"));
  expect(sent.get(0), "the chunk the server had was not sent again").toBe(1);
});
