/**
 * The settings screen lists sections in the order its registry hands them over: by each
 * section's `order`, then by when it was added.
 *
 * Rendered to static markup: no DOM is needed to read the navigation list, and effects
 * (the base-plugin fetch) do not run.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createRegistry, type Kernel, type Registry } from "@kernel";

import type { SettingsSection } from "./sections.js";
import { SettingsView } from "./SettingsView.js";

const section = (id: string, order?: number): SettingsSection => ({
  id,
  title: id,
  ...(order !== undefined ? { order } : {}),
  component: () => null,
});

const host = (items: readonly SettingsSection[]): Registry<SettingsSection> => {
  const registry = createRegistry<SettingsSection>({ key: (s) => s.id, order: (s) => s.order ?? 100 });
  registry.add(items);
  return registry;
};

const kernel = {
  ui: { boundary: (component: unknown) => component },
  session: { fetch: async () => ({ ok: false }) },
} as unknown as Kernel;

const router = { navigate: () => undefined, url: (path: string) => `#${path}` };

const titles = (html: string): string[] => [...html.matchAll(/settings-nav-link[^>]*>([^<]+)</g)].map((m) => m[1] ?? "");

describe("SettingsView", () => {
  it("lists sections by their `order`, then in the order they were added", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        kernel={kernel}
        router={router}
        sections={host([section("zeta"), section("appearance", 10), section("account", 0), section("folders", 30)])}
      />,
    );
    expect(titles(html)).toEqual(["account", "appearance", "folders", "zeta"]);
  });

  it("opens the section the URL names, and the first listed one otherwise", () => {
    const items = [section("appearance", 0), section("account", 10)];
    const named = renderToStaticMarkup(
      <SettingsView kernel={kernel} router={router} sections={host(items)} params={{ section: "account" }} />,
    );
    expect(named).toContain('aria-labelledby="settings-account"');
    const first = renderToStaticMarkup(<SettingsView kernel={kernel} router={router} sections={host(items)} />);
    expect(first).toContain('aria-labelledby="settings-appearance"');
  });
});
