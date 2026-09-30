/**
 * `settings` — the settings shell (SPEC §6.5). A route, a view, and one registry.
 *
 * It renders the sections other plugins add with `addSection` and owns none of them.
 * The one thing it should say out loud, because the storage model makes it true:
 * settings are **per-user documents in the shared workspace**, so another user can read
 * them (SPEC §6.4). Secrets belong in admin plugin config, which is encrypted at rest.
 * `SettingsView` prints that sentence where a user is about to type into a field.
 *
 * The account section is added through the same `addSection` a third-party plugin uses,
 * deliberately: if the base distribution needed a privileged path, the API would be wrong.
 *
 * The top bar's gear is the `header` plugin's, and the "Open settings" command and its
 * Mod+, key are the `commands` plugin's: both call `open` here.
 */

import type { Kernel } from "@kernel";
import { addRoute, navigate, url } from "plugin:router";
import { addView } from "plugin:shell-ui";

import { AccountSection } from "./Account.js";
import { sectionRegistry, type SettingsSection } from "./sections.js";
import { SettingsView } from "./SettingsView.js";

export type { SettingsSection, SettingsShell } from "./sections.js";
/** Kept for dependents that named the service type this way. */
export type { SettingsShell as SettingsApi } from "./sections.js";

/** Add a section (or several) to the settings screen. Returns the function that takes it out again. */
export const addSection: (items: SettingsSection | readonly SettingsSection[]) => () => void = sectionRegistry.add;

/** Open the settings screen, at `sectionId` when given. */
export function open(sectionId?: string): void {
  navigate(sectionId ? `/settings/${encodeURIComponent(sectionId)}` : "/settings");
}

/** Every section currently on the settings screen, in display order. */
export function sections(): readonly SettingsSection[] {
  return sectionRegistry.get();
}

export default function activate(kernel: Kernel): void {
  const router = { navigate, url };

  addRoute([
    { path: "/settings", view: "settings.main" },
    { path: "/settings/:section", view: "settings.main" },
  ]);
  addView({
    id: "settings.main",
    title: "Settings",
    component: ({ params }) => (
      <SettingsView kernel={kernel} router={router} sections={sectionRegistry} {...(params ? { params } : {})} />
    ),
  });

  // The account section is this plugin's own: sign-out lives here, and it is the one
  // destructive local action (SPEC §5.3) — it must warn while edits are unsynced.
  addSection({
    id: "settings.account",
    title: "Account",
    order: 0,
    description: "Signed-in user, password, and sign-out.",
    component: () => <AccountSection kernel={kernel} />,
  });
}
