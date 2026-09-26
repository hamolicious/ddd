/**
 * The top bar: two seats that other plugins fill, and nothing of its own.
 *
 * Everything in the bar is a `navbar.item` contribution placed in a seat by its `side`:
 * **`start`** (left; grows, scrolls sideways when full) or **`end`** (pushed right; never
 * shrinks). `order` sorts within a seat, and the user's arrangement in Settings → Top bar
 * overrides both (`layout.ts`). The ☰ (`shell-ui`), Settings, Admin, the notice bell
 * (`notices`) and the sync pill (`sync-status`) all arrive this way; the header knows
 * none of them.
 *
 * It is one `shell.header` contribution, so it owns the whole row — the `<header>`
 * landmark and the `<nav aria-label="Main">` inside it. One row at every width, with the
 * padding spent down to the safe-area insets on a phone: every pixel of chrome is a
 * pixel off the document.
 */

import type { ReactNode } from "react";

import type { Contribution, Kernel } from "@kernel";

import { BoundedIcon, bounded, usePointEntries } from "../../_shared/boundary.js";
import { POINTS, type NavbarItem } from "../../_shared/points.js";

import type { ArrangementStore } from "./arrangement.js";
import { useArrangement } from "./hooks.js";
import { arrange } from "./layout.js";

export function Header({
  kernel,
  store,
}: {
  readonly kernel: Kernel;
  readonly store: ArrangementStore;
}): ReactNode {
  const items = usePointEntries<NavbarItem>(kernel, POINTS.navbarItem);
  const arrangement = useArrangement(store);
  const shown = items.filter((entry) => !arrangement.hidden.includes(entry.value.id));
  const seats = arrange(shown, (entry) => entry.value, arrangement);

  return (
    <header className="header:relative header:flex header:min-h-[var(--lm-tap-target)] header:shrink-0 header:items-center header:gap-2 header:border-b header:border-border header:bg-bg-subtle header:pb-1 header:pl-[calc(var(--lm-space)+var(--lm-safe-left))] header:pr-[calc(var(--lm-space)+var(--lm-safe-right))] header:pt-[calc(var(--lm-space)*0.5+var(--lm-safe-top))] header:compact:gap-1 header:compact:pb-0 header:compact:pl-[calc(var(--lm-space)*0.5+var(--lm-safe-left))] header:compact:pr-[calc(var(--lm-space)*0.5+var(--lm-safe-right))] header:compact:pt-[var(--lm-safe-top)]">
      <nav className="header:flex header:min-w-0 header:flex-1 header:items-center header:gap-2 header:compact:gap-1" aria-label="Main">
        <ul className="header:m-0 header:flex header:min-w-0 header:flex-1 header:list-none header:items-center header:gap-1 header:overflow-x-auto header:p-0 header:[scrollbar-width:thin]" data-side="start">
          {seats.start.map((entry) => (
            <NavItem key={entry.value.id} kernel={kernel} entry={entry} />
          ))}
        </ul>
        <ul className="header:ml-auto header:m-0 header:flex header:shrink-0 header:list-none header:items-center header:gap-1 header:p-0 header:compact:gap-0" data-side="end">
          {seats.end.map((entry) => (
            <NavItem key={entry.value.id} kernel={kernel} entry={entry} />
          ))}
        </ul>
      </nav>
    </header>
  );
}

function NavItem({
  kernel,
  entry,
}: {
  readonly kernel: Kernel;
  readonly entry: Contribution<NavbarItem>;
}): ReactNode {
  const item = entry.value;
  if (item.component) {
    const Rendered = bounded(kernel, item.component, POINTS.navbarItem, entry.pluginId);
    return (
      // A plugin's own widget sizes itself; `data-kind` tells it from a button the header
      // renders, which wants its whole label or nothing.
      <li className="header:flex header:min-w-0 header:items-center header:shrink-0" data-kind="component" data-plugin={entry.pluginId}>
        <Rendered />
      </li>
    );
  }
  const hasIcon = item.icon !== undefined && item.icon !== null && item.icon !== false;
  return (
    <li className="header:flex header:min-w-0 header:items-center header:compact:shrink-0" data-kind="button" data-plugin={entry.pluginId}>
      {item.onSelect ? (
        // Icons carry the bar on a phone; the label stays for screen readers.
        <button type="button" className={`header:tap header:box-border header:inline-flex header:cursor-pointer header:items-center header:justify-center header:gap-1 header:rounded header:border header:border-transparent header:bg-transparent header:px-2.5 header:hover:border-border header:hover:bg-bg-raised header:compact:px-1.5 header:compact:[&_.header-nav-icon+_.header-nav-label]:sr-only ${hasIcon ? "header:compact:w-[var(--lm-tap-target)] header:compact:p-0!" : ""}`} onClick={() => item.onSelect?.()}>
          {hasIcon ? (
            <BoundedIcon
              kernel={kernel}
              node={item.icon}
              point={POINTS.navbarItem}
              pluginId={entry.pluginId}
              className="header-nav-icon"
            />
          ) : null}
          <span className="header-nav-label header:truncate">{item.label}</span>
        </button>
      ) : (
        <span className="header:px-1 header:text-text-muted">{item.label}</span>
      )}
    </li>
  );
}
