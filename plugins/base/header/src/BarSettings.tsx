/**
 * "Top bar" in Settings: reorder the bar's items within a seat, move one to the other
 * seat, or hide it. A hidden item stays in this list, dimmed, with its place kept, so
 * it can always be shown again. Buttons rather than drag and drop, so it works the same with a keyboard
 * and on a phone.
 *
 * The first change saves the *whole* current order of both seats, so after it every
 * item on screen is pinned where the user left it; an item installed later lands after
 * them, on its own side, in `order` (`layout.ts`).
 */

import { useState, type ReactNode } from "react";

import type { Registry } from "@kernel";

import { useRegistry } from "../../_shared/boundary.js";

import type { NavbarItem } from "./api.js";
import type { ArrangementStore } from "./arrangement.js";
import { useArrangement } from "./hooks.js";
import { SEATS, arrange, move, toggleHidden, type Arrangement, type Seat } from "./layout.js";

const SEAT_TITLES: Record<Seat, string> = {
  start: "Start — left-hand side",
  end: "End — right-hand side",
};

const BUTTON = "header:tap header:inline-flex header:items-center header:justify-center header:p-0";

export function BarSettings({
  items: host,
  store,
}: {
  readonly items: Registry<NavbarItem>;
  readonly store: ArrangementStore;
}): ReactNode {
  const items = useRegistry(host);
  const arrangement = useArrangement(store);
  const seats = arrange(items, (entry) => entry.value, arrangement);
  const [error, setError] = useState<string | undefined>(undefined);

  // Everything on screen, in screen order: the first change pins all of it.
  const shown: Arrangement = {
    start: seats.start.map((entry) => entry.value.id),
    end: seats.end.map((entry) => entry.value.id),
    hidden: arrangement.hidden,
  };
  const save = (write: () => Promise<void>): void => {
    setError(undefined);
    write().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const change = (next: Arrangement): void => save(() => store.save(next));

  return (
    <div className="header:flex header:flex-col header:gap-4">
      <p className="header:m-0 header:text-text-muted">
        The order of the items in the top bar, on this account, and which ones it shows.
        Items a plugin adds later go after these until you move them.
      </p>
      {SEATS.map((seat) => (
        <section key={seat} aria-labelledby={`header-seat-${seat}`}>
          <h3 id={`header-seat-${seat}`} className="header:mb-2 header:mt-0 header:text-base">
            {SEAT_TITLES[seat]}
          </h3>
          {seats[seat].length === 0 ? (
            <p className="header:m-0 header:text-text-muted">Nothing here.</p>
          ) : (
            <ol className="header-seat-list header:m-0 header:flex header:list-none header:flex-col header:gap-1 header:p-0">
              {seats[seat].map((entry, index) => {
                const id = entry.value.id;
                const label = entry.value.label;
                const other: Seat = seat === "start" ? "end" : "start";
                const hidden = arrangement.hidden.includes(id);
                return (
                  <li
                    key={id}
                    className="header:flex header:flex-wrap header:items-center header:gap-2 header:rounded header:border header:border-border header:bg-bg-raised header:py-1 header:pl-3 header:pr-1 header:data-[hidden]:bg-bg-subtle"
                    data-hidden={hidden ? "" : undefined}
                  >
                    <span className="header:min-w-0 header:flex-1 header:truncate header:in-data-[hidden]:text-text-muted header:in-data-[hidden]:line-through">
                      {label}
                    </span>
                    <button
                      type="button"
                      className="header:tap-h header:px-2"
                      aria-label={`${hidden ? "Show" : "Hide"} ${label}`}
                      aria-pressed={hidden}
                      onClick={() => change(toggleHidden(shown, id))}
                    >
                      {hidden ? "Show" : "Hide"}
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`Move ${label} up`}
                      disabled={index === 0}
                      onClick={() => change(move(shown, id, { delta: -1 }))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`Move ${label} down`}
                      disabled={index === seats[seat].length - 1}
                      onClick={() => change(move(shown, id, { delta: 1 }))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="header:tap-h header:px-2"
                      aria-label={`Move ${label} to the ${other} seat`}
                      onClick={() => change(move(shown, id, { to: other }))}
                    >
                      {other === "start" ? "To start" : "To end"}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ))}
      <div className="header:flex header:flex-wrap header:items-center header:gap-2">
        <button type="button" className="header:tap-h" onClick={() => save(() => store.reset())}>
          Reset to default order
        </button>
        {error ? (
          <p className="header:m-0 header:text-danger" role="alert">
            Could not save: {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
