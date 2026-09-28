# lm/shell

`1.0.0` · service · owned by `shell-ui`

The app's layout: the breakpoint, the sidebar and altbar, and which main view is showing.
A header or toolbar drives the shell through it; the router tells it what to show.

| Key | Type | Required | |
|---|---|---|---|
| `isCompact` | `() => boolean` | yes | `true` below the mobile breakpoint: adapt rather than re-measure. |
| `onLayoutChange` | `(listener: (compact: boolean) => void) => Unsubscribe` | yes |  |
| `layout` | `() => ShellLayout` | yes | The current layout; the same object until something in it changes, for `useSyncExternalStore`. |
| `subscribeLayout` | `(listener: () => void) => Unsubscribe` | yes |  |
| `sidebarId` | `string` | yes | The sidebar element's id, for a toggle's `aria-controls`. |
| `toggleSidebar` | `(open?: boolean) => void` | yes | Open or close the drawer (phone), or collapse the column (desktop). |
| `altbarId` | `string` | yes | The altbar element's id, for a toggle's `aria-controls`. |
| `toggleAltbar` | `(open?: boolean) => void` | yes | Open or close the altbar: a column on a wide screen, a drawer on a phone. |
| `setMainView` | `(id: string, params?: Readonly<Record<string, string>>) => void` | yes | Which main view is showing; the router sets it. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
