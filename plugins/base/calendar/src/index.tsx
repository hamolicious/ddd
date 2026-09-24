/**
 * `calendar` — the frontend half of the M4 proof (SPEC §9 M4).
 *
 * **It reads documents, not a calendar API.** The backend half syncs an ICS feed into
 * machine-owned documents with `fm.date`; this half runs one live projection query over
 * that field and draws a month grid. There is no private channel between the halves, no
 * cache to invalidate and nothing to re-fetch: the change feed already carries every event
 * to every client, offline included (SPEC §1).
 *
 * Three consequences worth knowing before changing anything here:
 *
 * 1. **Every document with an `fm.date` appears**, not only imported events. A note dated
 *    next Tuesday is on Tuesday. That is the point of a shared field — and it is why
 *    `agenda` can be a pure frontend plugin over the same data.
 * 2. **It works offline and before the first sync completes.** The query is local
 *    (`kernel.documents.subscribe`), so the grid renders from the replicated projection.
 * 3. **The only thing it asks the server for is "sync now"** —
 *    `POST /api/plugins/calendar/sync` through `kernel.session.fetchPlugin`, which is
 *    session-authenticated. Everything else it needs is already local.
 *
 * Owner: the **calendar** builder (`backend/CONTRACTS.md`).
 */

import type { ReactElement } from "react";

import type { DocumentRow, Kernel } from "@kernel";

import {
  POINTS,
  type Command,
  type MainView,
  type NavbarItem,
  type Route,
} from "../../_shared/points.js";
import { CalendarView } from "./CalendarView.js";
import {
  type CalendarDay,
  type MonthKey,
  currentMonth,
  daysOf,
  isMonthKey,
  monthLabel,
} from "./dates.js";

/** The `%%%` section id the backend half writes. */
export const SECTION = "calendar";
/**
 * The frontmatter key the backend half matches events on.
 *
 * Hyphenated, and in **frontmatter** rather than in the machine section: the identity of an
 * imported event is portable, human-readable data that survives an export to plain markdown
 * (SPEC §3.3's own example spells it this way). The `%%%` section holds the sync bookkeeping
 * — `feed`, `status`, `sequence`, `all-day` — which is nobody's business but the plugin's.
 */
export const SOURCE_UID_KEY = "source-uid";
/** `fm.source` for a document this plugin imported. */
export const SOURCE_ICAL = "ical";

/** `plugin:calendar:synced` — what the backend half emits after a run (SPEC §6.3). */
export const SYNCED_EVENT = "plugin:calendar:synced";

/** What `emit_client("synced", …)` carries; the backend's `SyncSummary`. */
export interface SyncSummary {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly failed: number;
  readonly problems: number;
  readonly events: number;
  readonly feed: string;
  readonly unchanged_feed: boolean;
  readonly at: string;
}

export type { CalendarDay };

/** The plugin's API, for dependents (`agenda` deliberately does **not** use it). */
export interface CalendarApi {
  /** The month currently shown, `YYYY-MM`. */
  current(): string;
  /** Show a month. */
  show(month: string): void;
  /** Ask the backend half to sync now. Resolves with the run's summary. */
  syncNow(): Promise<SyncSummary>;
  /** Group rows by day for a month — pure, and the one piece worth unit-testing. */
  daysOf(month: string, rows: readonly DocumentRow[]): readonly CalendarDay[];
}

