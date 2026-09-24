/**
 * The `/admin` route: the same sections the settings screen contributes, gathered behind
 * tabs so a direct link works.
 *
 * **Non-admins get a message, not a dead URL.** The route is registered for everyone —
 * someone pasting `#/admin/audit` into a chat should be told what is wrong — and the server
 * refuses every request underneath regardless of what this component renders. Hiding is a
 * courtesy; the 403 is the control.
 *
 * Tabs are a `tablist` with roving `tabindex`, arrow-key navigation and `aria-controls`, and
 * the active tab is in the URL (`#/admin/<section>`) so a reload and the back button both
 * behave.
 */

import { useCallback } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";

import type { DocumentsApi } from "@kernel";

import type { AdminClient } from "./api.js";
import { AuditSection } from "./Audit.js";
import { PluginsSection } from "./Plugins.js";
import { ExportSection, OrphansSection, SnapshotsSection } from "./Storage.js";
import { InvitesSection, UsersSection } from "./Users.js";

export const ADMIN_SECTIONS = ["users", "invites", "audit", "orphans", "snapshots", "plugins", "workspace"] as const;

export type AdminSectionId = (typeof ADMIN_SECTIONS)[number];

const LABELS: Readonly<Record<AdminSectionId, string>> = {
  users: "Users",
  invites: "Invites",
  audit: "Audit log",
  orphans: "Orphan files",
  snapshots: "Snapshots",
  plugins: "Plugins",
  workspace: "Workspace",
};

export function isAdminSection(value: string): value is AdminSectionId {
  return (ADMIN_SECTIONS as readonly string[]).includes(value);
}

export interface AdminViewProps {
  readonly client: AdminClient;
  readonly documents: DocumentsApi;
  readonly isAdmin: boolean;
  readonly selfId: string;
  readonly section: AdminSectionId;
  readonly onSelectSection: (section: AdminSectionId) => void;
}

export function AdminView({
  client,
  documents,
  isAdmin,
  selfId,
  section,
  onSelectSection,
}: AdminViewProps): ReactElement {
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const index = ADMIN_SECTIONS.indexOf(section);
      const go = (next: number): void => {
        event.preventDefault();
        const target = ADMIN_SECTIONS[(next + ADMIN_SECTIONS.length) % ADMIN_SECTIONS.length];
        if (target) onSelectSection(target);
      };
      if (event.key === "ArrowRight") go(index + 1);
      else if (event.key === "ArrowLeft") go(index - 1);
      else if (event.key === "Home") go(0);
      else if (event.key === "End") go(ADMIN_SECTIONS.length - 1);
    },
    [onSelectSection, section],
  );

  if (!isAdmin) {
    return (
      <section className="admin" aria-labelledby="admin-heading">
        <h2 id="admin-heading">Administration</h2>
        <p className="admin-empty">
          You are not an administrator of this workspace. Every route behind this screen is
          refused by the server, so there is nothing here to show you. Ask an administrator
          — they can promote an account from this same screen.
        </p>
      </section>
    );
  }

  return (
    <section className="admin" aria-labelledby="admin-heading">
      <h2 id="admin-heading">Administration</h2>

      <div className="admin-tabs" role="tablist" aria-label="Administration sections" onKeyDown={onKeyDown}>
        {ADMIN_SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`admin-tab-${id}`}
            aria-selected={id === section}
            aria-controls={`admin-panel-${id}`}
            tabIndex={id === section ? 0 : -1}
            className={`admin-tab${id === section ? " admin-tab-active" : ""}`}
            onClick={() => onSelectSection(id)}
          >
            {LABELS[id]}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`admin-panel-${section}`} aria-labelledby={`admin-tab-${section}`}>
        <AdminSectionBody
          section={section}
          client={client}
          documents={documents}
          selfId={selfId}
        />
      </div>
    </section>
  );
}

export function AdminSectionBody({
  section,
  client,
  documents,
  selfId,
}: {
  readonly section: AdminSectionId;
  readonly client: AdminClient;
  readonly documents: DocumentsApi;
  readonly selfId: string;
}): ReactElement {
  switch (section) {
    case "users":
      return <UsersSection client={client} selfId={selfId} />;
    case "invites":
      return <InvitesSection client={client} />;
    case "audit":
      return <AuditSection client={client} />;
    case "orphans":
      return <OrphansSection client={client} />;
    case "snapshots":
      return <SnapshotsSection client={client} documents={documents} />;
    case "plugins":
      return <PluginsSection client={client} />;
    default:
      return <ExportSection client={client} />;
  }
}
