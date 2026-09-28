/**
 * Hot-plugging leaves nothing behind (PLUGIN-PROTOCOLS §9 step 6): unplug every base plugin
 * and plug it back in, 100 times each, in one session, through the same resolver and
 * runtime a wiring change uses — then the kernel holds exactly what it held before: the
 * same subscriptions per plugin, slot items, services, listeners, stylesheet links and
 * mount, and every plugin active again.
 *
 * Driven through `window.__lmTest` (`app/src/boot/test-hooks.ts`), which the app installs
 * only when `localStorage["lm:test-hooks"]` is `"1"`.
 */

import { expect, test, type Page } from "@playwright/test";

import { ADMIN, pluginsActivated, signIn } from "./helpers.js";

const TIMES = Number(process.env["LM_HOT_PLUG_TIMES"] ?? 100);

interface Resources {
  readonly held: Record<string, number>;
  readonly ports: Record<string, number>;
  readonly links: number;
  readonly mountHolder: string | undefined;
  readonly notices: number;
  readonly active: readonly string[];
}

const resources = (page: Page): Promise<Resources> =>
  page.evaluate(() => (globalThis as unknown as { __lmTest: { resources(): Resources } }).__lmTest.resources());

test("unplugging and plugging back every base plugin leaves nothing behind", async ({ page, request, baseURL }) => {
  test.setTimeout(45 * 60_000);
  // Run on its own, the workspace may have no users yet.
  const bootstrap = await request.get(`${baseURL}/api/auth/bootstrap`);
  if (bootstrap.ok() && ((await bootstrap.json()) as { needs_first_user?: boolean }).needs_first_user) {
    await request.post(`${baseURL}/api/auth/register`, { data: ADMIN });
  }
  await signIn(page, ADMIN);
  await page.evaluate(() => localStorage.setItem("lm:test-hooks", "1"));
  const loaded = pluginsActivated(page);
  await page.reload();
  await loaded;
  await expect.poll(() => page.evaluate(() => "__lmTest" in globalThis)).toBe(true);

  // Plugins open some of their subscriptions asynchronously (a `documents.subscribe`
  // resolving after activation), and on a populated workspace that takes longer than the
  // activation itself. The baseline is the settled state: the same counts three reads in a
  // row, half a second apart, so a late subscription is not mistaken for a leak.
  let before = await resources(page);
  for (let stable = 0; stable < 3; ) {
    await page.waitForTimeout(500);
    const now = await resources(page);
    if (JSON.stringify(now) === JSON.stringify(before)) stable += 1;
    else {
      before = now;
      stable = 0;
    }
  }
  expect(before.active.length).toBeGreaterThan(20);
  expect(before.mountHolder).toBe("shell-ui");

  for (const id of before.active) {
    await page.evaluate(
      ([plugin, times]) =>
        (globalThis as unknown as { __lmTest: { cycle(id: string, times: number): Promise<void> } }).__lmTest.cycle(
          plugin as string,
          times as number,
        ),
      [id, TIMES] as const,
    );
    // Restarted plugins open some of their subscriptions asynchronously; give them a
    // moment to settle, then the counts must be exactly what they were.
    await expect.poll(() => resources(page), { message: `after cycling ${id} ${TIMES} times`, timeout: 15_000 }).toEqual(before);
  }

  // And the app still works: the shell is on screen and a view renders.
  await expect(page.locator("main")).toBeVisible();
});
