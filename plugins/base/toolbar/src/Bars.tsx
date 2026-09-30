/**
 * The two bars: seats that other plugins fill, and nothing of their own.
 *
 * Everything in a bar is an `addItem` item placed in a seat by the current profile's
 * layout (`layout.ts`): the item's own placement, overridden by the user's layout in
 * Settings → Toolbar. Admin, the notice bell (`notices`) and the sync pill
 * (`sync-status`) all arrive this way; the toolbar knows none of them.
 *
 * Which profile draws is the shell's mobile breakpoint:
 *
 * - **Desktop**: {@link TopBar} is the header (`<header>`, `<nav aria-label="Main">`),
 *   {@link BottomBar} a slim IDE-style status footer.
 * - **Phone**: {@link TopBar} is a thin strip, padded down to the safe-area inset, and
 *   {@link BottomBar} one row of big icon buttons within thumb reach, labels kept for
 *   screen readers.
 *
 * A bar with nothing in it draws nothing, except that the top one still holds the top
 * safe-area inset so the app never slides under a phone's status bar.
 */

import type { ReactNode } from "react";

import type { Kernel, Registry, RegistryEntry } from "@kernel";

import { BoundedIcon, bounded, useRegistry } from "../../_shared/boundary.js";

import type { ToolbarItem } from "./api.js";
import type { ArrangementStore } from "./arrangement.js";
import { useArrangement, useProfile } from "./hooks.js";
import { arrange, type SeatId, type Seated } from "./layout.js";

/** What the error boundary names a failed item by. */
const POINT = "toolbar.item";

/** How an item draws, by which bar it sits in. */
type Look = "header" | "footer" | "strip" | "dock";

interface BarProps {
  readonly kernel: Kernel;
  readonly items: Registry<ToolbarItem>;
  readonly store: ArrangementStore;
}

function useSeats({ items: host, store }: BarProps): { seats: Seated<RegistryEntry<ToolbarItem>>; mobile: boolean } {
  const profile = useProfile();
  const items = useRegistry(host);
  const arrangement = useArrangement(store, profile);
  const shown = items.filter((entry) => !arrangement.hidden.includes(entry.value.id));
  return { seats: arrange(shown, (entry) => entry.value, profile, arrangement), mobile: profile === "mobile" };
}

export function TopBar(props: BarProps): ReactNode {
  const { seats, mobile } = useSeats(props);
  const start = seats["top-start"] ?? [];
  const end = seats["top-end"] ?? [];
  if (start.length === 0 && end.length === 0) {
    return <div aria-hidden="true" className="toolbar:shrink-0 toolbar:pt-[var(--lm-safe-top)]" />;
  }
  const look: Look = mobile ? "strip" : "header";
  return (
    <header className="toolbar:relative toolbar:flex toolbar:min-h-[var(--lm-tap-target)] toolbar:shrink-0 toolbar:items-center toolbar:gap-2 toolbar:border-b toolbar:border-border toolbar:bg-bg-subtle toolbar:pb-1 toolbar:pl-[calc(var(--lm-space)+var(--lm-safe-left))] toolbar:pr-[calc(var(--lm-space)+var(--lm-safe-right))] toolbar:pt-[calc(var(--lm-space)*0.5+var(--lm-safe-top))] toolbar:compact:gap-1 toolbar:compact:pb-0 toolbar:compact:pl-[calc(var(--lm-space)*0.5+var(--lm-safe-left))] toolbar:compact:pr-[calc(var(--lm-space)*0.5+var(--lm-safe-right))] toolbar:compact:pt-[var(--lm-safe-top)]">
      <nav className="toolbar:flex toolbar:min-w-0 toolbar:flex-1 toolbar:items-center toolbar:gap-2 toolbar:compact:gap-1" aria-label="Main">
        <Seat kernel={props.kernel} entries={start} seat="top-start" look={look} />
        <Seat kernel={props.kernel} entries={end} seat="top-end" look={look} />
      </nav>
    </header>
  );
}

