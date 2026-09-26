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

const ADMIN_SECTION_CLASSES = "flex flex-col gap-3 font-sans text-text [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-1 [&_:focus-visible]:outline-focus [&_button]:tap-h [&_button]:cursor-pointer [&_button]:rounded [&_button]:border [&_button]:border-border [&_button]:bg-bg-subtle [&_button]:px-2 [&_button]:text-inherit [&_button:disabled]:cursor-default [&_button:disabled]:opacity-55 [&_h3]:m-0 [&_h4]:m-0 [&_.admin-actions]:flex [&_.admin-actions]:flex-wrap [&_.admin-actions]:gap-1 [&_.admin-audit]:m-0 [&_.admin-audit]:flex [&_.admin-audit]:list-none [&_.admin-audit]:flex-col [&_.admin-audit]:gap-2 [&_.admin-audit]:p-0 [&_.admin-audit_li]:border-b [&_.admin-audit_li]:border-border [&_.admin-audit_li]:py-1.5 [&_.admin-audit-action]:font-mono [&_.admin-audit-action]:text-text [&_.admin-audit-head]:m-0 [&_.admin-audit-head]:flex [&_.admin-audit-head]:flex-wrap [&_.admin-audit-head]:items-baseline [&_.admin-audit-head]:gap-2 [&_.admin-audit-head]:text-sm [&_.admin-audit-head]:text-text-muted [&_.admin-audit-target]:mb-0 [&_.admin-audit-target]:mt-0.5 [&_.admin-badge]:ml-1 [&_.admin-badge]:inline-block [&_.admin-badge]:rounded [&_.admin-badge]:bg-bg-subtle [&_.admin-badge]:px-1 [&_.admin-badge]:text-xs [&_.admin-badge]:uppercase [&_.admin-callout]:m-0 [&_.admin-callout]:flex [&_.admin-callout]:flex-col [&_.admin-callout]:gap-2 [&_.admin-callout]:rounded [&_.admin-callout]:border [&_.admin-callout]:border-warning [&_.admin-callout]:bg-bg-subtle [&_.admin-callout]:p-2 [&_.admin-checkbox]:tap-h [&_.admin-checkbox]:flex [&_.admin-checkbox]:items-center [&_.admin-checkbox]:gap-1 [&_.admin-checkbox_input]:size-6 [&_.admin-checkbox_input]:accent-accent [&_.admin-danger]:border-danger! [&_.admin-danger]:text-danger! [&_.admin-details>summary]:tap-h [&_.admin-details>summary]:flex [&_.admin-details>summary]:cursor-pointer [&_.admin-details>summary]:items-center [&_.admin-empty]:m-0 [&_.admin-empty]:text-sm [&_.admin-empty]:text-text-muted [&_.admin-error]:m-0 [&_.admin-error]:rounded [&_.admin-error]:border [&_.admin-error]:border-danger [&_.admin-error]:p-2 [&_.admin-field]:flex [&_.admin-field]:min-w-48 [&_.admin-field]:flex-col [&_.admin-field]:gap-1 [&_.admin-field]:text-sm [&_.admin-field]:text-text-muted [&_.admin-field_input]:tap-h [&_.admin-field_input]:rounded [&_.admin-field_input]:border [&_.admin-field_input]:border-border [&_.admin-field_input]:bg-bg [&_.admin-field_input]:px-2 [&_.admin-field_input]:text-base [&_.admin-field_input]:text-text [&_.admin-form]:flex [&_.admin-form]:flex-col [&_.admin-form]:gap-2 [&_.admin-hint]:m-0 [&_.admin-hint]:block [&_.admin-hint]:break-words [&_.admin-hint]:text-xs [&_.admin-hint]:text-text-muted [&_.admin-inline-form]:flex [&_.admin-inline-form]:flex-wrap [&_.admin-inline-form]:items-end [&_.admin-inline-form]:gap-2 [&_.admin-link]:min-h-0! [&_.admin-link]:break-words [&_.admin-link]:border-0! [&_.admin-link]:bg-transparent! [&_.admin-link]:p-0! [&_.admin-link]:text-left [&_.admin-link]:text-link! [&_.admin-link-active]:font-semibold [&_.admin-link-active]:underline [&_.admin-note]:m-0 [&_.admin-note]:text-sm [&_.admin-note]:text-text-muted [&_.admin-picker]:m-0 [&_.admin-picker]:flex [&_.admin-picker]:list-none [&_.admin-picker]:flex-wrap [&_.admin-picker]:gap-2 [&_.admin-picker]:p-0 [&_.admin-plugin]:rounded [&_.admin-plugin]:border [&_.admin-plugin]:border-border [&_.admin-plugin]:p-2 [&_.admin-plugin-description]:mb-0 [&_.admin-plugin-description]:mt-1 [&_.admin-plugin-description]:text-text-muted [&_.admin-plugin-head]:m-0 [&_.admin-plugin-head]:flex [&_.admin-plugin-head]:flex-wrap [&_.admin-plugin-head]:items-baseline [&_.admin-plugin-head]:gap-2 [&_.admin-plugin-meta]:mt-2 [&_.admin-plugin-meta]:grid [&_.admin-plugin-meta]:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] [&_.admin-plugin-meta]:gap-1.5 [&_.admin-plugin-meta_dd]:m-0 [&_.admin-plugin-meta_dd]:break-words [&_.admin-plugin-meta_dt]:text-xs [&_.admin-plugin-meta_dt]:text-text-muted [&_.admin-plugins]:m-0 [&_.admin-plugins]:flex [&_.admin-plugins]:list-none [&_.admin-plugins]:flex-col [&_.admin-plugins]:gap-2 [&_.admin-plugins]:p-0 [&_.admin-problems]:m-0 [&_.admin-problems]:flex [&_.admin-problems]:list-none [&_.admin-problems]:flex-col [&_.admin-problems]:gap-2 [&_.admin-problems]:p-0 [&_.admin-problems_li]:break-words [&_.admin-row-inactive]:opacity-60 [&_.admin-secret]:m-0 [&_.admin-secret]:flex [&_.admin-secret]:flex-wrap [&_.admin-secret]:items-center [&_.admin-secret]:gap-2 [&_.admin-secret]:rounded [&_.admin-secret]:border [&_.admin-secret]:border-accent [&_.admin-secret]:bg-accent-subtle [&_.admin-secret]:p-2 [&_.admin-secret_code]:flex-[1_1_20rem] [&_.admin-secret_code]:select-all [&_.admin-secret_code]:break-words [&_.admin-secret_code]:rounded [&_.admin-secret_code]:bg-bg [&_.admin-secret_code]:p-1 [&_.admin-secret_code]:font-mono [&_.admin-stats]:m-0 [&_.admin-stats]:grid [&_.admin-stats]:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] [&_.admin-stats]:gap-2 [&_.admin-stats_dd]:m-0 [&_.admin-stats_dd]:text-lg [&_.admin-stats_dd]:tabular-nums [&_.admin-stats_dt]:text-xs [&_.admin-stats_dt]:uppercase [&_.admin-stats_dt]:text-text-muted [&_.admin-status]:ml-1 [&_.admin-status]:inline-block [&_.admin-status]:rounded [&_.admin-status]:bg-bg-subtle [&_.admin-status]:px-1 [&_.admin-status]:text-xs [&_.admin-status]:uppercase [&_.admin-status-enabled]:bg-accent-subtle [&_.admin-status-enabled]:text-text [&_.admin-status-pending]:bg-accent-subtle [&_.admin-status-pending]:text-text [&_.admin-status-failed]:bg-danger [&_.admin-status-failed]:text-danger-text [&_.admin-status-revoked]:bg-danger [&_.admin-status-revoked]:text-danger-text [&_.admin-table-scroll]:overflow-x-auto [&_.admin-table]:w-full [&_.admin-table]:border-collapse [&_.admin-table]:text-left [&_.admin-table_td]:whitespace-nowrap [&_.admin-table_td]:border-b [&_.admin-table_td]:border-border [&_.admin-table_td]:p-1.5 [&_.admin-table_td]:align-top [&_.admin-table_th]:whitespace-nowrap [&_.admin-table_th]:border-b [&_.admin-table_th]:border-border [&_.admin-table_th]:p-1.5 [&_.admin-table_th]:align-top [&_.admin-table_th]:font-normal [&_.admin-table_thead_th]:text-xs [&_.admin-table_thead_th]:uppercase [&_.admin-table_thead_th]:text-text-muted [&_.admin-warning]:m-0 [&_.admin-warning]:rounded [&_.admin-warning]:border [&_.admin-warning]:border-warning [&_.admin-warning]:p-2 [&_.admin-visually-hidden]:sr-only";

