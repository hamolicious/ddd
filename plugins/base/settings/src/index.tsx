/**
 * `settings` — the settings shell (SPEC §6.5). A route, a view, and one point.
 *
 * It renders contributed sections and owns none of them. The one thing it should say
 * out loud, because the storage model makes it true: settings are **per-user documents
 * in the shared workspace**, so another user can read them (SPEC §6.4). Secrets belong
 * in admin plugin config, which is encrypted at rest. A settings screen that did not
 * mention this would be quietly misleading. `SettingsView` prints that sentence where
 * a user is about to type into a field.
 *
 * The account section is this plugin's own contribution to its own point — the same
 * shape a third-party plugin uses, deliberately: if the base distribution needed a
 * privileged path, the point would be wrong.
 */

import { type Kernel } from "@kernel";

import {
  POINTS,
  settingsSectionShape,
  type Command,
  type KeybindingDefault,
  type MainView,
  type NavbarItem,
  type Route,
  type SettingsSection,
} from "../../_shared/points.js";

import { AccountSection } from "./Account.js";
import { SettingsView, type RouterService } from "./SettingsView.js";

export interface SettingsApi {
  open(sectionId?: string): void;
  sections(): readonly SettingsSection[];
}

export default function activate(kernel: Kernel): SettingsApi {
  const sections = kernel.extensions.definePoint<SettingsSection>({
    name: POINTS.settingsSection,
    shape: settingsSectionShape,
    key: (section) => section.id,
    description: "One section of the settings screen.",
  });

  // Declared dependencies, so this is a lookup and not a gamble (SPEC §6.4).
  const router = kernel.services.require<RouterService>("router");

  kernel.extensions.contribute<Route>(POINTS.route, { path: "/settings", view: "settings.main" });
  kernel.extensions.contribute<Route>(POINTS.route, {
    path: "/settings/:section",
    view: "settings.main",
  });
  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "settings.main",
    title: "Settings",
    component: ({ params }) => (
      <SettingsView kernel={kernel} router={router} {...(params ? { params } : {})} />
    ),
  });

  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "settings.open",
    label: "Settings",
    icon: "⚙",
    side: "end",
    order: 90,
    onSelect: () => api.open(),
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "settings.open",
    title: "Open settings",
    category: "Settings",
    run: () => api.open(),
  });
  kernel.extensions.contribute<KeybindingDefault>(POINTS.keybinding, {
    command: "settings.open",
    keys: "Mod+,",
  });

  // The account section is this plugin's own: sign-out lives here, and it is the one
  // destructive local action (SPEC §5.3) — it must warn while edits are unsynced.
  kernel.extensions.contribute<SettingsSection>(POINTS.settingsSection, {
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

  return api;
}
