/**
 * The altbar's button: a window with its right-hand column marked, contributed to the
 * header's `end` seat like the ☰ is to `start`, so Settings → Top bar can move or hide
 * it. It renders nothing while no `altbar.panel` accepts the current view: there is no
 * altbar to toggle.
 */

import type { ReactNode } from "react";

import { useShell } from "./hooks.js";
import { ALTBAR_ID } from "./Shell.js";
import type { ShellState } from "./state.js";

export function AltbarToggle({ state }: { readonly state: ShellState }): ReactNode {
  const shell = useShell(state);
  if (!shell.hasAltbar) return null;
  return (
    <button
      type="button"
      className="shell-altbar-toggle shellui:tap shellui:box-border shellui:inline-flex shellui:cursor-pointer shellui:items-center shellui:justify-center shellui:rounded shellui:border shellui:border-transparent shellui:bg-transparent shellui:p-0 shellui:hover:border-border shellui:hover:bg-bg-raised shellui:aria-expanded:text-accent"
      aria-expanded={shell.altbarOpen}
      aria-controls={ALTBAR_ID}
      title={shell.altbarOpen ? "Hide the side panel" : "Show the side panel"}
      onClick={() => state.toggleAltbar()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </svg>
      <span className="shellui:sr-only">
        {shell.altbarOpen ? "Hide the side panel" : "Show the side panel"}
      </span>
    </button>
  );
}
