/**
 * `settings` — the settings shell (SPEC §6.5). A route, a view, and one host port.
 *
 * It renders the sections seated on its `sections` port (`lm/settings.section`) and
 * owns none of them. The one thing it should say out loud, because the storage model
 * makes it true: settings are **per-user documents in the shared workspace**, so
 * another user can read them (SPEC §6.4). Secrets belong in admin plugin config, which
 * is encrypted at rest. A settings screen that did not mention this would be quietly
 * misleading. `SettingsView` prints that sentence where a user is about to type into a
 * field.
 *
 * The account section is this plugin's own offer to its own protocol, on an ordinary
 * provided port — the same shape a third-party plugin uses, deliberately: if the base
 * distribution needed a privileged path, the protocol would be wrong.
 */

import { type Kernel } from "@kernel";
import type { Command } from "@protocols/lm/commands.command";
import type { KeybindingDefault } from "@protocols/lm/keybindings.default";
import type { MainView } from "@protocols/lm/main.view";
import type { NavbarItem } from "@protocols/lm/navbar.item";
import type { Router } from "@protocols/lm/router";
import type { Route } from "@protocols/lm/router.route";
import type { SettingsSection } from "@protocols/lm/settings.section";
import type { SettingsShell } from "@protocols/lm/settings-shell";

import { AccountSection } from "./Account.js";
import { SettingsView } from "./SettingsView.js";

/** What this plugin serves on its `shell` port: `lm/settings-shell`. */
export type SettingsApi = SettingsShell;

export default function activate(kernel: Kernel): SettingsApi {
  // The host: every section wired to the port, in seat order. The protocol package
  // (`protocols/settings.section/`) carries the shape and the duplicate key; nothing
  // here sorts (PLUGIN-PROTOCOLS §6a).
  const sections = kernel.ports.collect<SettingsSection>("sections");

  // Limited to the port's `needs` in the manifest: exactly what the view reads.
  const router = kernel.ports.use<Pick<Router, "navigate" | "url">>("router");

  kernel.ports.offer<Route>("route", [
    { path: "/settings", view: "settings.main" },
    { path: "/settings/:section", view: "settings.main" },
  ]);
  kernel.ports.offer<MainView>("view", {
    id: "settings.main",
    title: "Settings",
    component: ({ params }) => (
      <SettingsView kernel={kernel} router={router} sections={sections} {...(params ? { params } : {})} />
    ),
  });

  kernel.ports.offer<NavbarItem>("gear", {
    id: "settings.open",
    label: "Settings",
    icon: "⚙",
    side: "end",
    order: 90,
    onSelect: () => api.open(),
  });

  kernel.ports.offer<Command>("commands", {
    id: "settings.open",
    title: "Open settings",
    category: "Settings",
    run: () => api.open(),
  });
  kernel.ports.offer<KeybindingDefault>("keys", {
    command: "settings.open",
    keys: "Mod+,",
  });

  // The account section is this plugin's own: sign-out lives here, and it is the one
  // destructive local action (SPEC §5.3) — it must warn while edits are unsynced.
  kernel.ports.offer<SettingsSection>("account", {
    id: "settings.account",
    title: "Account",
    order: 0,
    description: "Signed-in user, password, and sign-out.",
    component: () => <AccountSection kernel={kernel} />,
  });

  const api: SettingsApi = {
    open: (sectionId) => {
      router.navigate(sectionId ? `/settings/${encodeURIComponent(sectionId)}` : "/settings");
    },
    sections: () => sections.get(),
  };

  kernel.ports.serve("shell", api);
  return api;
}
