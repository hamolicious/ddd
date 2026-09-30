/**
 * `admin` — users, invites, the audit log, orphan attachments, and the plugin list
 * (SPEC §6.5). A document's snapshots are the `snapshots` plugin's, in the altbar.
 *
 * Every screen here is a thin client over `/api/admin/*` and two admin-facing corners of
 * the document and attachment APIs, all of which the server already authorizes: an
 * admin-only route returns 403 to everyone else, so this plugin hides its entry points for
 * non-admins as a courtesy and never as a security measure. That is also why the `/admin`
 * route is registered for *everyone* — a direct link should say "you are not an
 * administrator" rather than fall through to a not-found page.
 *
 **The plugin list** approves installs, toggles and uninstalls plugins, and shows each
 * one's dependencies, dependents and why the loader skipped it. Enabling or disabling a
 * plugin changes the plugin set, so the server broadcasts `plugins.changed` and every
 * open client reloads (`@kernel` 3.0 has no hot reload). It also says — the honest part —
 * SPEC §6.1's statement that installing a plugin runs its code unsandboxed in every
 * user's session.
 *
 * The screens with teeth, and why:
 *
 * - **Audit log** (SPEC §5.4): in a shared workspace any user can delete any document,
 *   so "who deleted this" is the only accountability there is.
 * - **Orphans**: blobs nothing references. Flagged, never auto-deleted (SPEC §3.6).
 *
 * **Where the sections live.** Each one is contributed as a `settings.section` *and*
 * gathered behind tabs on the `/admin` route. Both, deliberately: settings is where a user
 * looks for "the place with the knobs", and a URL per section is what someone pastes into a
 * chat when they need a colleague to look at an audit entry.

 */

import { offlineCopies } from "../../_shared/offline-copy.js";
import { adminOfflineCopy } from "./offline.js";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";

import { addCommand } from "plugin:commands";
import { confirm, modal, openSheet } from "plugin:context-menu";
import { addItem } from "plugin:header";
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

/** Open the `/admin` route, on one section or the first. */
export function open(section?: AdminSectionId): void {
  navigate(section ? `/admin/${section}` : "/admin");
}

/** Whether the signed-in user is an administrator. */
export function isAdmin(): boolean {
  if (!kernelRef) throw new Error("admin: not active yet (call it from your own activate or later)");
  return kernelRef.session.isAdmin();
}

/** Titles for the contributed settings sections, in the order they should appear. */
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
  orphans: {
    title: "Orphan files",
    description: "Stored files no document references. Nothing is deleted automatically.",
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

export default function activate(kernel: Kernel): void {
  kernelRef = kernel;
  const dialogs: Dialogs = { confirm, modal, openSheet };
  // Offline, each tab shows what it last loaded, marked (dev-docs/resolved/SYNC-DECISIONS.md §9).
  const client = createAdminClient(offlineCopies((path, init) => kernel.session.fetch(path, init), adminOfflineCopy));
  const admin = kernel.session.isAdmin();
  const selfId = kernel.session.user.id;

  /** `#/admin/audit` → `"audit"`; anything unknown falls back to the first tab. */
  const sectionFromRoute = (route: string): AdminSectionId => {
    const segments = route.replace(/^#/, "").split("?")[0]?.split("/") ?? [];
    const candidate = segments[2] ?? "";
    return isAdminSection(candidate) ? candidate : "users";
  };

  // Routes exist for everyone — a direct link should show "not an administrator"
  // rather than a dead URL — but the view itself checks.
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
    // One settings section per admin area, each rendering the same component the tab does,
    // all at the same order near the end so they keep this order among themselves.
    const sections = SETTINGS_SECTIONS.map((id): SettingsSection => {
      const meta = SETTINGS_TITLES[id];
      // `embedded`: the settings shell draws the `<h2>` and the description above this,
      // so the section must not draw its own heading a second line below them.
      const Section = (): ReactElement => (
        <DialogsContext.Provider value={dialogs}>
          <AdminSectionBody section={id} client={client} selfId={selfId} embedded />
        </DialogsContext.Provider>
      );
      return {
        id: `admin.${id}`,
        // The title alone. "Administration — " on all seven was the main reason the
        // settings section list was 1 860 px wide, and it duplicated the `<h2>` that
        // renders directly beneath it.
        title: meta.title,
        description: meta.description,
        order: 900,
        component: Section,
      };
    });
    addSection(sections);

    addItem({
      id: "admin.link",
      label: "Admin",
      // The icon is what lets `shell-ui` collapse this to a tap target at its mobile
      // breakpoint (it hides a label that *has* an icon beside it, keeping the label
      // for screen readers). Without one this item spelled "Admin" in full on a phone
      // and was part of why the navbar ran past the viewport.
      icon: "🛡",
      side: "end",
      order: 90,
      onSelect: () => open(),
    });

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
        id: "admin.orphans",
        title: "Show orphan files",
        category: "Admin",
        run: () => open("orphans"),
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
