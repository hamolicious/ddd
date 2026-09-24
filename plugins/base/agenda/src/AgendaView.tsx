/**
 * The agenda's two surfaces: the sidebar panel (what is coming up) and the dashboard page
 * (what is coming up **and** every open task in the workspace).
 *
 * Both render from live projection queries and nothing else — no REST, no server-side
 * aggregation — so the whole screen works offline, which is the point the plugin is here to
 * make (SPEC §4.1: every document is readable and searchable offline).
 *
 * Decisions visible on screen, and why:
 *
 * - **Custom task states render with their own icon and label** (SPEC §6.6). The icon comes
 *   from the live `markdown.taskState` registry, so a plugin contributing `[/]` shows its
 *   marker here without this plugin knowing it exists.
 * - **`done?` decides counts, not the character.** A state whose contribution says
 *   `done: true` is completed however it is spelled, and a marker nothing registered is
 *   **not a task at all** — it renders as literal text in the document, so counting it here
 *   would promise a checkbox that is not on screen. Those markers are reported per document
 *   instead, with the one sentence that explains why another client might count differently
 *   (SPEC §11.7).
 * - **Clicking jumps to the document**, carrying the task's line in the URL. See
 *   `index.tsx` for why the line is a query parameter and what has to change for it to
 *   scroll.
 * - **Nothing here reorders itself as tasks are ticked.** Folders sort alphabetically with
 *   the unfiled bucket last, documents by title, tasks in document order; a list that
 *   reshuffles under the pointer is one you lose your place in.
 */

import { useMemo } from "react";
import type { ReactElement, ReactNode } from "react";

import type { DocumentsApi, ExtensionsApi } from "@kernel";

import { POINTS, type MarkdownTaskState } from "../../_shared/points.js";

import { todayKey, type DayKey } from "./dates.js";
import { useContributions, useLiveQuery } from "./hooks.js";
import { horizonQuery, overdueQuery, taskQuery, ROW_LIMIT } from "./queries.js";
import {
  countTasks,
  groupTasks,
  type DocumentTasks,
  type FolderTasks,
  type Region,
  type ScannedTask,
} from "./tasks.js";
import { dayOf, groupsOf, timeOf } from "./upcoming.js";

/** How far ahead the agenda looks by default. */
export const DEFAULT_HORIZON_DAYS = 14;

export interface AgendaSurfaceProps {
  readonly documents: DocumentsApi;
  readonly extensions: ExtensionsApi;
  /** Navigate to a document, optionally at a line (see `index.tsx`). */
  readonly openDocument: (id: string, line?: number) => void;
  /** The body region of a document text — `markdown.regions(text).body` (SPEC §3.1). */
  readonly regionOf?: (text: string) => Region | undefined;
  readonly horizonDays?: number;
  /** Fixed "today", for tests and for a render that must not depend on the clock. */
  readonly today?: DayKey;
}

// ---------------------------------------------------------------------------
// Upcoming — the dated half
// ---------------------------------------------------------------------------

/**
 * Dated documents, grouped by day.
 *
 * One component for the sidebar panel and the dashboard section: they differ in width, not in
 * content, and a "compact" variant that showed less would be a second thing to keep correct.
 *
 * # Two queries, not one
 *
 * The two buckets have opposite shapes and so cannot share a query. The horizon is a closed
 * date range and wants *all* of it; Overdue is open-ended and wants the *newest* slice of it.
 * One `exists fm.date` query ascending gave the oldest rows in the workspace, so a workspace
 * with more dated documents than the row limit — which the calendar's ICS import produces on
 * its first run — showed nothing at all under Today (see `queries.ts`). Two bounded queries
 * cost one extra subscription and make each bucket's truncation mean something.
 */
