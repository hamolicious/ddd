import type { ReactNode } from "react";

import { altbarId, sidebarId, toggleAltbar, toggleSidebar } from "plugin:shell-ui";

import { useShellLayout as useLayout } from "./hooks.js";

const BUTTON =
  "toolbar:tap toolbar:box-border toolbar:inline-flex toolbar:cursor-pointer toolbar:items-center toolbar:justify-center toolbar:rounded toolbar:border toolbar:border-transparent toolbar:bg-transparent toolbar:p-0 toolbar:hover:border-border toolbar:hover:bg-bg-raised";

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
      <span className="toolbar:sr-only">{shell.sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}</span>
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
      className={`shell-altbar-toggle ${BUTTON} toolbar:aria-expanded:text-accent`}
      aria-expanded={shell.altbarOpen}
      aria-controls={altbarId}
      title={label}
      onClick={() => toggleAltbar()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </svg>
      <span className="toolbar:sr-only">{label}</span>
    </button>
  );
}
