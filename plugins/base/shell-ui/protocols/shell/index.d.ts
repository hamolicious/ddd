/**
 * lm/shell@1.0.0: service, owned by `shell-ui`.
 *
 * The app's layout: the breakpoint, the sidebar and altbar, and which main view is
 * showing. A header or toolbar drives the shell through it; the router tells it what to
 * show.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { Unsubscribe } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/shell";
export type ProtocolVersion = "1.0.0";

/** What a header or toolbar needs to know to drive the shell's sidebar. */
export interface ShellLayout {
  /** Below the mobile breakpoint: drawer sidebar, single pane. */
  readonly compact: boolean;
  /** Desktop: the sidebar column is shown. Compact: the drawer is open. */
  readonly sidebarOpen: boolean;
  /** At least one sidebar panel is wired in; with none there is nothing to toggle. */
  readonly hasSidebar: boolean;
  /** Desktop: the altbar column is shown. Compact: its drawer is open. */
  readonly altbarOpen: boolean;
  /** Some altbar panel accepts the current view; with none there is no altbar. */
  readonly hasAltbar: boolean;
}

export interface Shell {
  /** `true` below the mobile breakpoint: adapt rather than re-measure. */
  readonly isCompact: () => boolean;
  readonly onLayoutChange: (listener: (compact: boolean) => void) => Unsubscribe;
  /** The current layout; the same object until something in it changes, for `useSyncExternalStore`. */
  readonly layout: () => ShellLayout;
  readonly subscribeLayout: (listener: () => void) => Unsubscribe;
  /** The sidebar element's id, for a toggle's `aria-controls`. */
  readonly sidebarId: string;
  /** Open or close the drawer (phone), or collapse the column (desktop). */
  readonly toggleSidebar: (open?: boolean) => void;
  /** The altbar element's id, for a toggle's `aria-controls`. */
  readonly altbarId: string;
  /** Open or close the altbar: a column on a wide screen, a drawer on a phone. */
  readonly toggleAltbar: (open?: boolean) => void;
  /** Which main view is showing; the router sets it. */
  readonly setMainView: (id: string, params?: Readonly<Record<string, string>>) => void;
}
