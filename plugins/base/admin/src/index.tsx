/**
 * `admin` — users, invites, the audit log, orphan attachments, snapshots, and the
 * plugin list (SPEC §6.5).
 *
 * Every screen here is a thin client over `/api/admin/*` and two admin-facing corners of
 * the document and attachment APIs, all of which the server already authorizes: an
 * admin-only route returns 403 to everyone else, so this plugin hides its entry points for
 * non-admins as a courtesy and never as a security measure. That is also why the `/admin`
 * route is registered for *everyone* — a direct link should say "you are not an
 * administrator" rather than fall through to a not-found page.
 *
 * **The plugin list is read-only in M3.** Approving a pending install, editing plugin
 * config and toggling a plugin are M4 endpoints (SPEC §6.2); showing controls for them now
 * would mean shipping buttons that 404. What M3 *does* show is the list itself, each
 * plugin's declared capabilities, and — the honest part — SPEC §6.1's statement that
 * installing a plugin runs its code unsandboxed in every user's session.
 *
 * The screens with teeth, and why:
 *
 * - **Audit log** (SPEC §5.4): in a shared workspace any user can delete any document,
 *   so "who deleted this" is the only accountability there is.
 * - **Snapshots**: restore replaces the whole text in one CRDT transaction, under any open
 *   editor. The server warns in its own logs when other users are subscribed but does not
 *   return that count, so the confirmation here warns unconditionally.
 * - **Orphans**: blobs nothing references. Flagged, never auto-deleted (SPEC §3.6).
 *
 * **Where the sections live.** Each one is contributed as a `settings.section` *and*
 * gathered behind tabs on the `/admin` route. Both, deliberately: settings is where a user
 * looks for "the place with the knobs", and a URL per section is what someone pastes into a
 * chat when they need a colleague to look at an audit entry.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";

import { AdminSectionBody, AdminView, ADMIN_SECTIONS, isAdminSection, type AdminSectionId } from "./AdminView.js";
import { createAdminClient } from "./api.js";
import {
  POINTS,
  type Command,
  type MainView,
  type NavbarItem,
  type Route,
  type SettingsSection,
} from "../../_shared/points.js";

export interface AdminApi {
  open(section?: AdminSectionId): void;
  isAdmin(): boolean;
}

interface RouterService {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  onChange(listener: (path: string) => void): () => void;
  current(): string;
}

/** Titles for the contributed settings sections, in the order they should appear. */
const SETTINGS_TITLES: Readonly<Record<AdminSectionId, { title: string; description: string }>> = {
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
  snapshots: {
    title: "Snapshots",
    description: "Per-document history, and restoring a document to an earlier text.",
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

export default function activate(kernel: Kernel): AdminApi {
  const router = kernel.services.require<RouterService>("router");
  const client = createAdminClient((path, init) => kernel.session.fetch(path, init));
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
  kernel.extensions.contribute<Route>(POINTS.route, { path: "/admin", view: "admin.main" });
  kernel.extensions.contribute<Route>(POINTS.route, { path: "/admin/:section", view: "admin.main" });

  const AdminHost = (): ReactElement => {
    const [section, setSection] = useState(() => sectionFromRoute(router.current()));
    useEffect(() => router.onChange((route) => setSection(sectionFromRoute(route))), []);
    return (
      <AdminView
        client={client}
        documents={kernel.documents}
        isAdmin={admin}
        selfId={selfId}
        section={section}
        onSelectSection={(next) => router.navigate(`/admin/${next}`)}
      />
    );
  };

  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "admin.main",
    title: "Administration",
    component: AdminHost,
  });

  if (admin) {
    // One settings section per admin area, each rendering the same component the tab does.
    ADMIN_SECTIONS.forEach((id, index) => {
      const meta = SETTINGS_TITLES[id];
      // `embedded`: the settings shell draws the `<h2>` and the description above this,
      // so the section must not draw its own heading a second line below them.
      const Section = (): ReactElement => (
        <AdminSectionBody
          section={id}
          client={client}
          documents={kernel.documents}
          selfId={selfId}
          embedded
        />
      );
      kernel.extensions.contribute<SettingsSection>(POINTS.settingsSection, {
        id: `admin.${id}`,
        // The title alone. "Administration — " on all seven was the main reason the
        // settings section list was 1 860 px wide, and it duplicated the `<h2>` that
        // renders directly beneath it.
        title: meta.title,
        description: meta.description,
        order: 900 + index,
        component: Section,
      });
    });

    kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
      id: "admin.link",
      label: "Admin",
      // The icon is what lets `shell-ui` collapse this to a tap target at its mobile
      // breakpoint (it hides a label that *has* an icon beside it, keeping the label
      // for screen readers). Without one this item spelled "Admin" in full on a phone
      // and was part of why the navbar ran past the viewport.
      icon: "🛡",
      side: "end",
      order: 90,
      onSelect: () => api.open(),
    });

    for (const command of [
      { id: "admin.open", title: "Open administration", category: "Admin", run: () => api.open() },
      {
        id: "admin.users",
        title: "Manage users",
        category: "Admin",
        run: () => api.open("users"),
      },
      {
        id: "admin.invites",
        title: "Create an invite",
        category: "Admin",
        run: () => api.open("invites"),
      },
      {
        id: "admin.plugins",
        title: "Show installed plugins",
        category: "Admin",
        run: () => api.open("plugins"),
      },
      {
        id: "admin.audit",
        title: "Show the audit log",
        category: "Admin",
        run: () => api.open("audit"),
      },
      {
        id: "admin.snapshots",
        title: "Browse snapshots",
        category: "Admin",
        run: () => api.open("snapshots"),
      },
      {
        id: "admin.orphans",
        title: "Show orphan files",
        category: "Admin",
        run: () => api.open("orphans"),
      },
      {
        id: "admin.export",
        title: "Export the workspace as markdown",
        category: "Admin",
        run: () => api.open("workspace"),
      },
    ] satisfies Command[]) {
      kernel.extensions.contribute<Command>(POINTS.command, command);
    }
  }

  const api: AdminApi = {
    open: (section) => router.navigate(section ? `/admin/${section}` : "/admin"),
    isAdmin: () => kernel.session.isAdmin(),
  };

  return api;
}
