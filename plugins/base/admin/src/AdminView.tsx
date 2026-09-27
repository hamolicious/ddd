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

const ADMIN_SECTION_CLASSES = "admin:flex admin:flex-col admin:gap-3 admin:font-sans admin:text-text admin:[&_:focus-visible]:outline-2 admin:[&_:focus-visible]:outline-offset-1 admin:[&_:focus-visible]:outline-focus admin:[&_button]:tap-h admin:[&_button]:cursor-pointer admin:[&_button]:rounded admin:[&_button]:border admin:[&_button]:border-border admin:[&_button]:bg-bg-subtle admin:[&_button]:px-2 admin:[&_button]:text-inherit admin:[&_button:disabled]:cursor-default admin:[&_button:disabled]:opacity-55 admin:[&_h3]:m-0 admin:[&_h4]:m-0 admin:[&_.admin-actions:not(td)]:flex admin:[&_.admin-actions:not(td)]:flex-wrap admin:[&_.admin-actions:not(td)]:gap-1 admin:[&_td.admin-actions]:align-middle admin:[&_td.admin-actions>*+*]:ml-1 admin:[&_.admin-icon-button]:inline-flex admin:[&_.admin-icon-button]:items-center admin:[&_.admin-icon-button]:justify-center admin:[&_.admin-icon-button]:min-w-[var(--lm-tap-target)] admin:[&_.admin-icon-button]:px-0! admin:[&_.admin-icon-button]:align-middle admin:[&_.admin-audit]:m-0 admin:[&_.admin-audit]:flex admin:[&_.admin-audit]:list-none admin:[&_.admin-audit]:flex-col admin:[&_.admin-audit]:gap-2 admin:[&_.admin-audit]:p-0 admin:[&_.admin-audit_li]:border-b admin:[&_.admin-audit_li]:border-border admin:[&_.admin-audit_li]:py-1.5 admin:[&_.admin-audit-action]:font-mono admin:[&_.admin-audit-action]:text-text admin:[&_.admin-audit-head]:m-0 admin:[&_.admin-audit-head]:flex admin:[&_.admin-audit-head]:flex-wrap admin:[&_.admin-audit-head]:items-baseline admin:[&_.admin-audit-head]:gap-2 admin:[&_.admin-audit-head]:text-sm admin:[&_.admin-audit-head]:text-text-muted admin:[&_.admin-audit-target]:mb-0 admin:[&_.admin-audit-target]:mt-0.5 admin:[&_.admin-badge]:ml-1 admin:[&_.admin-badge]:inline-block admin:[&_.admin-badge]:rounded admin:[&_.admin-badge]:bg-bg-subtle admin:[&_.admin-badge]:px-1 admin:[&_.admin-badge]:text-xs admin:[&_.admin-badge]:uppercase admin:[&_.admin-callout]:m-0 admin:[&_.admin-callout]:flex admin:[&_.admin-callout]:flex-col admin:[&_.admin-callout]:gap-2 admin:[&_.admin-callout]:rounded admin:[&_.admin-callout]:border admin:[&_.admin-callout]:border-warning admin:[&_.admin-callout]:bg-bg-subtle admin:[&_.admin-callout]:p-2 admin:[&_.admin-checkbox]:tap-h admin:[&_.admin-checkbox]:flex admin:[&_.admin-checkbox]:items-center admin:[&_.admin-checkbox]:gap-1 admin:[&_.admin-checkbox_input]:size-6 admin:[&_.admin-checkbox_input]:accent-accent admin:[&_.admin-danger]:border-danger! admin:[&_.admin-danger]:text-danger! admin:[&_.admin-details>summary]:tap-h admin:[&_.admin-details>summary]:flex admin:[&_.admin-details>summary]:cursor-pointer admin:[&_.admin-details>summary]:items-center admin:[&_.admin-empty]:m-0 admin:[&_.admin-empty]:text-sm admin:[&_.admin-empty]:text-text-muted admin:[&_.admin-error]:m-0 admin:[&_.admin-error]:rounded admin:[&_.admin-error]:border admin:[&_.admin-error]:border-danger admin:[&_.admin-error]:p-2 admin:[&_.admin-field]:flex admin:[&_.admin-field]:min-w-48 admin:[&_.admin-field]:flex-col admin:[&_.admin-field]:gap-1 admin:[&_.admin-field]:text-sm admin:[&_.admin-field]:text-text-muted admin:[&_.admin-field_input]:tap-h admin:[&_.admin-field_input]:rounded admin:[&_.admin-field_input]:border admin:[&_.admin-field_input]:border-border admin:[&_.admin-field_input]:bg-bg admin:[&_.admin-field_input]:px-2 admin:[&_.admin-field_input]:text-base admin:[&_.admin-field_input]:text-text admin:[&_.admin-form]:flex admin:[&_.admin-form]:flex-col admin:[&_.admin-form]:gap-2 admin:[&_.admin-hint]:m-0 admin:[&_.admin-hint]:block admin:[&_.admin-hint]:break-words admin:[&_.admin-hint]:text-xs admin:[&_.admin-hint]:text-text-muted admin:[&_.admin-inline-form]:flex admin:[&_.admin-inline-form]:flex-wrap admin:[&_.admin-inline-form]:items-end admin:[&_.admin-inline-form]:gap-2 admin:[&_.admin-link]:min-h-0! admin:[&_.admin-link]:break-words admin:[&_.admin-link]:border-0! admin:[&_.admin-link]:bg-transparent! admin:[&_.admin-link]:p-0! admin:[&_.admin-link]:text-left admin:[&_.admin-link]:text-link! admin:[&_.admin-link-active]:font-semibold admin:[&_.admin-link-active]:underline admin:[&_.admin-note]:m-0 admin:[&_.admin-note]:text-sm admin:[&_.admin-note]:text-text-muted admin:[&_.admin-picker]:m-0 admin:[&_.admin-picker]:flex admin:[&_.admin-picker]:list-none admin:[&_.admin-picker]:flex-wrap admin:[&_.admin-picker]:gap-2 admin:[&_.admin-picker]:p-0 admin:[&_.admin-plugin]:rounded admin:[&_.admin-plugin]:border admin:[&_.admin-plugin]:border-border admin:[&_.admin-plugin]:p-2 admin:[&_.admin-plugin-description]:mb-0 admin:[&_.admin-plugin-description]:mt-1 admin:[&_.admin-plugin-description]:text-text-muted admin:[&_.admin-plugin-head]:m-0 admin:[&_.admin-plugin-head]:flex admin:[&_.admin-plugin-head]:flex-wrap admin:[&_.admin-plugin-head]:items-baseline admin:[&_.admin-plugin-head]:gap-2 admin:[&_.admin-plugin-meta]:mt-2 admin:[&_.admin-plugin-meta]:grid admin:[&_.admin-plugin-meta]:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] admin:[&_.admin-plugin-meta]:gap-1.5 admin:[&_.admin-plugin-meta_dd]:m-0 admin:[&_.admin-plugin-meta_dd]:break-words admin:[&_.admin-plugin-meta_dt]:text-xs admin:[&_.admin-plugin-meta_dt]:text-text-muted admin:[&_.admin-plugins]:m-0 admin:[&_.admin-plugins]:flex admin:[&_.admin-plugins]:list-none admin:[&_.admin-plugins]:flex-col admin:[&_.admin-plugins]:gap-2 admin:[&_.admin-plugins]:p-0 admin:[&_.admin-problems]:m-0 admin:[&_.admin-problems]:flex admin:[&_.admin-problems]:list-none admin:[&_.admin-problems]:flex-col admin:[&_.admin-problems]:gap-2 admin:[&_.admin-problems]:p-0 admin:[&_.admin-problems_li]:break-words admin:[&_.admin-row-inactive]:opacity-60 admin:[&_.admin-secret]:m-0 admin:[&_.admin-secret]:flex admin:[&_.admin-secret]:flex-wrap admin:[&_.admin-secret]:items-center admin:[&_.admin-secret]:gap-2 admin:[&_.admin-secret]:rounded admin:[&_.admin-secret]:border admin:[&_.admin-secret]:border-accent admin:[&_.admin-secret]:bg-accent-subtle admin:[&_.admin-secret]:p-2 admin:[&_.admin-secret_code]:flex-[1_1_20rem] admin:[&_.admin-secret_code]:select-all admin:[&_.admin-secret_code]:min-w-0 admin:[&_.admin-secret_code]:break-all admin:[&_.admin-secret_code]:rounded admin:[&_.admin-secret_code]:bg-bg admin:[&_.admin-secret_code]:p-1 admin:[&_.admin-secret_code]:font-mono admin:[&_.admin-stats]:m-0 admin:[&_.admin-stats]:grid admin:[&_.admin-stats]:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] admin:[&_.admin-stats]:gap-2 admin:[&_.admin-stats_dd]:m-0 admin:[&_.admin-stats_dd]:text-lg admin:[&_.admin-stats_dd]:tabular-nums admin:[&_.admin-stats_dt]:text-xs admin:[&_.admin-stats_dt]:uppercase admin:[&_.admin-stats_dt]:text-text-muted admin:[&_.admin-status]:ml-1 admin:[&_.admin-status]:inline-block admin:[&_.admin-status]:rounded admin:[&_.admin-status]:bg-bg-subtle admin:[&_.admin-status]:px-1 admin:[&_.admin-status]:text-xs admin:[&_.admin-status]:uppercase admin:[&_.admin-status-enabled]:bg-accent-subtle admin:[&_.admin-status-enabled]:text-text admin:[&_.admin-status-pending]:bg-accent-subtle admin:[&_.admin-status-pending]:text-text admin:[&_.admin-status-failed]:bg-danger admin:[&_.admin-status-failed]:text-danger-text admin:[&_.admin-status-revoked]:bg-danger admin:[&_.admin-status-revoked]:text-danger-text admin:[&_.admin-table-scroll]:overflow-x-auto admin:[&_.admin-table]:w-full admin:[&_.admin-table]:border-collapse admin:[&_.admin-table]:text-left admin:[&_.admin-table_td]:whitespace-nowrap admin:[&_.admin-table_td]:border-b admin:[&_.admin-table_td]:border-border admin:[&_.admin-table_td]:p-1.5 admin:[&_.admin-table_td]:align-top admin:[&_.admin-table_th]:whitespace-nowrap admin:[&_.admin-table_th]:border-b admin:[&_.admin-table_th]:border-border admin:[&_.admin-table_th]:p-1.5 admin:[&_.admin-table_th]:align-top admin:[&_.admin-table_th]:font-normal admin:[&_.admin-table_thead_th]:text-xs admin:[&_.admin-table_thead_th]:uppercase admin:[&_.admin-table_thead_th]:text-text-muted admin:[&_.admin-warning]:m-0 admin:[&_.admin-warning]:rounded admin:[&_.admin-warning]:border admin:[&_.admin-warning]:border-warning admin:[&_.admin-warning]:p-2 admin:[&_.admin-visually-hidden]:sr-only";