export function UpcomingList(props: AgendaSurfaceProps): ReactElement {
  const { documents, openDocument } = props;
  const today = props.today ?? todayKey();
  const horizon = props.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const upcoming = useLiveQuery(
    documents,
    useMemo(() => horizonQuery(today, horizon, ROW_LIMIT), [today, horizon]),
  );
  const overdue = useLiveQuery(
    documents,
    useMemo(() => overdueQuery(today, ROW_LIMIT), [today]),
  );
  const rows = useMemo(() => [...overdue.rows, ...upcoming.rows], [overdue.rows, upcoming.rows]);
  const groups = useMemo(() => groupsOf(rows, today, horizon), [rows, today, horizon]);

  // Either query failing is a failure of the panel: half an agenda presented as a whole one
  // is worse than saying so.
  const error = upcoming.error ?? overdue.error;
  const state = {
    loading: upcoming.loading || overdue.loading,
    rows: rows.length,
    total: upcoming.total + overdue.total,
  };

  if (error !== undefined) {
    return (
      <p className="lm-agenda-error" role="alert">
        The agenda could not read the workspace: {error}
      </p>
    );
  }
  if (state.loading) return <p className="lm-agenda-empty" role="status">Reading the workspace…</p>;
  if (groups.length === 0) {
    return (
      <p className="lm-agenda-empty">
        Nothing dated in the next {horizon} days. Give a document a <code>date</code> in its
        frontmatter and it appears here.
      </p>
    );
  }

  return (
    <div className="lm-agenda">
      {groups.map((group) => (
        <section
          key={group.key}
          className={group.key === "overdue" ? "lm-agenda-group lm-agenda-overdue" : "lm-agenda-group"}
          aria-labelledby={`lm-agenda-day-${group.key}`}
        >
          <h4 className="lm-agenda-group-label" id={`lm-agenda-day-${group.key}`}>
            {group.label}
            <span className="lm-agenda-count"> · {group.rows.length}</span>
          </h4>
          <ul className="lm-agenda-items">
            {group.rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="lm-agenda-item"
                  onClick={() => openDocument(row.id)}
                >
                  {/* The heading already says the day, except in the overdue bucket, which
                      spans many — there the date is the only thing that orders the list. */}
                  <span className="lm-agenda-time">
                    {group.key === "overdue" ? (dayOf(row) ?? "") : (timeOf(row) ?? "")}
                  </span>
                  <span className="lm-agenda-title">{row.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {state.total > state.rows && (
        <p className="lm-agenda-note">
          Showing {state.rows} of {state.total} dated documents in and before this window.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks — the scanning half
// ---------------------------------------------------------------------------

/** Every open task in the workspace, grouped by folder and then by document. */
export function TaskList(
  props: AgendaSurfaceProps & { readonly includeCompleted?: boolean },
): ReactElement {
  const { documents, extensions, openDocument, regionOf, includeCompleted } = props;
  const states = useContributions<MarkdownTaskState>(extensions, POINTS.markdownTaskState);
  const query = useMemo(() => taskQuery(ROW_LIMIT), []);
  const state = useLiveQuery(documents, query);

  const icons = useMemo(() => {
    const map = new Map<string, MarkdownTaskState>();
    for (const entry of states) if (!map.has(entry.marker)) map.set(entry.marker, entry);
    return map;
  }, [states]);

  const groups = useMemo(
    () => groupTasks(state.rows, states, { includeCompleted, regionOf }),
    [state.rows, states, includeCompleted, regionOf],
  );
  const totals = useMemo(() => countTasks(groups), [groups]);

  if (state.error !== undefined) {
    return (
      <p className="lm-agenda-error" role="alert">
        The task list could not read the workspace: {state.error}
      </p>
    );
  }
  if (state.loading) {
    return (
      <p className="lm-agenda-empty" role="status">
        Scanning documents for tasks…
      </p>
    );
  }
  if (states.length === 0) {
    return (
      <p className="lm-agenda-empty">
        No task states are registered on this client, so no marker means anything here. Task
        markers come from the <code>markdown</code> plugin’s <code>markdown.taskState</code>{" "}
        registry.
      </p>
    );
  }
  if (groups.length === 0) {
    return (
      <p className="lm-agenda-empty">
        No open tasks. Write <code>- [ ] something</code> in any document and it shows up
        here.
      </p>
    );
  }

  return (
    <div className="lm-agenda-tasks">
      <p className="lm-agenda-totals" role="status">
        <strong>{totals.open}</strong> open {totals.open === 1 ? "task" : "tasks"} across{" "}
        {totals.documents} {totals.documents === 1 ? "document" : "documents"}
        {totals.done > 0 && <> · {totals.done} done</>}
      </p>
      {groups.map((folder) => (
        <FolderGroup
          key={folder.folder === "" ? " unfiled" : folder.folder}
          folder={folder}
          icons={icons}
          openDocument={openDocument}
        />
      ))}
      {state.total > state.rows.length && (
        <p className="lm-agenda-note">
          Scanned {state.rows.length} of {state.total} documents that might contain tasks —
          narrow the workspace or open a folder for the rest.
        </p>
      )}
    </div>
  );
}

function FolderGroup({
  folder,
  icons,
  openDocument,
}: {
  readonly folder: FolderTasks;
  readonly icons: ReadonlyMap<string, MarkdownTaskState>;
  readonly openDocument: (id: string, line?: number) => void;
}): ReactElement {
  const id = `lm-agenda-folder-${folder.folder.replace(/[^a-zA-Z0-9]+/g, "-") || "unfiled"}`;
  return (
    <section className="lm-agenda-folder" aria-labelledby={id}>
      <h4 className="lm-agenda-group-label" id={id}>
        {folder.label}
        <span className="lm-agenda-count">
          {" "}
          · {folder.openCount} open{folder.doneCount > 0 ? ` · ${folder.doneCount} done` : ""}
        </span>
      </h4>
      {folder.documents.map((entry) => (
        <DocumentGroup
          key={entry.id}
          entry={entry}
          icons={icons}
          openDocument={openDocument}
        />
      ))}
    </section>
  );
}

function DocumentGroup({
  entry,
  icons,
  openDocument,
}: {
  readonly entry: DocumentTasks;
  readonly icons: ReadonlyMap<string, MarkdownTaskState>;
  readonly openDocument: (id: string, line?: number) => void;
}): ReactElement {
  return (
    <div className="lm-agenda-doc">
      <p className="lm-agenda-doc-head">
        <button
          type="button"
          className="lm-agenda-doc-link"
          onClick={() => openDocument(entry.id)}
          title="Open this document"
        >
          {entry.title}
        </button>
        <span className="lm-agenda-count">
          {entry.open.length} of {entry.total}
        </span>
      </p>
      <ul className="lm-agenda-items">
        {entry.open.map((task) => (
          <li key={`${task.offset}`}>
            <TaskRow task={task} icon={icons.get(task.marker)} onOpen={() => openDocument(entry.id, task.line)} />
          </li>
        ))}
      </ul>
      {entry.unrecognized.length > 0 && (
        <p className="lm-agenda-unrecognized">
          {entry.unrecognized.length}{" "}
          {entry.unrecognized.length === 1 ? "marker" : "markers"} in this document (
          {[...new Set(entry.unrecognized.map((task) => `[${task.marker}]`))].join(" ")}) are not
          registered on this client, so they are read as plain text and are not counted.
        </p>
      )}
    </div>
  );
}

function TaskRow({
  task,
  icon,
  onOpen,
}: {
  readonly task: ScannedTask;
  readonly icon: MarkdownTaskState | undefined;
  readonly onOpen: () => void;
}): ReactElement {
  const label: ReactNode = icon?.icon ?? "☐";
  return (
    <button
      type="button"
      className="lm-agenda-item lm-agenda-task"
      style={task.indent > 0 ? { paddingInlineStart: `${Math.min(task.indent, 12) * 0.5 + 0.5}rem` } : undefined}
      onClick={onOpen}
      title={`${icon?.label ?? "Unknown state"} — open at line ${task.line}`}
    >
      <span className="lm-agenda-marker" aria-hidden="true">
        {label}
      </span>
      <span className="lm-agenda-title">
        {task.text === "" ? <em>(empty task)</em> : task.text}
      </span>
      <span className="lm-agenda-state">{icon?.label ?? task.marker}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

/** The `/agenda` page: what is coming up, then what is still open. */
export function AgendaDashboard(props: AgendaSurfaceProps): ReactElement {
  const today = props.today ?? todayKey();
  return (
    <div className="lm-agenda-page">
      <header className="lm-agenda-header">
        <h2>Agenda</h2>
        <p className="lm-agenda-subtitle">
          Everything dated in the next {props.horizonDays ?? DEFAULT_HORIZON_DAYS} days, and
          every open task in the workspace. Read from the local projection, so it is the same
          offline.
        </p>
      </header>

      <section className="lm-agenda-section" aria-labelledby="lm-agenda-upcoming">
        <h3 id="lm-agenda-upcoming">Coming up</h3>
        <UpcomingList {...props} today={today} />
      </section>

      <section className="lm-agenda-section" aria-labelledby="lm-agenda-open">
        <h3 id="lm-agenda-open">Open tasks</h3>
        <TaskList {...props} today={today} />
      </section>
    </div>
  );
}
