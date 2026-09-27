/**
 * The service `shell-ui` provides (`kernel.services.require<ShellUiApi>("shell-ui")`).
 *
 * It lives here rather than in `shell-ui/src` because plugins never import each other's
 * sources: the type is the shared declaration, the object is the runtime contract.
 */

import type { Unsubscribe } from "@kernel";

/** What a header or toolbar needs to know to drive the shell's sidebar. */
export interface ShellLayout {
  /** Below the mobile breakpoint (`_shared/compact.ts`): drawer sidebar, single pane. */
  readonly compact: boolean;
  /** Desktop: the sidebar column is shown. Compact: the drawer is open. */
  readonly sidebarOpen: boolean;
  /** At least one `sidebar.panel` is contributed; with none there is nothing to toggle. */
  readonly hasSidebar: boolean;
  /** Desktop: the altbar column is shown. Compact: its drawer is open. */
  readonly altbarOpen: boolean;
  /** Some `altbar.panel` accepts the current view; with none there is no altbar. */
  readonly hasAltbar: boolean;
}

export interface ShellUiApi {
  /** `true` below the mobile breakpoint — dependents adapt rather than re-measure. */
  isCompact(): boolean;
  onLayoutChange(listener: (compact: boolean) => void): Unsubscribe;
  /**
   * The current layout. The same object until something in it changes, so it can be
   * handed straight to `useSyncExternalStore` with `subscribeLayout`.
   */
  layout(): ShellLayout;
  subscribeLayout(listener: () => void): Unsubscribe;
  /** The sidebar element's id, for a toggle's `aria-controls`. */
  readonly sidebarId: string;
  /** Open or close the drawer sidebar (mobile) / collapse it (desktop). */
  toggleSidebar(open?: boolean): void;
  /** The altbar element's id, for a toggle's `aria-controls`. */
  readonly altbarId: string;
  /** Open or close the altbar: a column on a wide screen, a drawer on a phone. */
  toggleAltbar(open?: boolean): void;
  /** Which `main.view` is showing; the router sets it. */
  setMainView(id: string, params?: Readonly<Record<string, string>>): void;
}
