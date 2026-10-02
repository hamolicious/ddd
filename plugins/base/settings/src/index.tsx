import type { Kernel } from "@kernel";
import { addRoute, navigate, url } from "plugin:router";
import { addView } from "plugin:shell-ui";

import { AccountSection } from "./Account.js";
import { sectionRegistry, type SettingsSection } from "./sections.js";
import { SettingsView } from "./SettingsView.js";

export type { SettingsSection, SettingsShell } from "./sections.js";
export type { SettingsShell as SettingsApi } from "./sections.js";

export const addSection: (items: SettingsSection | readonly SettingsSection[]) => () => void = sectionRegistry.add;

export function open(sectionId?: string): void {
  navigate(sectionId ? `/settings/${encodeURIComponent(sectionId)}` : "/settings");
}

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

  addSection({
    id: "settings.account",
    title: "Account",
    order: 0,
    description: "Signed-in user, password, and sign-out.",
    component: () => <AccountSection kernel={kernel} />,
  });
}
