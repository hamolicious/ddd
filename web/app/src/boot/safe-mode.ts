/**
 * Safe mode (SPEC §6.1) — the recovery path for the trust model the SPEC states
 * plainly: installing a plugin runs its code unsandboxed in every user's session.
 * When that goes wrong, the way out cannot itself be a plugin.
 *
 * - `?safe=1` boots the **base distribution only**. Everything third-party is
 *   skipped, so a workspace broken by an installed plugin still has a shell, a
 *   router, a document list and an admin screen.
 * - `?safe=bare` boots **no plugins at all** and renders the kernel's own minimal
 *   plugin manager. That is the floor: it needs the kernel, React and the session,
 *   and nothing else. Use it when even a base plugin is the problem.
 * - `DISABLE_PLUGINS=1` server-side does the same thing for every client at once,
 *   by serving an empty plugin list.
 *
 * The flag lives in the query string on purpose: it has to be reachable by typing
 * in a URL bar on a phone, with no working UI and no devtools.
 */

import type { BootMode } from "@kernel";

export type SafeMode = "off" | "base" | "bare";

export function safeModeFrom(search: string): SafeMode {
  const value = new URLSearchParams(search).get("safe");
  if (value === null) return "off";
  if (value === "bare") return "bare";
  // Any other truthy spelling (`1`, `true`, `yes`, empty) means base-only: a user
  // typing `?safe=` under duress should not land in "off".
  return value === "0" || value === "false" ? "off" : "base";
}

export const bootModeFor = (mode: SafeMode): BootMode =>
  mode === "off" ? "normal" : mode === "base" ? "safe" : "bare";

/** The URL that re-enters the app in a given mode, preserving nothing else. */
export function safeModeUrl(mode: SafeMode): string {
  const url = new URL(globalThis.location?.href ?? "http://localhost/");
  url.hash = "";
  if (mode === "off") url.searchParams.delete("safe");
  else url.searchParams.set("safe", mode === "bare" ? "bare" : "1");
  return url.href;
}
