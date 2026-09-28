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
 * - **Orphans**: blobs nothing references. Flagged, never auto-deleted (SPEC §3.6).
 *
 * **Where the sections live.** Each one is contributed as a `settings.section` *and*
 * gathered behind tabs on the `/admin` route. Both, deliberately: settings is where a user
 * looks for "the place with the knobs", and a URL per section is what someone pastes into a
 * chat when they need a colleague to look at an audit entry.
 *
 * **The wiring editor** (PLUGIN-PROTOCOLS §7, `wiring/`) is the one exception: the Wiring
 * tab, `#/admin/wiring`, and not a settings section, because the graph needs the whole
 * view. Its inspector is an altbar panel on a wide screen and a bottom sheet on a phone.
 */

import { offlineCopies } from "../../_shared/offline-copy.js";
import { adminOfflineCopy } from "./offline.js";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel } from "@kernel";

import type { Command } from "@protocols/lm/commands.command";
import type { ContextMenu } from "@protocols/lm/context-menu";
import type { MainView } from "@protocols/lm/main.view";
import type { NavbarItem } from "@protocols/lm/navbar.item";
import type { Router } from "@protocols/lm/router";
import type { Route } from "@protocols/lm/router.route";
import type { SettingsSection } from "@protocols/lm/settings.section";
import type { AltbarPanel } from "@protocols/lm/altbar.panel";
import type { Shell } from "@protocols/lm/shell";

import { AdminSectionBody, AdminView, SETTINGS_SECTIONS, isAdminSection, type AdminSectionId, type SettingsSectionId } from "./AdminView.js";
import { createAdminClient } from "./api.js";
import { DialogsContext, WiringEditorContext, type Dialogs, type WiringEditorLink } from "./hooks.js";
import { createWiringEditor, WIRING_PATH } from "./wiring/index.js";

export interface AdminApi {
  open(section?: AdminSectionId): void;
  isAdmin(): boolean;
}

const VIEW = "admin.main";

/** What `activate` leaves behind for `deactivate` to undo. */
let teardown: (() => void) | undefined;

/**
 * Titles for the contributed settings sections, in the order they should appear. The
 * Wiring tab has none: the graph needs the whole view.
 */
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

export default function activate(kernel: Kernel): AdminApi {
  // The plugin's own ports (`consumes` in the manifest); which plugin answers is wiring.
  // Every member read through either handle is in the port's `needs`.
  const router = kernel.ports.use<Router>("router");
  const menu = kernel.ports.use<ContextMenu>("menu");
  const shell = kernel.ports.use<Pick<Shell, "layout" | "subscribeLayout" | "toggleAltbar">>("shell");
  const dialogs: Dialogs = {
    confirm: (request) => menu.confirm(request),
    modal: (request) => menu.modal(request),
    openSheet: (request) => menu.openSheet(request),
  };
  const wiringEditor: WiringEditorLink = {
    open: () => router.navigate(WIRING_PATH),
  };
  const editor = createWiringEditor({ kernel, router, shell, menu, viewId: VIEW });
  teardown = () => editor.dispose();
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
  kernel.ports.offer<Route>("route", [
    { path: "/admin", view: VIEW },
    { path: "/admin/:section", view: VIEW },
  ]);

  const AdminHost = (): ReactElement => {
    const [section, setSection] = useState(() => sectionFromRoute(router.current()));
    useEffect(() => router.onChange((route) => setSection(sectionFromRoute(route))), []);
    return (
      <DialogsContext.Provider value={dialogs}>
        <WiringEditorContext.Provider value={wiringEditor}>
          <AdminView
            client={client}
            isAdmin={admin}
            selfId={selfId}
            section={section}
            onSelectSection={(next) => router.navigate(`/admin/${next}`)}
            wiring={editor.Section}
          />
        </WiringEditorContext.Provider>
      </DialogsContext.Provider>
    );
  };

  kernel.ports.offer<MainView>("view", {
    id: VIEW,
    title: "Administration",
    component: AdminHost,
  });

  if (admin) {
    // One settings section per admin area, each rendering the same component the tab does.
    // Offered together, so they keep this order inside the seat the manifest's
    // `provides.settings.order` hint (or the wiring) gives the plugin.
    const sections = SETTINGS_SECTIONS.map((id): SettingsSection => {
      const meta = SETTINGS_TITLES[id];
      // `embedded`: the settings shell draws the `<h2>` and the description above this,
      // so the section must not draw its own heading a second line below them.
      const Section = (): ReactElement => (
        <DialogsContext.Provider value={dialogs}>
          <WiringEditorContext.Provider value={wiringEditor}>
            <AdminSectionBody
              section={id}
              client={client}
              selfId={selfId}
              embedded
            />
          </WiringEditorContext.Provider>
        </DialogsContext.Provider>
      );
      return {
        id: `admin.${id}`,
        // The title alone. "Administration — " on all seven was the main reason the
        // settings section list was 1 860 px wide, and it duplicated the `<h2>` that
        // renders directly beneath it.
        title: meta.title,
        description: meta.description,
        component: Section,
      };
    });
    kernel.ports.offer<SettingsSection>("settings", sections);

    kernel.ports.offer<NavbarItem>("nav", {
      id: "admin.link",
      label: "Admin",
      // The icon is what lets `shell-ui` collapse this to a tap target at its mobile
      // breakpoint (it hides a label that *has* an icon beside it, keeping the label
      // for screen readers). Without one this item spelled "Admin" in full on a phone
      // and was part of why the navbar ran past the viewport.
      icon: "🛡",
      side: "end",
      onSelect: () => api.open(),
    });

    kernel.ports.offer<Command>("commands", [
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
      ...editor.commands,
    ]);

    kernel.ports.offer<AltbarPanel>("panel", editor.panel);
  }

  const api: AdminApi = {
    open: (section) => router.navigate(section ? `/admin/${section}` : "/admin"),
    isAdmin: () => kernel.session.isAdmin(),
  };

  return api;
}

/** Everything `activate` built itself; the kernel withdraws the offers (`"hot": true`). */
export function deactivate(): void {
  teardown?.();
  teardown = undefined;
}
