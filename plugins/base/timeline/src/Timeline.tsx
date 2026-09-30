/**
 * The timeline view: the search's notes along a horizontal time axis, bars from their
 * start field to their end field (points without one), split into lanes by a group field
 * (`layout.ts`).
 *
 * Like the calendar, it asks `search` for its own results, narrowed to the window on
 * screen, so a window is complete however long the search runs. The window's position is
 * screen state — ‹ and › move it, "Today" comes back — while the scale (days, weeks,
 * months) is a setting saved with the search.
 *
 * The axis scrolls sideways inside its box on a narrow screen: a column never gets too
 * narrow to read. Clicking a note opens it; right-clicking opens its menu (an `lm/document`).
 */

import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import type { Search } from "plugin:search";
import type { SavedViewProps } from "../../_shared/saved-view-mode.js";
import { target as mark } from "../../_shared/target.js";

import { layoutItems, shiftAnchor, timelineOptions, windowClauses, windowFor, type Item } from "./layout.js";

/** Notes fetched for one window. */
const PAGE = 500;
/** A column's least width, so labels stay legible; the box scrolls beyond that. */
const UNIT_PX = { day: 56, week: 72, month: 80 } as const;
const ROW_PX = 28;

export function createTimeline(search: () => Pick<Search, "useResults">) {
  return function TimelineView({ spec, options, onOpen }: SavedViewProps): ReactElement {
    const settings = timelineOptions(options);
    const [anchor, setAnchor] = useState(() => new Date());
    const frame = windowFor(anchor, settings.scale);
    const clauses = windowClauses(settings, frame);
    const starting = search().useResults(spec, { pageSize: PAGE, within: clauses.starts });
    // Without an end field the second search is the first again, and adds nothing.
    const spanning = search().useResults(spec, { pageSize: PAGE, within: clauses.spans ?? clauses.starts });
    const rows = useMemo(() => {
      const seen = new Set(starting.rows.map((row) => row.id));
      return [...starting.rows, ...spanning.rows.filter((row) => !seen.has(row.id))];
    }, [starting.rows, spanning.rows]);
    const results = {
      rows,
      loading: starting.loading || spanning.loading,
      hasMore: starting.hasMore || spanning.hasMore,
      more: () => {
        if (starting.hasMore) starting.more();
        if (spanning.hasMore) spanning.more();
      },
    };
    const lanes = layoutItems(rows, settings, frame);
    const span = frame.to.getTime() - frame.from.getTime();
    const now = (Date.now() - frame.from.getTime()) / span;
    const width = frame.units.length * UNIT_PX[settings.scale];
    const groupName = settings.group.replace(/^fm\./, "");
    const empty = lanes.length === 0;

    const range = `${frame.from.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} – ${new Date(frame.to.getTime() - 1).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;

    return (
      <div className="timeline-view timeline:flex timeline:min-w-0 timeline:flex-col timeline:gap-2 timeline:font-sans timeline:text-text">
        <div className="timeline:flex timeline:items-center timeline:gap-2">
          <h3 className="timeline:m-0 timeline:flex-1 timeline:text-base timeline:font-semibold" aria-live="polite">
            {range}
          </h3>
          {results.loading && <span className="timeline:text-sm timeline:text-text-muted">Loading…</span>}
          <button type="button" aria-label="Earlier" onClick={() => setAnchor((current) => shiftAnchor(current, settings.scale, -1))}>
            ‹
          </button>
          <button type="button" onClick={() => setAnchor(new Date())}>
            Today
          </button>
          <button type="button" aria-label="Later" onClick={() => setAnchor((current) => shiftAnchor(current, settings.scale, 1))}>
            ›
          </button>
        </div>

        <div className="timeline-box timeline:min-w-0 timeline:overflow-x-auto timeline:overflow-y-hidden timeline:rounded timeline:border timeline:border-border">
          <div className="timeline:relative" style={{ minWidth: width }}>
            {/* Column lines and today, behind everything. */}
            <div aria-hidden="true" className="timeline:pointer-events-none timeline:absolute timeline:inset-0">
              {frame.units.map((unit) => (
                <div
                  key={unit.start.getTime()}
                  className="timeline:absolute timeline:inset-y-0 timeline:border-l timeline:border-border"
                  style={{ left: `${((unit.start.getTime() - frame.from.getTime()) / span) * 100}%` }}
                />
              ))}
              {now >= 0 && now < 1 && (
                <div className="timeline:absolute timeline:inset-y-0 timeline:w-0.5 timeline:bg-accent" style={{ left: `${now * 100}%` }} />
              )}
            </div>

            <div className="timeline:relative timeline:flex timeline:border-b timeline:border-border timeline:bg-bg-subtle">
              {frame.units.map((unit, index) => {
                const next = frame.units[index + 1]?.start ?? frame.to;
                return (
                  <div
                    key={unit.start.getTime()}
                    className="timeline:truncate timeline:px-1.5 timeline:py-1 timeline:text-xs timeline:font-semibold timeline:text-text-muted"
                    style={{ width: `${((next.getTime() - unit.start.getTime()) / span) * 100}%` }}
                  >
                    {unit.label}
                  </div>
                );
              })}
            </div>

            {empty ? (
              <p className="timeline:relative timeline:m-0 timeline:px-2 timeline:py-6 timeline:text-sm timeline:text-text-muted">
                Nothing in this stretch of time. ‹ and › move along it.
              </p>
            ) : (
              lanes.map((lane) => (
                <section key={lane.name ?? "\u0000"} className="timeline:relative timeline:border-b timeline:border-border timeline:py-1 timeline:last:border-b-0">
                  {settings.group !== "" && (
                    <h4 className="timeline:sticky timeline:left-0 timeline:m-0 timeline:inline-block timeline:bg-bg timeline:px-1.5 timeline:text-xs timeline:font-semibold timeline:text-text-muted">
                      {lane.name ?? `No ${groupName}`}
                    </h4>
                  )}
                  {lane.rows.map((items, index) => (
                    <div key={index} className="timeline:relative" style={{ height: ROW_PX }}>
                      {items.map((item) => (
                        <Bar key={item.row.id} item={item} onOpen={onOpen} />
                      ))}
                    </div>
                  ))}
                </section>
              ))
            )}
          </div>
        </div>
        {results.hasMore && (
          <p className="timeline:m-0 timeline:text-sm timeline:text-text-muted">
            Showing the first {results.rows.length.toLocaleString()} notes in this stretch.{" "}
            <button type="button" onClick={results.more}>
              Load more
            </button>
          </p>
        )}
      </div>
    );
  };
}

function Bar({
  item,
  onOpen,
}: {
  readonly item: Item;
  readonly onOpen: (id: string) => void;
}): ReactElement {
  const left = Math.max(0, item.left);
  const right = Math.min(1, item.right);
  const when = item.point
    ? item.start.toLocaleString()
    : `${item.start.toLocaleDateString()} – ${new Date(item.end.getTime() - 1).toLocaleDateString()}`;
  const marked = mark("lm/document", item.row.id, { label: item.row.title });
  return item.point ? (
    <button
      type="button"
      className="timeline:absolute timeline:top-1 timeline:flex timeline:h-5 timeline:min-h-0! timeline:max-w-[14rem] timeline:items-center timeline:gap-1 timeline:border-0! timeline:bg-transparent! timeline:p-0! timeline:text-xs timeline:text-text"
      style={{ left: `${left * 100}%` }}
      title={`${item.row.title} · ${when}`}
      onClick={() => onOpen(item.row.id)}
      {...marked}
    >
      <span aria-hidden="true" className="timeline:size-2.5 timeline:shrink-0 timeline:-translate-x-1/2 timeline:rotate-45 timeline:bg-accent" />
      <span className="timeline:truncate">{item.row.title}</span>
    </button>
  ) : (
    <button
      type="button"
      className="timeline:absolute timeline:top-1 timeline:h-5 timeline:min-h-0! timeline:min-w-1.5 timeline:truncate timeline:rounded timeline:border-0! timeline:bg-accent-subtle! timeline:px-1.5! timeline:py-0! timeline:text-left timeline:text-xs timeline:leading-5 timeline:text-text timeline:shadow-[inset_3px_0_0_var(--lm-accent)]"
      style={{ left: `${left * 100}%`, width: `${Math.max(0, right - left) * 100}%` }}
      title={`${item.row.title} · ${when}`}
      onClick={() => onOpen(item.row.id)}
      {...marked}
    >
      {item.row.title}
    </button>
  );
}
