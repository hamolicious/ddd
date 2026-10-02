import { offlineCopies } from "../../_shared/offline-copy.js";
import { adminOfflineCopy } from "./offline.js";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";

import { addCommand } from "plugin:commands";
import { confirm, modal, openSheet } from "plugin:context-menu";
import { addItem } from "plugin:toolbar";
import { addRoute, current, navigate, onChange } from "plugin:router";
import { addSection, type SettingsSection } from "plugin:settings";
import { addView } from "plugin:shell-ui";

import { AdminSectionBody, AdminView, SETTINGS_SECTIONS, isAdminSection, type AdminSectionId, type SettingsSectionId } from "./AdminView.js";
import { createAdminClient } from "./api.js";
import { DialogsContext, type Dialogs } from "./hooks.js";

export type { AdminSectionId } from "./AdminView.js";

export interface AdminApi {
  open(section?: AdminSectionId): void;
  isAdmin(): boolean;
}

const VIEW = "admin.main";

let kernelRef: Kernel | undefined;

export function open(section?: AdminSectionId): void {
  navigate(section ? `/admin/${section}` : "/admin");
}

export function isAdmin(): boolean {
  if (!kernelRef) throw new Error("admin: not active yet (call it from your own activate or later)");
  return kernelRef.session.isAdmin();
}

const SETTINGS_TITLES: Readonly<Record<SettingsSectionId, { title: string; description: string }>> = {
  users: {
    title: "Users",
    description: "Accounts, admin rights, and password reset links.",
  },
  invites: {
    title: "Invites",
    description: "Single-use invite tokens, valid 7 days.",
  },
  audit: {
    title: "Audit log",
    description: "Every destructive and administrative action, with who did it.",
  },
  plugins: {
    title: "Plugins",
    description: "What is installed, and exactly what each plugin is trusted with.",
  },
  workspace: {
    title: "Workspace",
    description: "Workspace counters and the markdown export.",
  },
};

type IconsModule = typeof import("plugin:icons");

export default function activate(kernel: Kernel): void {
  kernelRef = kernel;
  const dialogs: Dialogs = { confirm, modal, openSheet };
  const client = createAdminClient(offlineCopies((path, init) => kernel.session.fetch(path, init), adminOfflineCopy));
  const admin = kernel.session.isAdmin();
  const selfId = kernel.session.user.id;

  const sectionFromRoute = (route: string): AdminSectionId => {
    const segments = route.replace(/^#/, "").split("?")[0]?.split("/") ?? [];
    const candidate = segments[2] ?? "";
    return isAdminSection(candidate) ? candidate : "users";
  };

  addRoute([
    { path: "/admin", view: VIEW },
    { path: "/admin/:section", view: VIEW },
  ]);

  const AdminHost = (): ReactElement => {
    const [section, setSection] = useState(() => sectionFromRoute(current()));
    useEffect(() => onChange((route) => setSection(sectionFromRoute(route))), []);
    return (
      <DialogsContext.Provider value={dialogs}>
        <AdminView
          client={client}
          isAdmin={admin}
          selfId={selfId}
          section={section}
          onSelectSection={(next) => navigate(`/admin/${next}`)}
        />
      </DialogsContext.Provider>
    );
  };

  addView({
    id: VIEW,
    title: "Administration",
    component: AdminHost,
  });

  if (admin) {
    const sections = SETTINGS_SECTIONS.map((id): SettingsSection => {
      const meta = SETTINGS_TITLES[id];
      const Section = (): ReactElement => (
        <DialogsContext.Provider value={dialogs}>
          <AdminSectionBody section={id} client={client} selfId={selfId} embedded />
        </DialogsContext.Provider>
      );
      return {
        id: `admin.${id}`,
        title: meta.title,
        description: meta.description,
        order: 900,
        component: Section,
      };
    });
    addSection(sections);

    void kernel.plugins
      .optional<IconsModule>("icons")
      .catch(() => undefined)
      .then((icons) =>
        addItem({
          id: "admin.link",
          label: "Admin",
          icon: icons ? <icons.Icon name="shield" /> : "🛡",
          side: "end",
          order: 90,
          onSelect: () => open(),
        }),
      );

    addCommand([
      { id: "admin.open", title: "Open administration", category: "Admin", run: () => open() },
      {
        id: "admin.users",
        title: "Manage users",
        category: "Admin",
        run: () => open("users"),
      },
      {
        id: "admin.invites",
        title: "Create an invite",
        category: "Admin",
        run: () => open("invites"),
      },
      {
        id: "admin.plugins",
        title: "Show installed plugins",
        category: "Admin",
        run: () => open("plugins"),
      },
      {
        id: "admin.audit",
        title: "Show the audit log",
        category: "Admin",
        run: () => open("audit"),
      },
      {
        id: "admin.export",
        title: "Export the workspace as markdown",
        category: "Admin",
        run: () => open("workspace"),
      },
    ]);
  }
}

export function deactivate(): void {
  kernelRef = undefined;
}