const ADMIN_COMPACT_CLASSES = "compact:[&_.admin-actions]:flex-col compact:[&_.admin-actions>button]:w-full compact:[&_.admin-audit-target]:min-w-0 compact:[&_.admin-audit-target]:break-all compact:[&_.admin-field]:min-w-0 compact:[&_.admin-inline-form]:flex-col compact:[&_.admin-inline-form]:items-stretch compact:[&_.admin-link]:break-all compact:[&_.admin-table-scroll]:overflow-x-visible compact:[&_.admin-table]:block compact:[&_.admin-table_tbody]:block compact:[&_.admin-table_td]:block compact:[&_.admin-table_td]:whitespace-normal compact:[&_.admin-table_td]:break-words compact:[&_.admin-table_td]:border-0 compact:[&_.admin-table_td]:px-0 compact:[&_.admin-table_td]:py-0.5 compact:[&_.admin-table_th]:block compact:[&_.admin-table_th]:whitespace-normal compact:[&_.admin-table_th]:break-words compact:[&_.admin-table_th]:border-0 compact:[&_.admin-table_th]:px-0 compact:[&_.admin-table_th]:py-0.5 compact:[&_.admin-table_th[scope=row]]:mb-1 compact:[&_.admin-table_th[scope=row]]:font-semibold compact:[&_.admin-table_thead]:sr-only compact:[&_.admin-table_tr]:mb-2 compact:[&_.admin-table_tr]:block compact:[&_.admin-table_tr]:rounded compact:[&_.admin-table_tr]:border compact:[&_.admin-table_tr]:border-border compact:[&_.admin-table_tr]:bg-bg-raised compact:[&_.admin-table_tr]:p-2 compact:[&_.admin-table_.admin-actions]:mt-1.5 compact:[&_.admin-table_.admin-actions]:border-t compact:[&_.admin-table_.admin-actions]:border-border compact:[&_.admin-table_.admin-actions]:pt-1.5";

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
      <section className="flex flex-col gap-3 p-4 font-sans text-text [&_h2]:m-0" aria-labelledby="admin-heading">
        <h2 id="admin-heading">Administration</h2>
        <p className="m-0 text-sm text-text-muted">
          You are not an administrator. Ask one to promote your account.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 p-4 font-sans text-text [&_h2]:m-0 [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-1 [&_:focus-visible]:outline-focus" aria-labelledby="admin-heading">
      <h2 id="admin-heading">Administration</h2>

      <div className="flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Administration sections" onKeyDown={onKeyDown}>
        {ADMIN_SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`admin-tab-${id}`}
            aria-selected={id === section}
            aria-controls={`admin-panel-${id}`}
            tabIndex={id === section ? 0 : -1}
            className={`tap-h cursor-pointer rounded-t border border-transparent bg-transparent px-2 ${id === section ? " border-border border-b-bg bg-bg font-semibold" : ""}`}
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