const ADMIN_COMPACT_CLASSES = "admin:compact:[&_.admin-actions:not(td)]:flex admin:compact:[&_.admin-actions:not(td)]:gap-1 admin:compact:[&_.admin-table_td.admin-actions]:flex admin:compact:[&_.admin-table_td.admin-actions]:gap-1 admin:compact:[&_.admin-table_td.admin-actions>*+*]:ml-0 admin:compact:[&_.admin-actions]:flex-col admin:compact:[&_.admin-actions>button]:w-full admin:compact:[&_.admin-actions:has(>.admin-icon-button)]:flex-row admin:compact:[&_.admin-actions>.admin-icon-button]:w-auto admin:compact:[&_.admin-checkbox_.admin-visually-hidden]:not-sr-only admin:compact:[&_.admin-audit-target]:min-w-0 admin:compact:[&_.admin-audit-target]:break-all admin:compact:[&_.admin-field]:min-w-0 admin:compact:[&_.admin-inline-form]:flex-col admin:compact:[&_.admin-inline-form]:items-stretch admin:compact:[&_.admin-link]:break-all admin:compact:[&_.admin-table-scroll]:overflow-x-visible admin:compact:[&_.admin-table]:block admin:compact:[&_.admin-table_tbody]:block admin:compact:[&_.admin-table_td]:block admin:compact:[&_.admin-table_td]:whitespace-normal admin:compact:[&_.admin-table_td]:break-words admin:compact:[&_.admin-table_td]:border-0 admin:compact:[&_.admin-table_td]:px-0 admin:compact:[&_.admin-table_td]:py-0.5 admin:compact:[&_.admin-table_th]:block admin:compact:[&_.admin-table_th]:whitespace-normal admin:compact:[&_.admin-table_th]:break-words admin:compact:[&_.admin-table_th]:border-0 admin:compact:[&_.admin-table_th]:px-0 admin:compact:[&_.admin-table_th]:py-0.5 admin:compact:[&_.admin-table_th[scope=row]]:mb-1 admin:compact:[&_.admin-table_th[scope=row]]:font-semibold admin:compact:[&_.admin-table_thead]:sr-only admin:compact:[&_.admin-table_tr]:mb-2 admin:compact:[&_.admin-table_tr]:block admin:compact:[&_.admin-table_tr]:rounded admin:compact:[&_.admin-table_tr]:border admin:compact:[&_.admin-table_tr]:border-border admin:compact:[&_.admin-table_tr]:bg-bg-raised admin:compact:[&_.admin-table_tr]:p-2 admin:compact:[&_.admin-table_.admin-actions]:mt-1.5 admin:compact:[&_.admin-table_.admin-actions]:border-t admin:compact:[&_.admin-table_.admin-actions]:border-border admin:compact:[&_.admin-table_.admin-actions]:pt-1.5";

