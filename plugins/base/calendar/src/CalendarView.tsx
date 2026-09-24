/**
 * The view: a month grid, a week list, and one live query behind both.
 *
 * **Everything on screen comes from the projection.** `documents.subscribe` is a live local
 * query through the shared Wasm evaluator (SPEC §4.1, §4.2), so the grid renders offline,
 * renders before the first ICS sync has ever run, and updates the moment the change feed
 * carries an event in — with no polling, no cache to invalidate and no private channel
 * between this half and the backend one.
 *
 * **It renders every document with an `fm.date`**, not only imported events. A note dated
 * next Tuesday is on Tuesday. That is the point of sharing a field rather than a plugin API,
 * and it is why `agenda` can be a pure frontend plugin over the same data.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { DocumentQuery, DocumentQueryResult, DocumentRow, DocumentsApi } from "@kernel";

import {
  WEEKDAY_LABELS,
  type CalendarDay,
  type DayKey,
  type MonthKey,
  currentMonth,
  dayLabel,
  daysIn,
  isCancelled,
  isImported,
  listOf,
  monthGrid,
  monthLabel,
  monthOf,
  shiftMonth,
  timeLabel,
  todayKey,
  weekWindow,
  weeksOf,
  windowQuery,
} from "./dates.js";

/** Which shape the view is in. Per-user state, not stored: a glance, not a preference. */
export type ViewMode = "month" | "week";

export interface CalendarViewProps {
  readonly documents: DocumentsApi;
  /** Open a document — the router's job, injected so this file needs no kernel. */
  readonly onOpen: (id: string) => void;
  /** Ask the backend half to sync now. Absent ⇒ the button is not offered. */
  readonly onSync?: () => void;
  /** The month to show first (`YYYY-MM`); defaults to the viewer's current month. */
  readonly month?: MonthKey;
  /** Reports the month on screen, so the plugin's API can answer `current()`. */
  readonly onMonthChange?: (month: MonthKey) => void;
  /** Injectable clock, so "today" is assertable. */
  readonly now?: () => Date;
}

