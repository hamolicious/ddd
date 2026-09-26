/**
 * Safe mode, exercised the way it is meant to be reached: **after a plugin breaks**.
 *
 * SPEC §6.1 states the trust model plainly — installing a plugin runs its code
 * unsandboxed in every user's session — and names the recovery paths. A test that
 * only checks `?safe=1` renders something proves the flag parses. This one breaks a
 * real installed plugin on disk, shows that a normal boot degrades instead of dying
 * (SPEC §6.4: the failure is scoped, dependents are skipped, one aggregated notice),
 * shows that `?safe=1` boots past it because the broken plugin is not part of the
 * base distribution, shows `?safe=bare` reaching the kernel's own manager, and then
 * puts the file back and proves the app recovers.
 *
 * **Every navigation is in a fresh `BrowserContext`.** Plugin URLs are version-scoped
 * and served `immutable` (SPEC §8), so a context that already loaded `1.0.0` will keep
 * serving it from its HTTP cache no matter what changed on disk. A fresh context is a
 * fresh cache, and it is also the only honest simulation of "another user opens the
 * app after the plugin broke".
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser } from "@playwright/test";

import { ADMIN, signIn } from "./helpers.js";

/**
 * The registry directory the E2E server serves. `server.mjs` composes it, and the
 * default location is the one thing both files have to agree on.
 */
const registry =
  process.env["LM_E2E_PLUGINS"] ?? join(process.cwd(), "app", "e2e", ".plugins", "default");
const brokenModule = join(registry, "extra-task-states", "1.0.0", "frontend", "index.mjs");

/** A module whose `activate` throws — the SPEC §6.4 failure the loader must contain. */
const SABOTAGE = `export default function activate() {
  throw new Error("extra-task-states: deliberately broken by the E2E suite");
}
`;

/**
 * A module that activates cleanly and then throws **while rendering**.
 *
 * The two failures are not the same containment problem. An `activate()` throw is the
 * loader's: it marks the plugin failed and skips its dependents. A render throw is React's,
 * and React 18's answer to an uncaught one is to unmount the whole root — a white page with
 * no notice strip, no in-place chip and not even the safe-mode links, so the only way out is
 * knowing to type a query string by hand.
 *
 * It contributes both shapes that have to be covered: a `component` (which `shell-ui` wraps
 * in `kernel.ui.boundary`) and an `icon`, which is a `ReactNode` and therefore *cannot* be
 * wrapped as a component — the case that was rendered bare, outside every boundary.
 */
const RENDER_SABOTAGE = `import { createElement } from "react";

const Boom = () => {
  throw new Error("extra-task-states: deliberately thrown while rendering");
};

export default function activate(kernel) {
  kernel.extensions.contribute("navbar.item", {
    id: "extra-task-states.broken-icon",
    label: "Broken icon",
    side: "end",
    // \`shell-ui\` renders an item's icon only inside the actionable form, so the item
    // needs an \`onSelect\` for this to be the case under test at all.
    onSelect: () => undefined,
    icon: createElement(Boom),
  });
  kernel.extensions.contribute("sidebar.panel", {
    id: "extra-task-states.broken-panel",
    title: "Broken panel",
    component: Boom,
  });
  return {};
}
`;

let original: string;

test.beforeAll(() => {
  original = readFileSync(brokenModule, "utf8");
});

test.afterAll(() => {
  // Restoring in `afterAll` rather than at the end of the last test: a failure
  // mid-suite must not leave a sabotaged plugin in the registry for the next run.
  writeFileSync(brokenModule, original);
});

async function freshPage(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  return { context, page: await context.newPage() };
}