const ADMIN_CLASSES = `${ADMIN_SECTION_CLASSES} ${ADMIN_COMPACT_CLASSES}`;

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
  if (embedded) return <section className={ADMIN_CLASSES}>{children}</section>;
  return (
    <section className={ADMIN_CLASSES} aria-labelledby={`admin-${id}-heading`}>
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
      <section className="admin:flex admin:flex-col admin:gap-3 admin:p-4 admin:font-sans admin:text-text admin:[&_h2]:m-0" aria-labelledby="admin-heading">
        <h2 id="admin-heading">Administration</h2>
        <p className="admin:m-0 admin:text-sm admin:text-text-muted">
          You are not an administrator. Ask one to promote your account.
        </p>
      </section>
    );
  }

  return (
    <section className="admin:flex admin:flex-col admin:gap-3 admin:p-4 admin:font-sans admin:text-text admin:[&_h2]:m-0 admin:[&_:focus-visible]:outline-2 admin:[&_:focus-visible]:outline-offset-1 admin:[&_:focus-visible]:outline-focus" aria-labelledby="admin-heading">
      <h2 id="admin-heading">Administration</h2>

      <div className="admin:flex admin:flex-wrap admin:gap-1 admin:border-b admin:border-border" role="tablist" aria-label="Administration sections" onKeyDown={onKeyDown}>
        {ADMIN_SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`admin-tab-${id}`}
            aria-selected={id === section}
            aria-controls={`admin-panel-${id}`}
            tabIndex={id === section ? 0 : -1}
            className={`admin:tap-h admin:cursor-pointer admin:rounded-t admin:border admin:border-transparent admin:bg-transparent admin:px-2 ${id === section ? " admin:border-border admin:border-b-bg admin:bg-bg admin:font-semibold" : ""}`}
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