export default function activate(kernel: Kernel): CalendarApi {
  const router = kernel.services.require<RouterService>("router");

  /**
   * The month the view last reported.
   *
   * Kept here rather than read out of the DOM so `current()` answers even when the view is
   * not mounted — a dependent asking "which month is the calendar on" before the user has
   * opened it should get a month, not a throw.
   */
  let shown: MonthKey = currentMonth();

  const openDocument = (id: string): void => router.navigate(`/doc/${id}`);

  const syncNow = async (): Promise<SyncSummary> => {
    // `fetchPlugin` is the kernel's authenticated call to this plugin's own routes — it
    // carries the session under both credential carriers (cookie in a browser, bearer in
    // the shell), which a hand-built `fetch` would get wrong on Android only.
    const response = await kernel.session.fetchPlugin("/sync", { method: "POST" });
    if (!response.ok) throw new Error(`sync failed: ${response.status}`);
    return (await response.json()) as SyncSummary;
  };

  /**
   * The user-facing "sync now": never rejects, and reports a failure as a notice.
   *
   * It *can* fail for three unremarkable reasons — the browser is offline, the admin has not
   * entered a feed URL, or the feed's host is not in the approved `http.hosts` — and each of
   * them is an instruction, not a bug. A swallowed rejection here would leave the user
   * pressing a button that visibly does nothing.
   */
  const runSync = (): void => {
    void syncNow()
      .then((summary) => {
        kernel.ui.notify({
          id: "calendar.sync",
          level: "info",
          message: summary.unchanged_feed
            ? "The calendar feed has not changed."
            : `Calendar synced: ${summary.created} new, ${summary.updated} updated, ` +
              `${summary.cancelled} cancelled.`,
          detail:
            summary.problems > 0
              ? `${summary.problems} line(s) of the feed could not be read; the server log has the detail.`
              : undefined,
        });
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        kernel.log.error("calendar sync failed", cause);
        kernel.ui.notify({
          id: "calendar.sync",
          level: "error",
          message: "The calendar feed could not be synced.",
          detail:
            `${message}\n\n` +
            "Syncing needs the server: it holds the feed URL, the credentials and the " +
            "approved host list. Events already imported stay readable and editable offline.",
          actions: [{ label: "Try again", run: runSync }],
        });
      });
  };

  // ---------------------------------------------------------------------------
  // The view
  // ---------------------------------------------------------------------------

  /**
   * `/calendar` and `/calendar/:month` render the same view.
   *
   * A month in the URL makes a particular month linkable and survives a reload — and an
   * unparseable one falls back to the current month rather than rendering an empty grid for
   * the year 0: a URL is user input.
   */
  const CalendarHost = ({
    params,
  }: {
    readonly params?: Readonly<Record<string, string>>;
  }): ReactElement => {
    const requested = params?.["month"];
    // Passed through on every render, **not** frozen into state: the router re-renders this
    // same component with new params when the URL changes, so a captured initial value would
    // make `/calendar/2026-11` a no-op while the view is already mounted. The view syncs on
    // the prop changing and otherwise owns paging itself.
    const month = requested && isMonthKey(requested) ? requested : undefined;
    return (
      <CalendarView
        documents={kernel.documents}
        onOpen={openDocument}
        onSync={runSync}
        month={month}
        onMonthChange={(next) => {
          shown = next;
        }}
      />
    );
  };

  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "calendar.month",
    component: CalendarHost,
    title: "Calendar",
  });

  kernel.extensions.contribute<Route>(POINTS.route, {
    path: "/calendar",
    view: "calendar.month",
  });
  kernel.extensions.contribute<Route>(POINTS.route, {
    path: "/calendar/:month",
    view: "calendar.month",
  });

  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "calendar.open",
    label: "Calendar",
    order: 40,
    onSelect: () => router.navigate("/calendar"),
  });

  for (const command of [
    {
      id: "calendar.open",
      title: "Open the calendar",
      category: "Calendar",
      run: () => router.navigate("/calendar"),
    },
    {
      id: "calendar.today",
      title: "Calendar: go to this month",
      category: "Calendar",
      run: () => router.navigate(`/calendar/${currentMonth()}`),
    },
    {
      id: "calendar.sync",
      title: "Calendar: sync the feed now",
      category: "Calendar",
      run: runSync,
    },
  ] satisfies Command[]) {
    kernel.extensions.contribute<Command>(POINTS.command, command);
  }

  // The backend half's nudge. Nothing is *fetched* in response — the documents it wrote
  // are already arriving through the change feed — so this only surfaces the summary
  // (SPEC §6.3: events are for what cannot be a document).
  kernel.events.on<SyncSummary>(SYNCED_EVENT, (event) => {
    kernel.log.info("calendar synced", event.payload);
  });

  return {
    current: () => shown,
    show: (month) => {
      if (!isMonthKey(month)) {
        throw new Error(`\`${month}\` is not a month (expected YYYY-MM)`);
      }
      shown = month;
      router.navigate(`/calendar/${month}`);
    },
    syncNow,
    daysOf: (month, rows) => {
      if (!isMonthKey(month)) {
        throw new Error(`\`${month}\` is not a month (expected YYYY-MM)`);
      }
      return daysOf(month, rows);
    },
  };
}

/** Re-exported so a dependent can label a month the same way the view does. */
export { monthLabel };

/** `router`'s API, structurally — plugins never import each other (SPEC §6.1). */
interface RouterService {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  onChange(listener: (path: string) => void): () => void;
  current(): string;
}
