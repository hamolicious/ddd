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
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";

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

/**
 * The frame every admin section draws around itself — **with its heading on the
 * `/admin` route and without it inside settings**.
 *
 * Both places render the same component (that is the point of contributing each area
 * twice), but the settings shell already draws an `<h2>` with the section's title and
 * its description above it. Drawing the `<h3>` as well printed "Invites" twice, one
 * line apart, and nested two ARIA regions with the identical accessible name — which
 * is not just noise on screen, it is a screen reader announcing the same landmark
 * twice on the way into a form.
 */
export function AdminSectionFrame({
  id,
  title,
  embedded,
  children,
}: {
  readonly id: AdminSectionId;
  readonly title: string;
  readonly embedded?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  if (embedded) return <section className="admin-section">{children}</section>;
  return (
    <section className="admin-section" aria-labelledby={`admin-${id}-heading`}>
      <h3 id={`admin-${id}-heading`}>{title}</h3>
      {children}
    </section>
  );
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
          You are not an administrator. Ask one to promote your account.
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
  embedded,
}: {
  readonly section: AdminSectionId;
  readonly client: AdminClient;
  readonly documents: DocumentsApi;
  readonly selfId: string;
  /** True on the settings screen, which has already drawn this section's heading. */
  readonly embedded?: boolean;
}): ReactElement {
  switch (section) {
    case "users":
      return <UsersSection client={client} selfId={selfId} embedded={embedded} />;
    case "invites":
      return <InvitesSection client={client} embedded={embedded} />;
    case "audit":
      return <AuditSection client={client} embedded={embedded} />;
    case "orphans":
      return <OrphansSection client={client} embedded={embedded} />;
    case "snapshots":
      return <SnapshotsSection client={client} documents={documents} embedded={embedded} />;
    case "plugins":
      return <PluginsSection client={client} embedded={embedded} />;
    default:
      return <ExportSection client={client} embedded={embedded} />;
  }
}
