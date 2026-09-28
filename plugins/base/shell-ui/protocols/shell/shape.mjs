import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/shell",
  version: "1.0.0",
  kind: "service",
  name: "Shell",
  description: `
The app's layout: the breakpoint, the sidebar and altbar, and which main view is showing.
A header or toolbar drives the shell through it; the router tells it what to show.`,
  imports: `import type { Unsubscribe } from "@kernel";`,
  declarations: `
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
}`,
  shape: s.object({
    isCompact: s.func().as("() => boolean").describe("`true` below the mobile breakpoint: adapt rather than re-measure."),
    onLayoutChange: s.func().as("(listener: (compact: boolean) => void) => Unsubscribe"),
    layout: s
      .func()
      .as("() => ShellLayout")
      .describe("The current layout; the same object until something in it changes, for `useSyncExternalStore`."),
    subscribeLayout: s.func().as("(listener: () => void) => Unsubscribe"),
    sidebarId: s.string().describe("The sidebar element's id, for a toggle's `aria-controls`."),
    toggleSidebar: s.func().as("(open?: boolean) => void").describe("Open or close the drawer (phone), or collapse the column (desktop)."),
    altbarId: s.string().describe("The altbar element's id, for a toggle's `aria-controls`."),
    toggleAltbar: s.func().as("(open?: boolean) => void").describe("Open or close the altbar: a column on a wide screen, a drawer on a phone."),
    setMainView: s
      .func()
      .as("(id: string, params?: Readonly<Record<string, string>>) => void")
      .describe("Which main view is showing; the router sets it."),
  }),
};
