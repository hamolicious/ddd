/**
 * The calendar view: a month grid of the search's notes, each on the day the view's date
 * field gives it (and across to its end field's day, when one is set).
 *
 * It asks for its own results rather than drawing the page's: the search narrowed to the
 * weeks on screen (`within`), so a month is complete however long the search's results
 * run. The month is screen state — ‹ and › move it, "Today" comes back — and not part of
 * the search, so a saved calendar always opens on this month.
 *
 * A day shows its first few notes and "+N more"; choosing a day lists all of them under
 * the grid. On a phone the cells are too small for titles, so each shows dots, and the
 * list under the grid is how its notes are read. Each note is marked as an `lm/document`,
 * so right-clicking or long-pressing one opens its menu (`context-menu`'s).
 *
 * **A note looks like itself.** Its chip wears the colour and icon `folders` gives it — the
 * tree's look, as `markdown`'s links wear it — followed live; a phone's dot takes its
 * colour. Without `folders`, or for a note with no look, the chip is the accent tint.
 */

import { useState } from "react";
import type { ReactElement } from "react";

import type { DocumentRow } from "@kernel";
import type { Search } from "plugin:search";
import type { SavedViewProps } from "../../_shared/saved-view-mode.js";

import { isoDay, sameDay, startOfMonth } from "../../_shared/dates.js";
import { NoteLabel, lookOf, lookStyle, useLookChanges, type Looks } from "../../_shared/note-look.js";
import { Spinner } from "../../_shared/Spinner.js";
import { target as mark } from "../../_shared/target.js";

import { calendarOptions, entriesByDay, gridClauses, monthGrid, shiftMonth, type Entry } from "./layout.js";

