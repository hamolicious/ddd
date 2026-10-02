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
  arrive(values: Record<string, string>): void;
  preference(): ColorSchemePreference;
  scheme(): ColorScheme;
  appliedBackground(): string | undefined;
  offline(down: boolean): void;
  stored(key: string): string | undefined;
}

function fakeKernel(initial: Record<string, string> = {}): FakeKernel {
  const values = new Map(Object.entries(initial));
  let down = false;
  const settingsListeners = new Set<() => void>();
  const schemeListeners = new Set<(scheme: ColorScheme) => void>();
  let preference: ColorSchemePreference = "system";
  const systemScheme: ColorScheme = "light";
  let layers: { scheme: ColorScheme; tokens: Partial<ThemeTokens> }[] = [];

  const resolved = (): ColorScheme => (preference === "system" ? systemScheme : preference);

  const kernel = {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    settings: {
      get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
      set: async (key: string, value: unknown): Promise<void> => {
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
    const fake = fakeKernel();
    const controller = new ThemesController(fake.kernel, () => [MIDNIGHT]);
    controller.adoptStoredAppearance();
    controller.refresh();

    expect(fake.preference()).toBe("system");
    expect(fake.scheme()).toBe("light");

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

    void controller.setAppearance("light");
    expect(fake.preference()).toBe("light");

    fake.arrive({ themeDark: "midnight" });
    expect(fake.preference()).toBe("light");
  });

  describe("a choice made while the server is unreachable", () => {
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

      const second = new ThemesController(fake.kernel, () => [MIDNIGHT]);
      second.refresh();
      expect(second.selection.dark).toBe("midnight");
      expect(second.durable).toBe(false);

      fake.offline(false);
      await second.flushPending();
      expect(fake.stored("themeDark")).toBe("midnight");
      expect(second.durable).toBe(true);

      await second.select("midnight");
      expect(fake.stored("themeDark")).toBe("midnight");
      expect(second.durable).toBe(true);
    });

    it("still adopts the stored appearance after a failed write", async () => {
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
