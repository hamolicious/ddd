/**
 * The settings screen lists sections in the **seat order** its `sections` host hands it
 * (PLUGIN-PROTOCOLS §6a: hosts stop sorting). The host here is seated against the items'
 * own `order` hints, so a view that went back to sorting by `order` would fail this.
 *
 * Rendered to static markup: no DOM is needed to read the navigation list, and effects
 * (the base-plugin fetch) do not run.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Kernel, SlotHost, SlotItem } from "@kernel";
import type { SettingsSection } from "@protocols/lm/settings.section";

import { SettingsView } from "./SettingsView.js";

const section = (pluginId: string, id: string, order: number): SlotItem<SettingsSection> => ({
  pluginId,
  port: "settings",
  value: { id, title: id, order, component: () => null },
});

const host = (items: readonly SlotItem<SettingsSection>[]): SlotHost<SettingsSection> => ({
  get: () => items.map((item) => item.value),
  entries: () => items,
  subscribe: () => () => undefined,
});

const kernel = {
  ui: { boundary: (component: unknown) => component },
  session: { fetch: async () => ({ ok: false }) },
} as unknown as Kernel;

const router = { navigate: () => undefined, url: (path: string) => `#${path}` };

const titles = (html: string): string[] => [...html.matchAll(/settings-nav-link[^>]*>([^<]+)</g)].map((m) => m[1] ?? "");

describe("SettingsView", () => {
  it("lists sections in the host's seat order, not by their `order` hint", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        kernel={kernel}
        router={router}
        sections={host([section("themes", "appearance", 10), section("settings", "account", 0), section("folders", "folders", 30)])}
      />,
    );
    expect(titles(html)).toEqual(["appearance", "account", "folders"]);
  });

  it("opens the section the URL names, and the first seated one otherwise", () => {
    const items = [section("themes", "appearance", 10), section("settings", "account", 0)];
    const named = renderToStaticMarkup(
      <SettingsView kernel={kernel} router={router} sections={host(items)} params={{ section: "account" }} />,
    );
    expect(named).toContain('aria-labelledby="settings-account"');
    const first = renderToStaticMarkup(<SettingsView kernel={kernel} router={router} sections={host(items)} />);
    expect(first).toContain('aria-labelledby="settings-appearance"');
  });
});