export function CalendarView(props: CalendarViewProps): ReactElement {
  const now = props.now ?? (() => new Date());
  const today = todayKey(now());

  const [month, setMonth] = useState<MonthKey>(props.month ?? monthOf(today));
  const [mode, setMode] = useState<ViewMode>("month");
  // The week list needs a day, not a month; it follows the month the user pages to.
  const [focus, setFocus] = useState<DayKey>(today);

  // A month the caller (the router) changed wins over local paging.
  const requested = props.month;
  useEffect(() => {
    if (requested) setMonth(requested);
  }, [requested]);

  const report = props.onMonthChange;
  useEffect(() => {
    report?.(month);
  }, [month, report]);

  const window = useMemo(
    () => (mode === "month" ? monthGrid(month) : weekWindow(focus)),
    [mode, month, focus],
  );
  const query = useMemo<DocumentQuery>(() => windowQuery(window), [window]);
  const { rows, loading, error } = useLiveQuery(props.documents, query);

  const days = useMemo(
    () => daysIn(window, rows, mode === "month" ? month : undefined),
    [window, rows, mode, month],
  );

  const goToday = useCallback(() => {
    const key = todayKey(now());
    setFocus(key);
    setMonth(monthOf(key));
  }, [now]);

  const page = (delta: number): void => {
    if (mode === "month") {
      setMonth((current) => shiftMonth(current, delta));
      return;
    }
    const next = shiftDays(focus, delta * 7);
    setFocus(next);
    setMonth(monthOf(next));
  };

  return (
    <section className="lm-calendar" aria-label="Calendar">
      <header className="lm-calendar-header">
        <div className="lm-calendar-nav">
          <button
            type="button"
            className="lm-calendar-button"
            onClick={() => page(-1)}
            aria-label={mode === "month" ? "Previous month" : "Previous week"}
          >
            ‹
          </button>
          <h2 className="lm-calendar-title">
            {mode === "month" ? monthLabel(month) : `Week of ${dayLabel(window.start)}`}
          </h2>
          <button
            type="button"
            className="lm-calendar-button"
            onClick={() => page(1)}
            aria-label={mode === "month" ? "Next month" : "Next week"}
          >
            ›
          </button>
          <button type="button" className="lm-calendar-button" onClick={goToday}>
            Today
          </button>
        </div>
        <div className="lm-calendar-actions">
          <div className="lm-calendar-modes" role="group" aria-label="Calendar layout">
            {(["month", "week"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="lm-calendar-button"
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
              >
                {option === "month" ? "Month" : "Week"}
              </button>
            ))}
          </div>
          {props.onSync ? (
            <button type="button" className="lm-calendar-button" onClick={props.onSync}>
              Sync feed
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="lm-calendar-message" role="status">
          The calendar could not read the workspace: {error}
        </p>
      ) : null}

      {mode === "month" ? (
        <MonthGrid days={days} today={today} onOpen={props.onOpen} />
      ) : (
        <WeekList days={days} today={today} onOpen={props.onOpen} />
      )}

      <p className="lm-calendar-footnote">
        {loading
          ? "Reading the workspace…"
          : `${countRows(days)} dated document${countRows(days) === 1 ? "" : "s"} in view. ` +
            "Every document with a date appears here, imported or written by hand."}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The two layouts
// ---------------------------------------------------------------------------

interface LayoutProps {
  readonly days: readonly CalendarDay[];
  readonly today: DayKey;
  readonly onOpen: (id: string) => void;
}

function MonthGrid({ days, today, onOpen }: LayoutProps): ReactElement {
  return (
    <div className="lm-calendar-grid-wrap">
      <div className="lm-calendar-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="lm-calendar-weekday">
            {label}
          </span>
        ))}
      </div>
      <div className="lm-calendar-grid" role="grid" aria-label="Month">
        {weeksOf(days).map((week) => (
          <div key={week[0]?.date ?? "week"} className="lm-calendar-week" role="row">
            {week.map((day) => (
              <div
                key={day.date}
                role="gridcell"
                aria-label={dayLabel(day.date)}
                className={[
                  "lm-calendar-day",
                  day.inMonth ? "" : "lm-calendar-day-outside",
                  day.date === today ? "lm-calendar-day-today" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="lm-calendar-daynumber">{Number(day.date.slice(8, 10))}</span>
                {day.rows.map((row) => (
                  // Keyed by day *and* id: a multi-day row legitimately appears in several
                  // cells, and `key={row.id}` alone would collide across them.
                  <EventButton key={`${day.date}:${row.id}`} row={row} onOpen={onOpen} />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function WeekList({ days, today, onOpen }: LayoutProps): ReactElement {
  const withRows = listOf(days);
  if (withRows.length === 0) {
    return (
      <p className="lm-calendar-message">
        Nothing dated this week. Give any document a <code>date</code> in its frontmatter and it
        appears here.
      </p>
    );
  }
  return (
    <ol className="lm-calendar-list">
      {withRows.map((day) => (
        <li key={day.date} className="lm-calendar-list-day">
          <h3
            className={`lm-calendar-list-heading${
              day.date === today ? " lm-calendar-list-heading-today" : ""
            }`}
          >
            {dayLabel(day.date)}
            {day.date === today ? <span className="lm-calendar-badge">today</span> : null}
          </h3>
          <ul className="lm-calendar-list-events">
            {day.rows.map((row) => (
              <li key={`${day.date}:${row.id}`}>
                <EventButton row={row} onOpen={onOpen} withTime />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function EventButton({
  row,
  onOpen,
  withTime,
}: {
  readonly row: DocumentRow;
  readonly onOpen: (id: string) => void;
  readonly withTime?: boolean;
}): ReactElement {
  const time = timeLabel(row.fm["date"]);
  const cancelled = isCancelled(row);
  const className = [
    "lm-calendar-event",
    isImported(row) ? "lm-calendar-event-imported" : "",
    cancelled ? "lm-calendar-event-cancelled" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={className}
      // The whole point of writing events as documents: clicking one opens the document,
      // which is editable, searchable, linkable and offline like every other (SPEC §1).
      onClick={() => onOpen(row.id)}
      title={cancelled ? `${row.title} (cancelled in the feed)` : row.title}
    >
      {time ? <span className="lm-calendar-time">{time}</span> : null}
      <span className="lm-calendar-event-title">{row.title}</span>
      {withTime && cancelled ? <span className="lm-calendar-badge">cancelled</span> : null}
    </button>
  );
}

function countRows(days: readonly CalendarDay[]): number {
  const seen = new Set<string>();
  for (const day of days) for (const row of day.rows) seen.add(row.id);
  return seen.size;
}

function shiftDays(day: DayKey, delta: number): DayKey {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The live query, as a hook
// ---------------------------------------------------------------------------

interface LiveQueryState {
  readonly rows: DocumentQueryResult["rows"];
  readonly loading: boolean;
  readonly error?: string;
}

const EMPTY: LiveQueryState = { rows: [], loading: true };

/**
 * One subscription per query, closed on unmount and whenever the query changes.
 *
 * Three details that are all bugs when missed: the query is compared **by value** (a new
 * object every render would tear the subscription down and rebuild it); a `subscribe` that
 * resolves *after* unmount is closed immediately rather than left holding a listener on a
 * dead component; and a leaked subscription re-renders this view on every change anywhere in
 * the workspace, forever.
 *
 * `doc-list` has the same hook. It is duplicated rather than shared because plugins do not
 * import each other's files (SPEC §6.1) — each plugin is its own bundle, and the kernel
 * registry is the only sanctioned seam.
 */
function useLiveQuery(documents: DocumentsApi, query: DocumentQuery): LiveQueryState {
  const key = useMemo(() => JSON.stringify(query), [query]);
  const stable = useRef<DocumentQuery>(query);
  if (JSON.stringify(stable.current) !== key) stable.current = query;

  const [state, setState] = useState<LiveQueryState>(EMPTY);

  useEffect(() => {
    let live = true;
    let close: (() => void) | undefined;
    setState((current) => ({ ...current, loading: true }));

    void (async () => {
      try {
        const subscription = await documents.subscribe(stable.current);
        if (!live) {
          subscription.close();
          return;
        }
        const off = subscription.onChange((result) => {
          if (!live) return;
          setState({ rows: result.rows, loading: false });
        });
        close = () => {
          off();
          subscription.close();
        };
        setState({ rows: subscription.result.rows, loading: false });
      } catch (cause) {
        if (!live) return;
        setState({
          rows: [],
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();

    return () => {
      live = false;
      close?.();
    };
  }, [documents, key]);

  return state;
}

/** Re-exported for the plugin's API and its tests. */
export { currentMonth };
