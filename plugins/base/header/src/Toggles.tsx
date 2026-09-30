/**
 * The header's built-in buttons for the shell's two columns: the ☰ in the `start` seat
 * and the altbar's button in the `end` seat, each on the side of the column it opens.
 * Like every other item, the user can move or hide them in Settings → Top bar.
 *
 * Each renders nothing while its column has nothing in it: there is nothing to toggle.
 * Focus returns to the ☰ when the phone drawer closes because the shell remembers
 * whatever had focus when the drawer opened, not because it holds a ref to this button.
 */

import { useSyncExternalStore, type ReactNode } from "react";

import { altbarId, layout, sidebarId, subscribeLayout, toggleAltbar, toggleSidebar } from "plugin:shell-ui";

const BUTTON =
  "header:tap header:box-border header:inline-flex header:cursor-pointer header:items-center header:justify-center header:rounded header:border header:border-transparent header:bg-transparent header:p-0 header:hover:border-border header:hover:bg-bg-raised";

const useLayout = () => useSyncExternalStore(subscribeLayout, layout, layout);

export function SidebarToggle(): ReactNode {
  const shell = useLayout();
  if (!shell.hasSidebar) return null;
  return (
    <button
      type="button"
      className={`shell-sidebar-toggle ${BUTTON}`}
      aria-expanded={shell.sidebarOpen}
      aria-controls={sidebarId}
      onClick={() => toggleSidebar()}
    >
      <span aria-hidden="true">☰</span>
      <span className="header:sr-only">{shell.sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}</span>
    </button>
  );
}

export function AltbarToggle(): ReactNode {
  const shell = useLayout();
  if (!shell.hasAltbar) return null;
  const label = shell.altbarOpen ? "Hide the side panel" : "Show the side panel";
  return (
    <button
      type="button"
      className={`shell-altbar-toggle ${BUTTON} header:aria-expanded:text-accent`}
      aria-expanded={shell.altbarOpen}
      aria-controls={altbarId}
      title={label}
      onClick={() => toggleAltbar()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </svg>
      <span className="header:sr-only">{label}</span>
    </button>
  );
}