export function BottomBar(props: BarProps): ReactNode {
  const { seats, mobile } = useSeats(props);
  if (mobile) {
    const row = seats.bottom ?? [];
    if (row.length === 0) return null;
    return (
      <footer className="toolbar:shrink-0 toolbar:border-t toolbar:border-border toolbar:bg-bg-subtle toolbar:pb-[var(--lm-safe-bottom)] toolbar:pl-[var(--lm-safe-left)] toolbar:pr-[var(--lm-safe-right)]">
        <nav aria-label="Toolbar">
          <Seat kernel={props.kernel} entries={row} seat="bottom" look="dock" />
        </nav>
      </footer>
    );
  }
  const start = seats["bottom-start"] ?? [];
  const end = seats["bottom-end"] ?? [];
  if (start.length === 0 && end.length === 0) return null;
  return (
    <footer className="toolbar:flex toolbar:min-h-7 toolbar:shrink-0 toolbar:items-center toolbar:gap-2 toolbar:border-t toolbar:border-border toolbar:bg-bg-subtle toolbar:pl-[calc(var(--lm-space)*0.5+var(--lm-safe-left))] toolbar:pr-[calc(var(--lm-space)*0.5+var(--lm-safe-right))] toolbar:pb-[var(--lm-safe-bottom)] toolbar:text-xs toolbar:text-text-muted">
      <nav className="toolbar:flex toolbar:min-w-0 toolbar:flex-1 toolbar:items-center toolbar:gap-2" aria-label="Status bar">
        <Seat kernel={props.kernel} entries={start} seat="bottom-start" look="footer" />
        <Seat kernel={props.kernel} entries={end} seat="bottom-end" look="footer" />
      </nav>
    </footer>
  );
}

const SEAT_CLASS: Record<Look, { start: string; end: string }> = {
  header: {
    start: "toolbar:m-0 toolbar:flex toolbar:min-w-0 toolbar:flex-1 toolbar:list-none toolbar:items-center toolbar:gap-1 toolbar:overflow-x-auto toolbar:p-0 toolbar:[scrollbar-width:thin]",
    end: "toolbar:ml-auto toolbar:m-0 toolbar:flex toolbar:shrink-0 toolbar:list-none toolbar:items-center toolbar:gap-1 toolbar:p-0",
  },
  strip: {
    start: "toolbar:m-0 toolbar:flex toolbar:min-w-0 toolbar:flex-1 toolbar:list-none toolbar:items-center toolbar:gap-1 toolbar:overflow-x-auto toolbar:p-0 toolbar:[scrollbar-width:thin]",
    end: "toolbar:ml-auto toolbar:m-0 toolbar:flex toolbar:shrink-0 toolbar:list-none toolbar:items-center toolbar:gap-0 toolbar:p-0",
  },
  footer: {
    start: "toolbar:m-0 toolbar:flex toolbar:min-w-0 toolbar:flex-1 toolbar:list-none toolbar:items-center toolbar:gap-0.5 toolbar:overflow-x-auto toolbar:p-0 toolbar:[scrollbar-width:none]",
    end: "toolbar:ml-auto toolbar:m-0 toolbar:flex toolbar:shrink-0 toolbar:list-none toolbar:items-center toolbar:gap-0.5 toolbar:p-0",
  },
  // One row, every item an equal share of the width, big enough for a thumb.
  dock: {
    start: "toolbar:m-0 toolbar:flex toolbar:min-h-14 toolbar:list-none toolbar:items-stretch toolbar:overflow-x-auto toolbar:p-0 toolbar:text-2xl toolbar:[scrollbar-width:none]",
    end: "",
  },
};

function Seat({
  kernel,
  entries,
  seat,
  look,
}: {
  readonly kernel: Kernel;
  readonly entries: readonly RegistryEntry<ToolbarItem>[];
  readonly seat: SeatId;
  readonly look: Look;
}): ReactNode {
  const end = seat.endsWith("-end");
  return (
    <ul className={end ? SEAT_CLASS[look].end : SEAT_CLASS[look].start} data-seat={seat} data-side={end ? "end" : "start"}>
      {entries.map((entry) => (
        <Item key={entry.value.id} kernel={kernel} entry={entry} look={look} />
      ))}
    </ul>
  );
}

