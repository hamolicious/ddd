/**
 * The ☰ button, contributed to the header's `start` seat like any other `navbar.item`,
 * so the user can move or hide it in Settings → Top bar. It renders nothing while no
 * plugin contributes a sidebar panel: there is nothing to toggle.
 *
 * Focus returns here when the phone drawer closes because the shell remembers whatever
 * had focus when the drawer opened, not because it holds a ref to this button.
 */

import type { ReactNode } from "react";

import { useShell } from "./hooks.js";
import { SIDEBAR_ID } from "./Shell.js";
import type { ShellState } from "./state.js";

export function SidebarToggle({ state }: { readonly state: ShellState }): ReactNode {
  const shell = useShell(state);
  if (!shell.hasSidebar) return null;
  return (
    <button
      type="button"
      className="shell-sidebar-toggle shellui:tap shellui:box-border shellui:inline-flex shellui:cursor-pointer shellui:items-center shellui:justify-center shellui:rounded shellui:border shellui:border-transparent shellui:bg-transparent shellui:p-0 shellui:hover:border-border shellui:hover:bg-bg-raised"
      aria-expanded={shell.sidebarOpen}
      aria-controls={SIDEBAR_ID}
      onClick={() => state.toggleSidebar()}
    >
      <span aria-hidden="true">☰</span>
      <span className="shellui:sr-only">
        {shell.sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
      </span>
    </button>
  );
}
