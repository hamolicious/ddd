/**
 * The controller's **late settings** behaviour.
 *
 * `apply.test.ts` covers what a theme paints. This file covers when: settings live in
 * a per-user document that replicates, so on a cold client it can arrive *after* this
 * plugin activates — `kernel.settings.start()` waits for the first local query, not
 * for the workspace bootstrap to finish. Everything the controller reads at activation
 * therefore has to be re-readable on a settings change, and the appearance preference
 * was the one that was not: the theme came back on a new device and the light/dark
 * choice silently did not, leaving a dark theme unused behind a light appearance.
 *
 * The fake kernel here is deliberately the smallest thing that can express that: a
 * settings store whose contents *appear later*, and a colour-scheme preference the
 * controller is supposed to push into.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_NAMES,
  type ColorScheme,
  type ColorSchemePreference,
  type Kernel,
  type ThemeTokens,
  type Unsubscribe,
} from "@kernel";

import type { Theme } from "./api.js";

import { ThemesController } from "./controller.js";

const MIDNIGHT: Theme = {
  id: "midnight",
  name: "Midnight",
  scheme: "dark",
  tokens: { "--ddd-bg": "#0d1117" },
};

interface FakeKernel {
  readonly kernel: Kernel;
  /** Write a settings value the way a replicated document would: quietly, then notify. */
  arrive(values: Record<string, string>): void;
  preference(): ColorSchemePreference;
  scheme(): ColorScheme;
  appliedBackground(): string | undefined;
  /** Simulate being offline: `settings.set` rejects the way it really does. */
  offline(down: boolean): void;
  stored(key: string): string | undefined;
}

function fakeKernel(initial: Record<string, string> = {}): FakeKernel {
  const values = new Map(Object.entries(initial));
  let down = false;
  const settingsListeners = new Set<() => void>();
  const schemeListeners = new Set<(scheme: ColorScheme) => void>();
  let preference: ColorSchemePreference = "system";
  /** The device's own setting, which `system` resolves to. Light, as a fresh profile is. */
  const systemScheme: ColorScheme = "light";
  let layers: { scheme: ColorScheme; tokens: Partial<ThemeTokens> }[] = [];

  const resolved = (): ColorScheme => (preference === "system" ? systemScheme : preference);

  const kernel = {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    settings: {
      get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
      set: async (key: string, value: unknown): Promise<void> => {
        // Offline this is not a hypothetical: with no settings document yet the write
        // goes through `documents.create` (REST), and with one it has to hydrate a
        // document this client may never have opened.
        if (down) throw new TypeError("Failed to fetch");
        values.set(key, String(value));
        for (const listener of [...settingsListeners]) listener();
      },
      remove: async (): Promise<void> => {},
      subscribe: (listener: () => void): Unsubscribe => {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
      },
      defineSchema: () => {},
    },
    ui: {
      get colorScheme(): ColorScheme {
        return resolved();
      },
      colorSchemePreference: (): ColorSchemePreference => preference,
      setColorSchemePreference: (next: ColorSchemePreference): void => {
        const before = resolved();
        preference = next;
        if (resolved() === before) return;
        for (const listener of [...schemeListeners]) listener(resolved());
      },
      onColorScheme: (listener: (scheme: ColorScheme) => void): Unsubscribe => {
        schemeListeners.add(listener);
        return () => schemeListeners.delete(listener);
      },
      tokens: {
        names: THEME_TOKEN_NAMES,
        defaults: (scheme: ColorScheme): ThemeTokens =>
          scheme === "dark" ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS,
        current: (): ThemeTokens => DEFAULT_LIGHT_TOKENS,
        apply: (scheme: ColorScheme, tokens: Partial<ThemeTokens>): Unsubscribe => {
          const layer = { scheme, tokens };
          layers.push(layer);
          return () => {
            layers = layers.filter((candidate) => candidate !== layer);
          };
        },
        reset: (): void => {
          layers = [];
        },
      },
    },
  } as unknown as Kernel;

  return {
    kernel,
    arrive: (next) => {
      for (const [key, value] of Object.entries(next)) values.set(key, value);
      for (const listener of [...settingsListeners]) listener();
    },
    preference: () => preference,
    scheme: () => resolved(),
    offline: (next) => {
      down = next;
    },
    stored: (key) => values.get(key),
    appliedBackground: () =>
      layers.filter((layer) => layer.scheme === resolved()).at(-1)?.tokens["--ddd-bg"],
  };
}

