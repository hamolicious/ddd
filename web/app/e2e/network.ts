import { expect, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

import { waitSynced } from "./helpers.js";

export async function network(page: Page, context: BrowserContext) {
  let refuse = false;
  const live = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/api\/sync/, (ws) => {
    if (refuse) {
      void ws.close({ code: 1006 }).catch(() => undefined);
      return;
    }
    live.add(ws);
    ws.connectToServer();
  });
  return {
    async offline(): Promise<number> {
      refuse = true;
      const cut = Date.now();
      await context.setOffline(true);
      for (const ws of live) await ws.close({ code: 1006 }).catch(() => undefined);
      live.clear();
      await expect(page.getByRole("button", { name: "Offline. Reconnect" })).toBeVisible({ timeout: 60_000 });
      const noticed = Date.now() - cut;
      console.log(`[offline] the app showed offline after ${noticed} ms`);
      return noticed;
    },
    async release(): Promise<void> {
      refuse = false;
      await context.setOffline(false);
    },
    async online(): Promise<void> {
      refuse = false;
      await context.setOffline(false);
      const reconnect = page.getByRole("button", { name: "Offline. Reconnect" });
      if (await reconnect.isVisible()) await reconnect.click({ timeout: 2_000 }).catch(() => undefined);
      await waitSynced(page);
    },
  };
}

export async function workerInControl(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload();
    await waitSynced(page);
  }
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

export async function typeAtEnd(page: Page, text: string): Promise<void> {
  const edit = page.getByRole("tab", { name: /^Edit/ });
  if ((await edit.getAttribute("aria-selected")) !== "true") await edit.click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

export async function typeAfter(page: Page, after: string, text: string): Promise<void> {
  const edit = page.getByRole("tab", { name: /^Edit/ });
  if ((await edit.getAttribute("aria-selected")) !== "true") await edit.click();
  await page.locator(".cm-line", { hasText: after }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}