test("a broken plugin fails alone, and safe mode boots past it", async ({ browser, baseURL }) => {
  const base = baseURL as string;

  // --- 1. Sabotage, then boot normally. -----------------------------------------
  writeFileSync(brokenModule, SABOTAGE);

  {
    const { context, page } = await freshPage(browser, base);
    try {
      await signIn(page, ADMIN);

      // The app is alive: the shell, the list and the welcome documents are all there.
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("button", { name: "Welcome to Life Manager", exact: true })).toBeVisible();

      // And it says so: **one aggregated notice**, not one per plugin (SPEC §6.4),
      // with a route to admin.
      const notice = page.getByText(/1 plugin failed to load/i).first();
      await expect(notice).toBeVisible();
      await expect(page.getByRole("button", { name: /open admin/i }).first()).toBeVisible();

      // **Once**, not twice. The kernel's frame and `shell-ui`'s bell both render
      // `host.notices`, and for a while both did it at the same time: the same sentence
      // in a strip across the top and again behind the bell, dismissable in two places
      // and reappearing from the other. The kernel's strip now stands down whenever a
      // shell holds the mount, and this count is what says so.
      await expect(page.getByText(/1 plugin failed to load/i)).toHaveCount(1);

      // The plugin's name and the thrown message are behind the notice's disclosure —
      // the summary counts, the detail diagnoses.
      //
      // The `li` is reached by walking **up** from the message rather than by filtering
      // `li`s that contain it, and that is not a style preference: `shell-ui` renders
      // its navbar as a list, so `li:has(text)` matches the navbar item *and* the notice
      // row, document order puts the outer one first, and `.first()` then reached past
      // the notice into whichever disclosure the panel happened to render first. The
      // nearest ancestor is the notice, in the kernel's own strip and in the shell's
      // panel alike.
      const details = page
        .getByText(/1 plugin failed to load/i)
        .first()
        .locator("xpath=ancestor::li[1]")
        .locator("details");
      await details.first().evaluate((element: HTMLDetailsElement) => {
        element.open = true;
      });
      await expect(details.first()).toContainText("extra-task-states");
      await expect(details.first()).toContainText("deliberately broken");
    } finally {
      await context.close();
    }
  }

  // --- 2. `?safe=1` — base distribution only. -----------------------------------
  {
    const { context, page } = await freshPage(browser, base);
    try {
      await signIn(page, ADMIN, { path: "/?safe=1" });
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("button", { name: "Welcome to Life Manager", exact: true })).toBeVisible();
      // The broken plugin is not base, so it was never imported and there is nothing
      // to report: no failure notice at all.
      await expect(page.getByText(/plugin[s]? failed to load/i)).toHaveCount(0);
      await expect(page.getByText(/extra-task-states/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  }

  // --- 3. `?safe=bare` — no plugins at all, the kernel's own manager. -----------
  {
    const { context, page } = await freshPage(browser, base);
    try {
      // Deny storage persistence, so the boot sequence raises a notice *before* the bare
      // manager takes the mount (SPEC §6.4). It is the cheapest deterministic stand-in for
      // the three that reach this screen that way — the storage warning, the plugin-list
      // failure, and the update notice whose only `Reload` button lives in its actions.
      await page.addInitScript(() => {
        const storage = navigator.storage as unknown as Record<string, unknown>;
        storage["persist"] = () => Promise.resolve(false);
        storage["persisted"] = () => Promise.resolve(false);
      });
      await page.goto("/?safe=bare");
      // Still needs a session, but no plugins at all — so `signIn`'s waits do not
      // apply: there is no shell and no loader line. The gate is the same one.
      await page.locator("#email").fill(ADMIN.email);
      await page.locator("#password").fill(ADMIN.password);
      await page.locator("form.lm-auth-form button[type=submit]").click();

      // The floor: no `shell-ui`, so no banner. What has to be there is a list of the
      // installed plugins and a way back — this is what someone types into a URL bar
      // when even a base plugin is the problem (SPEC §6.1).
      await expect(page.getByText(/safe mode|plugin manager/i).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator(".lm-bare")).toBeVisible();
      await expect(page.getByText("shell-ui").first()).toBeVisible();
      await expect(page.getByText("extra-task-states").first()).toBeVisible();
      // `shell-ui` itself did not run — its layout root is what proves that. (The bare
      // manager has a `<header>` of its own, so the `banner` landmark is not the tell.)
      await expect(page.locator(".shell-root")).toHaveCount(0);
      await expect(page.locator(".doclist")).toHaveCount(0);

      // **And the kernel's notice strip is still on screen.** The strip stands down while
      // a *shell* holds the mount, because the shell's bell draws the same list — but here
      // the kernel itself holds it, `BareManager` has no notice UI, and no plugin loaded
      // that could give it one. Keying that dedupe on "something holds the mount" blanked
      // every notice on the one screen SPEC §6.1 calls the recovery path.
      await expect(page.locator(".lm-notices")).toBeVisible();
      await expect(page.getByText(/may delete this workspace's offline copy/i)).toBeVisible();
    } finally {
      await context.close();
    }
  }

  // --- 4. Unbreak it. -----------------------------------------------------------
  writeFileSync(brokenModule, original);

  {
    const { context, page } = await freshPage(browser, base);
    try {
      await signIn(page, ADMIN);
      await expect(page.getByRole("button", { name: "Welcome to Life Manager", exact: true })).toBeVisible();
      // No failure notice any more — the recovery needed nothing but the file.
      await expect(page.getByText(/plugin[s]? failed to load/i)).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

test("a plugin that throws while rendering costs a chip, not the application", async ({
  browser,
  baseURL,
}) => {
  const base = baseURL as string;
  writeFileSync(brokenModule, RENDER_SABOTAGE);
  const { context, page } = await freshPage(browser, base);
  try {
    await signIn(page, ADMIN);

    // The application is still there. This is the whole assertion: before the mount and
    // the contributed `icon` were wrapped, one throw here unmounted the React root and
    // `#root` was empty — no shell, no notice strip, no way out.
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("button", { name: "Welcome to Life Manager", exact: true })).toBeVisible();

    // Two in-place chips: one for the panel component, one for the icon — the icon being
    // the case no `boundary(component)` call could reach, because a `ReactNode` is not a
    // component.
    const chips = page.locator(".lm-plugin-failed");
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toContainText("extra-task-states");

    // And it is reported where a user can see it, not only in the console (SPEC §6.4:
    // validation and render failures "reject loudly").
    const notice = page.getByText(/plugin problem/i).first();
    await expect(notice).toBeVisible();
    await expect(page.getByRole("button", { name: /open admin/i }).first()).toBeVisible();
  } finally {
    await context.close();
    writeFileSync(brokenModule, original);
  }
});