const ITEM_CLASS: Record<Look, { component: string; button: string; iconButton: string; cell: string }> = {
  header: {
    cell: "toolbar:flex toolbar:min-w-0 toolbar:items-center",
    component: "toolbar:flex toolbar:min-w-0 toolbar:items-center toolbar:shrink-0",
    button: "toolbar:tap toolbar:gap-1 toolbar:px-2.5",
    iconButton: "",
  },
  // Icons carry the strip; the label stays for screen readers.
  strip: {
    cell: "toolbar:flex toolbar:min-w-0 toolbar:items-center toolbar:shrink-0",
    component: "toolbar:flex toolbar:min-w-0 toolbar:items-center toolbar:shrink-0",
    button: "toolbar:tap toolbar:gap-1 toolbar:px-1.5 toolbar:[&_.toolbar-icon+_.toolbar-label]:sr-only",
    iconButton: "toolbar:w-[var(--lm-tap-target)] toolbar:p-0!",
  },
  // Slim: a plugin's own widget is held to the footer's height too (the sync pill is a
  // full-size tap target elsewhere), except on a touch screen. Important, because the
  // widget's own stylesheet loads after this one and would win a tie.
  footer: {
    cell: "toolbar:flex toolbar:min-w-0 toolbar:items-center toolbar:shrink-0",
    component: "toolbar:flex toolbar:min-w-0 toolbar:items-center toolbar:shrink-0 toolbar:not-touch:[&>*]:min-h-6! toolbar:not-touch:[&_button]:min-h-6! toolbar:not-touch:[&_button]:min-w-6! toolbar:not-touch:[&_button]:w-auto! toolbar:not-touch:[&_button]:px-1!",
    button: "toolbar:h-6 toolbar:not-touch:min-h-0! toolbar:touch:h-auto toolbar:touch:tap-h toolbar:gap-1 toolbar:px-1.5 toolbar:text-xs toolbar:hover:text-text",
    iconButton: "",
  },
  dock: {
    cell: "toolbar:flex toolbar:min-w-[var(--lm-tap-target)] toolbar:flex-1 toolbar:items-center toolbar:justify-center",
    component: "toolbar:flex toolbar:min-w-[var(--lm-tap-target)] toolbar:flex-1 toolbar:items-center toolbar:justify-center",
    button: "toolbar:size-full toolbar:min-h-14 toolbar:flex-col toolbar:gap-0.5 toolbar:px-1 toolbar:[&_.toolbar-icon+_.toolbar-label]:sr-only toolbar:[&_.toolbar-label]:text-xs toolbar:[&_.toolbar-icon]:inline-flex toolbar:[&_.toolbar-icon_svg]:size-[1em]",
    iconButton: "",
  },
};

const BUTTON =
  "toolbar:box-border toolbar:inline-flex toolbar:cursor-pointer toolbar:items-center toolbar:justify-center toolbar:rounded toolbar:border toolbar:border-transparent toolbar:bg-transparent toolbar:text-inherit toolbar:hover:border-border toolbar:hover:bg-bg-raised";

function Item({
  kernel,
  entry,
  look,
}: {
  readonly kernel: Kernel;
  readonly entry: RegistryEntry<ToolbarItem>;
  readonly look: Look;
}): ReactNode {
  const item = entry.value;
  const style = ITEM_CLASS[look];
  if (item.component) {
    const Rendered = bounded(kernel, item.component, POINT, entry.pluginId);
    return (
      // A plugin's own widget sizes itself; `data-kind` tells it from a button the
      // toolbar renders, which wants its whole label or nothing.
      <li className={style.component} data-kind="component" data-plugin={entry.pluginId} data-look={look}>
        <Rendered />
      </li>
    );
  }
  const hasIcon = item.icon !== undefined && item.icon !== null && item.icon !== false;
  return (
    <li className={style.cell} data-kind="button" data-plugin={entry.pluginId} data-look={look}>
      {item.onSelect ? (
        <button
          type="button"
          className={`${BUTTON} ${style.button} ${hasIcon ? style.iconButton : ""}`}
          title={look === "dock" || look === "strip" ? item.label : undefined}
          onClick={() => item.onSelect?.()}
        >
          {hasIcon ? (
            <BoundedIcon
              kernel={kernel}
              node={item.icon}
              point={POINT}
              pluginId={entry.pluginId}
              className="toolbar-icon"
            />
          ) : null}
          <span className="toolbar-label toolbar:truncate">{item.label}</span>
        </button>
      ) : (
        <span className="toolbar:px-1 toolbar:text-text-muted">{item.label}</span>
      )}
    </li>
  );
}
