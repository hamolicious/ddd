/**
 * `full-width: true` in a note's frontmatter: the reading column fills the pane, with
 * 15px gutters instead of the 72ch measure. The properties header, the body and the
 * footer share one column, so all three take their width from here.
 */

import type { CoreValue } from "@kernel";

export const FULL_WIDTH_KEY = "full-width";

/** Only a real boolean `true`: `"true"` or `yes` as a string is not the flag. */
export function isFullWidth(fm: Readonly<Record<string, CoreValue>> | undefined): boolean {
  return fm?.[FULL_WIDTH_KEY] === true;
}

/** The column's measure and side gutters. */
export function columnClasses(fullWidth: boolean): string {
  return fullWidth ? "viewer:max-w-none viewer:px-[15px]" : "viewer:max-w-[72ch] viewer:px-4";
}