describe("ThemesController", () => {
  it("adopts the stored appearance at activation when settings are already there", () => {
    const fake = fakeKernel({ colorScheme: "dark", themeDark: "midnight" });
    const controller = new ThemesController(fake.kernel, () => [MIDNIGHT]);

    controller.adoptStoredAppearance();
    controller.refresh();

    expect(fake.preference()).toBe("dark");
    expect(fake.appliedBackground()).toBe("#0d1117");
  });

  it("adopts a stored appearance that arrives after activation", () => {
    // The cold-client order: activate against an empty settings store, then the
    // per-user document replicates in.
    const fake = fakeKernel();
    const controller = new ThemesController(fake.kernel, () => [MIDNIGHT]);
    controller.adoptStoredAppearance();
    controller.refresh();

    expect(fake.preference()).toBe("system");
    expect(fake.scheme()).toBe("light");

    // This is the wiring `themes`' `activate()` installs: a settings change calls
    // `reload()`.
    fake.kernel.settings.subscribe(() => controller.reload());
    fake.arrive({ colorScheme: "dark", themeDark: "midnight" });

    expect(fake.preference(), "the stored appearance has to be adopted, not only the theme").toBe(
      "dark",
    );
    expect(fake.appliedBackground()).toBe("#0d1117");
  });

  it("leaves an appearance the user has already chosen on this device alone", () => {
    const fake = fakeKernel();
    const controller = new ThemesController(fake.kernel, () => [MIDNIGHT]);
    fake.kernel.settings.subscribe(() => controller.reload());

    // The user picks light here; the settings document still says dark from another
    // device. Adoption must not fight a deliberate local choice made *after* it, so
    // the write goes through the controller and the stored value follows.
    void controller.setAppearance("light");
    expect(fake.preference()).toBe("light");

    fake.arrive({ themeDark: "midnight" });
    expect(fake.preference()).toBe("light");
  });

  describe("a choice made while the server is unreachable", () => {
    /**
     * The suite runs on `node` (`web/vite.config.ts`), where there is no web storage —
     * `prefs.ts` catches that and simply has no fallback, which is correct in production
     * and useless here, because the device-local half is exactly what is under test. So
     * the minimum `Storage` surface it uses, in memory.
     */
    beforeEach(() => {
      const entries = new Map<string, string>();
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => void entries.set(key, value),
        removeItem: (key: string) => void entries.delete(key),
        clear: () => entries.clear(),
      };
    });

    afterEach(() => {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    it("survives a reload and syncs when sync returns, instead of being reverted", async () => {
      // The workspace already carries an older choice from another device. The user goes
      // offline and picks a different one: the write cannot land, so it is kept on the
      // device *and remembered as unsent*. Nothing about that may demote the store —
      // which is what used to happen, and it made the next reload silently restore the
      // stale synced value.
      const fake = fakeKernel({ themeDark: "warm-night", colorScheme: "dark" });
      const first = new ThemesController(fake.kernel, () => [MIDNIGHT]);
      first.adoptStoredAppearance();
      first.refresh();

      fake.offline(true);
      await first.select("midnight");

      expect(first.selection.dark).toBe("midnight");
      expect(first.durable, "the store knows the value has not reached settings").toBe(false);
      expect(fake.stored("themeDark"), "the settings document still holds the old value").toBe(
        "warm-night",
      );

      // The reload: a brand-new controller over the same device and the same (stale)
      // settings document. The user's choice has to win.
      const second = new ThemesController(fake.kernel, () => [MIDNIGHT]);
      second.refresh();
      expect(second.selection.dark).toBe("midnight");
      expect(second.durable).toBe(false);

      // Sync comes back: the pending write lands on its own and the device copy goes.
      fake.offline(false);
      await second.flushPending();
      expect(fake.stored("themeDark")).toBe("midnight");
      expect(second.durable).toBe(true);

      // And a later choice goes straight to settings — the failure was per write, not a
      // session-long demotion.
      await second.select("midnight");
      expect(fake.stored("themeDark")).toBe("midnight");
      expect(second.durable).toBe(true);
    });

    it("still adopts the stored appearance after a failed write", async () => {
      // `adoptStoredAppearance` used to return early whenever the store had been
      // demoted, so one offline moment meant the light/dark choice was ignored for the
      // rest of the session while the theme was honoured — a dark theme sitting unused
      // behind a light appearance.
      const fake = fakeKernel();
      const controller = new ThemesController(fake.kernel, () => [MIDNIGHT]);
      fake.offline(true);
      await controller.select("midnight");
      expect(controller.durable).toBe(false);

      fake.kernel.settings.subscribe(() => controller.reload());
      fake.offline(false);
      fake.arrive({ colorScheme: "dark" });

      expect(fake.preference()).toBe("dark");
      expect(fake.appliedBackground()).toBe("#0d1117");
    });
  });
});