/** Notes a day cell lists before "+N more". */
const SHOWN = 3;
/** Notes fetched for one grid: six weeks rarely hold more. */
const PAGE = 500;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function createCalendar(search: () => Pick<Search, "useResults">, looks: () => Looks | undefined) {
  return function CalendarView({ spec, options, onOpen, embedded }: SavedViewProps): ReactElement {
    const dress = looks();
    // Re-draw when a note's colour or icon changes in the tree.
    useLookChanges(dress);
    const settings = calendarOptions(options);
    const [month, setMonth] = useState(() => startOfMonth(new Date()));
    const [selected, setSelected] = useState<string | undefined>(undefined);
    const grid = monthGrid(month);
    const from = grid[0] as Date;
    const to = grid[grid.length - 1] as Date;
    const results = search().useResults(spec, { pageSize: PAGE, within: gridClauses(settings, from, to) });
    const days = entriesByDay(results.rows, settings, from, new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1));
    const today = new Date();
    const chosen = selected === undefined ? undefined : days.get(selected) ?? [];

    const open = (row: DocumentRow) => () => onOpen(row.id);

    return (
      <div className="calendar-view calendar:flex calendar:min-w-0 calendar:flex-col calendar:gap-2 calendar:font-sans calendar:text-text">
        {/* Clear of the search's cog over the top right (32px, and the shell's 12px gap beside it). */}
        <div className={`calendar:flex calendar:items-center calendar:gap-2 ${embedded ? "" : "calendar:pr-11"}`}>
          <h3 className="calendar:m-0 calendar:flex-1 calendar:text-base calendar:font-semibold" aria-live="polite">
            {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </h3>
          {results.loading && <Spinner />}
          <button type="button" aria-label="Previous month" onClick={() => setMonth((current) => shiftMonth(current, -1))}>
            ‹
          </button>
          <button type="button" onClick={() => setMonth(startOfMonth(new Date()))}>
            Today
          </button>
          <button type="button" aria-label="Next month" onClick={() => setMonth((current) => shiftMonth(current, 1))}>
            ›
          </button>
        </div>

        <div className="calendar-grid calendar:grid calendar:grid-cols-7 calendar:overflow-hidden calendar:rounded calendar:border calendar:border-border" role="grid">
          {WEEKDAYS.map((name) => (
            <div key={name} role="columnheader" className="calendar:border-b calendar:border-border calendar:bg-bg-subtle calendar:px-1.5 calendar:py-1 calendar:text-xs calendar:font-semibold calendar:uppercase calendar:text-text-muted">
              {name}
            </div>
          ))}
          {grid.map((day, index) => {
            const key = isoDay(day);
            const entries = days.get(key) ?? [];
            const outside = day.getMonth() !== month.getMonth();
            const isToday = sameDay(day, today);
            return (
              <div
                key={key}
                role="gridcell"
                aria-selected={selected === key}
                className={`calendar-day calendar:flex calendar:min-h-24 calendar:min-w-0 calendar:flex-col calendar:gap-0.5 calendar:p-1 calendar:compact:min-h-12 ${index % 7 !== 6 ? "calendar:border-r" : ""} ${index < GRID_ROWS_LAST ? "calendar:border-b" : ""} calendar:border-border ${outside ? "calendar:bg-bg-subtle" : ""} ${selected === key ? "calendar:ring-2 calendar:ring-inset calendar:ring-accent" : ""}`}
              >
                <button
                  type="button"
                  className={`calendar:min-h-0! calendar:self-start calendar:rounded-full calendar:border-0! calendar:px-1.5! calendar:py-0! calendar:text-sm calendar:leading-6 ${isToday ? "calendar:bg-accent! calendar:text-accent-text" : "calendar:bg-transparent!"} ${outside ? "calendar:text-text-muted" : ""}`}
                  aria-label={`${day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}, ${entries.length} note${entries.length === 1 ? "" : "s"}`}
                  onClick={() => setSelected((current) => (current === key ? undefined : key))}
                >
                  {day.getDate()}
                </button>
                <ul className="calendar:m-0 calendar:flex calendar:list-none calendar:flex-col calendar:gap-0.5 calendar:p-0 calendar:compact:hidden">
                  {entries.slice(0, SHOWN).map((entry) => {
                    const look = lookOf(dress, entry.row.id);
                    return (
                      <li key={entry.row.id} className="calendar:min-w-0">
                        <button
                          type="button"
                          className={`calendar:block calendar:min-h-0! calendar:w-full calendar:rounded calendar:border-0! calendar:px-1! calendar:py-0! calendar:text-left calendar:text-xs calendar:leading-5 ${look?.background ? "" : "calendar:bg-accent-subtle!"} ${look?.color ? "" : "calendar:text-text"}`}
                          style={lookStyle(look)}
                          title={entry.row.title}
                          onClick={open(entry.row)}
                          {...mark("lm/document", entry.row.id, { label: entry.row.title })}
                        >
                          <NoteLabel title={entry.row.title} look={look} />
                        </button>
                      </li>
                    );
                  })}
                  {entries.length > SHOWN && (
                    <li>
                      <button
                        type="button"
                        className="calendar:min-h-0! calendar:border-0! calendar:bg-transparent! calendar:p-0! calendar:text-xs calendar:text-text-muted calendar:hover:text-text"
                        onClick={() => setSelected(key)}
                      >
                        +{entries.length - SHOWN} more
                      </button>
                    </li>
                  )}
                </ul>
                {entries.length > 0 && (
                  <span aria-hidden="true" className="calendar:hidden calendar:compact:flex calendar:flex-wrap calendar:gap-0.5">
                    {entries.slice(0, 4).map((entry) => {
                      const look = lookOf(dress, entry.row.id);
                      const colour = look?.background ?? look?.color;
                      return (
                        <span
                          key={entry.row.id}
                          className={`calendar:size-1.5 calendar:rounded-full ${colour ? "" : "calendar:bg-accent"}`}
                          style={colour ? { background: colour } : undefined}
                        />
                      );
                    })}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {chosen !== undefined && selected !== undefined && (
          <DayList day={selected} entries={chosen} looks={dress} onOpen={open} />
        )}
      </div>
    );
  };
}

/** Index of the first cell in the grid's last row: the cells before it get a bottom border. */
const GRID_ROWS_LAST = 35;

function DayList({
  day,
  entries,
  looks,
  onOpen,
}: {
  readonly day: string;
  readonly entries: readonly Entry[];
  readonly looks: Looks | undefined;
  readonly onOpen: (row: DocumentRow) => () => void;
}): ReactElement {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const label = new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return (
    <section aria-label={label} className="calendar:flex calendar:flex-col calendar:gap-1">
      <h4 className="calendar:m-0 calendar:text-sm calendar:font-semibold">{label}</h4>
      {entries.length === 0 ? (
        <p className="calendar:m-0 calendar:text-sm calendar:text-text-muted">Nothing on this day.</p>
      ) : (
        <ul className="calendar:m-0 calendar:flex calendar:list-none calendar:flex-col calendar:gap-1 calendar:p-0">
          {entries.map((entry) => {
            const look = lookOf(looks, entry.row.id);
            return (
              <li key={entry.row.id}>
                <button
                  type="button"
                  className={`calendar:flex calendar:w-full calendar:max-w-full calendar:items-center calendar:border-0! calendar:text-left ${look?.background ? "calendar:w-auto calendar:rounded-full calendar:px-2!" : "calendar:bg-transparent! calendar:px-0!"} ${look?.color ? "" : "calendar:text-link"}`}
                  style={lookStyle(look)}
                  onClick={onOpen(entry.row)}
                  {...mark("lm/document", entry.row.id, { label: entry.row.title })}
                >
                  <NoteLabel title={entry.row.title} look={look} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export type { Looks };
