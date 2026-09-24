/**
 * `agenda` — what is coming up, and what is still open. **A pure frontend plugin**
 * (SPEC §9 M4).
 *
 * It ships next to `calendar` to make one point concrete: *a plugin needs a backend half
 * only when it needs cron, outbound HTTP or a webhook* (SPEC §6.3). Agenda needs none of
 * those. Everything it shows comes from local projection queries — so it has no `backend`
 * in its manifest, **no capabilities at all**, nothing to approve beyond the frontend-code
 * trust every plugin carries (SPEC §6.1), and it works offline by construction.
 *
 * It also deliberately does **not** depend on `calendar`. It reads `fm.date`, not
 * "calendar events": a note with a date, a task with a due date and an imported meeting are
 * the same thing to it. Depending on `calendar` would make a generic view need a plugin
 * that fetches ICS feeds.
 *
 * # The two halves of the screen
 *
 * | Half | Source | Pure logic |
 * |---|---|---|
 * | Coming up | `exists fm.date`, bucketed by civil day | `dates.ts`, `upcoming.ts` |
 * | Open tasks | every document that might hold a task list, scanned line by line | `queries.ts`, `tasks.ts` |
 *
 * Task *semantics* are not this plugin's: the markers, their icons, their labels and which
 * of them count as done all come from `markdown`'s `markdown.taskState` registry, read live
 * (SPEC §6.6). That is why `markdown` is a declared dependency — the agenda also asks it for
 * the body region of a document, so a checkbox-looking line inside a `%%%` machine section
 * is not mistaken for somebody's task (SPEC §3.1).
 *
 * # Jumping to a line
 *
 * A task's row navigates to `#/doc/<id>?line=<n>`. The line is a **query parameter**
 * because the router matches on the path only and ignores the query, so the link works today
 * (it opens the document) and gets better for free the day the document surface honours it.
 *
 * INTEGRATION (base-docs): `document-surface` receives route `params` only, not the query
 * string, and neither it nor `editor` reads `line` — so the jump currently lands at the top
 * of the document. What would finish it: `document-surface` reading `router.query()` and
 * passing an optional `line` down to the active `document.mode`, and `editor` dispatching a
 * `EditorView.scrollIntoView` for that line once its `Y.Text` has hydrated. The `viewer`
 * equivalent is `scrollIntoView` on the rendered node. Nothing in this plugin needs to
 * change for that: the URL it produces is already the contract.
 *
 * Owner: the **agenda-admin** builder (`backend/CONTRACTS.md`).
 */

import type { ReactElement } from "react";

import type { DocumentRow, Kernel } from "@kernel";

import {
  POINTS,
  type Command,
  type MainView,
  type NavbarItem,
  type Route,
  type SidebarPanel,
} from "../../_shared/points.js";

import {
  AgendaDashboard,
  DEFAULT_HORIZON_DAYS,
  TaskList,
  UpcomingList,
  type AgendaSurfaceProps,
} from "./AgendaView.js";
import { todayKey, type DayKey } from "./dates.js";
import { ROW_LIMIT } from "./queries.js";
import type { Region } from "./tasks.js";
import { groupsOf, type AgendaGroup } from "./upcoming.js";

export { DEFAULT_HORIZON_DAYS, ROW_LIMIT };
export type { AgendaGroup };

/** The path the navbar item, the command and the route all agree on. */
export const AGENDA_PATH = "/agenda";

export interface AgendaApi {
  /** Group dated rows into the agenda's buckets — pure, and the part worth testing. */
  groupsOf(rows: readonly DocumentRow[], today: DayKey, horizonDays: number): readonly AgendaGroup[];
  /** Today, in the viewer's own time zone — the boundary every bucket is relative to. */
  today(): DayKey;
  /** Open the dashboard. */
  open(): void;
  /** Navigate to a document, at a line when one is known (see the note above). */
  openDocument(id: string, line?: number): void;
}

/** `router`'s API, structurally — never an import (SPEC §6.1). */
interface RouterService {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  documentPath(id: string): string;
}

/**
 * `markdown`'s API, structurally: the two things the agenda asks of it.
 *
 * Declared as the narrowest possible subset so a change to anything else in `MarkdownApi`
 * cannot break this plugin's build, and so it is obvious from here what the dependency is
 * actually for.
 */
interface MarkdownService {
  /** Offsets of the three regions of one document text (SPEC §3.1). */
  regions(text: string): { readonly body: Region };
}

export default function activate(kernel: Kernel): AgendaApi {
  const router = kernel.services.require<RouterService>("router");
  // `get`, not `require`: `markdown` is declared, so this only returns `undefined` if it
  // failed to activate — in which case the agenda still works, it just scans the whole text
  // instead of the body. A thrown error here would take the agenda down with it for a
  // degradation the user would never notice.
  const markdown = kernel.services.get<MarkdownService>("markdown");

  const regionOf = markdown
    ? (text: string): Region | undefined => {
        try {
          return markdown.regions(text).body;
        } catch (cause) {
          kernel.log.warn("markdown.regions failed; scanning the whole text", cause);
          return undefined;
        }
      }
    : undefined;

  const openDocument = (id: string, line?: number): void => {
    const path = router.documentPath(id);
    router.navigate(line === undefined ? path : `${path}?line=${line}`);
  };

  const surface = (): AgendaSurfaceProps => ({
    documents: kernel.documents,
    extensions: kernel.extensions,
    openDocument,
    regionOf,
    horizonDays: DEFAULT_HORIZON_DAYS,
  });

  const Dashboard = (): ReactElement => <AgendaDashboard {...surface()} />;
  const Panel = (): ReactElement => <UpcomingList {...surface()} />;
  const TasksPanel = (): ReactElement => <TaskList {...surface()} />;

  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "agenda.view",
    component: Dashboard,
    title: "Agenda",
  });

  kernel.extensions.contribute<Route>(POINTS.route, {
    path: AGENDA_PATH,
    view: "agenda.view",
  });

  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "agenda.link",
    label: "Agenda",
    icon: "🗓",
    side: "start",
    order: 30,
    onSelect: () => router.navigate(AGENDA_PATH),
  });

  kernel.extensions.contribute<SidebarPanel>(POINTS.sidebarPanel, {
    id: "agenda.panel",
    title: "Coming up",
    component: Panel,
    order: 30,
    defaultOpen: true,
  });

  kernel.extensions.contribute<SidebarPanel>(POINTS.sidebarPanel, {
    id: "agenda.tasks",
    title: "Open tasks",
    component: TasksPanel,
    order: 31,
  });

  for (const command of [
    {
      id: "agenda.open",
      title: "Open the agenda",
      category: "Agenda",
      run: () => router.navigate(AGENDA_PATH),
    },
  ] satisfies Command[]) {
    kernel.extensions.contribute<Command>(POINTS.command, command);
  }

  return {
    groupsOf,
    today: () => todayKey(),
    open: () => router.navigate(AGENDA_PATH),
    openDocument,
  };
}
