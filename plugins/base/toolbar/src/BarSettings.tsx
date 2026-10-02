import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { Registry } from "@kernel";

import { useRegistry } from "../../_shared/boundary.js";

import type { ToolbarItem } from "./api.js";
import type { ArrangementStore } from "./arrangement.js";
import { useArrangement, useProfile } from "./hooks.js";
import { PROFILES, SEATS, arrange, move, toggleHidden, type Arrangement, type Profile, type SeatId } from "./layout.js";

const PROFILE_TITLES: Record<Profile, string> = { desktop: "Desktop", mobile: "Phone" };

const PROFILE_INTROS: Record<Profile, string> = {
  desktop: "A header along the top and a slim status bar along the bottom.",
  mobile: "A thin bar along the top and a row of big icon buttons along the bottom.",
};

const BUTTON = "toolbar:tap toolbar:inline-flex toolbar:items-center toolbar:justify-center toolbar:p-0";

export function BarSettings({
  items,
  store,
}: {
  readonly items: Registry<ToolbarItem>;
  readonly store: ArrangementStore;
}): ReactNode {
  const detected = useProfile();
  const [picked, setPicked] = useState<Profile | undefined>(undefined);
  const profile = picked ?? detected;
  const tabs = useRef<Partial<Record<Profile, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const index = PROFILES.indexOf(profile);
    const next = PROFILES[(index + (event.key === "ArrowRight" ? 1 : PROFILES.length - 1)) % PROFILES.length] as Profile;
    setPicked(next);
    tabs.current[next]?.focus();
    event.preventDefault();
  };

  return (
    <div className="toolbar:flex toolbar:flex-col toolbar:gap-4">
      <p className="toolbar:m-0 toolbar:text-text-muted">
        Where each item sits on this account, and which ones show. Items a plugin adds later
        go after these until you move them.
      </p>
      <div
        role="tablist"
        aria-label="Device"
        className="toolbar:flex toolbar:gap-1 toolbar:border-b toolbar:border-border"
        onKeyDown={onKeyDown}
      >
        {PROFILES.map((candidate) => {
          const selected = candidate === profile;
          return (
            <button
              key={candidate}
              ref={(element) => {
                tabs.current[candidate] = element;
              }}
              type="button"
              role="tab"
              id={`toolbar-tab-${candidate}`}
              aria-selected={selected}
              aria-controls={`toolbar-panel-${candidate}`}
              tabIndex={selected ? 0 : -1}
              className="toolbar:tap-h toolbar:-mb-px toolbar:cursor-pointer toolbar:rounded-t toolbar:border toolbar:border-transparent toolbar:bg-transparent toolbar:px-3 toolbar:text-text-muted toolbar:aria-selected:border-border toolbar:aria-selected:border-b-bg toolbar:aria-selected:bg-bg toolbar:aria-selected:text-text"
              onClick={() => setPicked(candidate)}
            >
              {PROFILE_TITLES[candidate]}
              {candidate === detected ? <span className="toolbar:text-text-muted"> (this device)</span> : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`toolbar-panel-${profile}`} aria-labelledby={`toolbar-tab-${profile}`}>
        <ProfileLayout key={profile} profile={profile} items={items} store={store} />
      </div>
    </div>
  );
}

function ProfileLayout({
  profile,
  items: host,
  store,
}: {
  readonly profile: Profile;
  readonly items: Registry<ToolbarItem>;
  readonly store: ArrangementStore;
}): ReactNode {
  const items = useRegistry(host);
  const arrangement = useArrangement(store, profile);
  const seats = arrange(items, (entry) => entry.value, profile, arrangement);
  const [error, setError] = useState<string | undefined>(undefined);

  const shown: Arrangement = {
    seats: Object.fromEntries(
      SEATS[profile].map((seat) => [seat.id, (seats[seat.id] ?? []).map((entry) => entry.value.id)]),
    ),
    hidden: arrangement.hidden,
  };
  const save = (write: () => Promise<void>): void => {
    setError(undefined);
    write().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const change = (next: Arrangement): void => save(() => store.save(profile, next));

  return (
    <div className="toolbar:flex toolbar:flex-col toolbar:gap-4">
      <p className="toolbar:m-0 toolbar:text-text-muted">{PROFILE_INTROS[profile]}</p>
      {SEATS[profile].map((seat) => {
        const list = seats[seat.id] ?? [];
        const headingId = `toolbar-seat-${profile}-${seat.id}`;
        return (
          <section key={seat.id} aria-labelledby={headingId}>
            <h3 id={headingId} className="toolbar:mb-2 toolbar:mt-0 toolbar:text-base">
              {seat.title}
            </h3>
            {list.length === 0 ? (
              <p className="toolbar:m-0 toolbar:text-text-muted">Nothing here.</p>
            ) : (
              <ol className="toolbar-seat-list toolbar:m-0 toolbar:flex toolbar:list-none toolbar:flex-col toolbar:gap-1 toolbar:p-0">
                {list.map((entry, index) => {
                  const id = entry.value.id;
                  const label = entry.value.label;
                  const hidden = arrangement.hidden.includes(id);
                  return (
                    <li
                      key={id}
                      className="toolbar:flex toolbar:flex-wrap toolbar:items-center toolbar:gap-2 toolbar:rounded toolbar:border toolbar:border-border toolbar:bg-bg-raised toolbar:py-1 toolbar:pl-3 toolbar:pr-1 toolbar:data-[hidden]:bg-bg-subtle"
                      data-hidden={hidden ? "" : undefined}
                    >
                      <span className="toolbar:min-w-0 toolbar:flex-1 toolbar:truncate toolbar:compact:basis-full toolbar:in-data-[hidden]:text-text-muted toolbar:in-data-[hidden]:line-through">
                        {label}
                      </span>
                      <button
                        type="button"
                        className="toolbar:tap-h toolbar:px-2"
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
                        disabled={index === list.length - 1}
                        onClick={() => change(move(shown, id, { delta: 1 }))}
                      >
                        ↓
                      </button>
                      <select
                        className="toolbar:tap-h toolbar:max-w-[11rem] toolbar:px-1 toolbar:compact:max-w-none toolbar:compact:flex-1"
                        aria-label={`Move ${label} to`}
                        value={seat.id}
                        onChange={(event) => change(move(shown, id, { to: event.target.value as SeatId }))}
                      >
                        {SEATS[profile].map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.title}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        );
      })}
      <div className="toolbar:flex toolbar:flex-wrap toolbar:items-center toolbar:gap-2">
        <button type="button" className="toolbar:tap-h" onClick={() => save(() => store.reset(profile))}>
          Reset {PROFILE_TITLES[profile].toLowerCase()} layout
        </button>
        {error ? (
          <p className="toolbar:m-0 toolbar:text-danger" role="alert">
            Could not save: {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
