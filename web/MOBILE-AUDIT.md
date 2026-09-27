# Mobile audit — every surface, three phone viewports

What a walk of the whole app on a phone found, in two inventories: **LAYOUT** (what is
broken on screen) and **PROSE** (what is badly written on screen). Both are grouped by the
three fix-agent ownerships so each list can be worked without reading the others.

## How this was produced

An isolated stack, so nothing touched the owner's live workspace on `:8080`:

```bash
LM_E2E_PORT=8131 LM_E2E_DB=life_manager_mobile_audit node web/app/e2e/server.mjs
# real binary, real bundle (web/app/dist), real registry (15 plugins), fresh database
```

Playwright with Chromium device emulation (`devices["Pixel 7"]` — mobile UA, `hasTouch`,
`isMobile`, DPR 2) at three viewports:

| Profile | Viewport | Notes |
|---|---|---|
| `pixel7` | 390 × 844 | the acceptance viewport |
| `narrow` | 360 × 800 | the common Android floor |
| `landscape` | 844 × 390 | the same phone rotated |

Every surface was screenshotted into
`…/scratchpad/mobile-audit/<surface>__<profile>.png` (168 files) and probed in-page for:

- `document.documentElement.scrollWidth > clientWidth` (body horizontal scroll);
- every element with `scrollWidth > clientWidth` (split into *clipped* — `overflow-x`
  `visible`/`hidden`/`clip` — and *scrollable*, which is the sanctioned pattern);
- every **leaf-most** element whose `getBoundingClientRect().right > innerWidth` or
  `.left < 0` (content physically off-screen);
- every interactive element under 44 px in either dimension.

The soft keyboard was emulated by shrinking the viewport height by 320–340 px while an
input held focus. A `window.shell` stub was injected so the kernel's shell-only
"This device" settings section was in the walk. Surfaces covered: auth gate (first run,
invite mode, filled), doc-list (+ filter bar, added condition, DSL disclosure, filtered
empty state), sidebar drawer, folder tree expanded, folder contents (root + nested),
document surface (read, edit, edit focused, edit + keyboard, tasks, task menu, not found),
properties panel, search (page + navbar dropdown + empty), Trash (empty + populated),
command palette (+ filtered, + keyboard), notice bell (+ details), settings index and all
11 sections, admin and all 7 tabs (incl. plugin cards expanded, invite created, snapshot
picker), unknown route, safe mode, and a document containing deliberately wide content.

**One good result first:** `document.documentElement` never scrolled horizontally on any
surface at any viewport. The body is held. What *does* scroll sideways is the main content
region and the document pane — which is the same defect one level down, and is below.

---

## Defect counts per page

Layout defects are distinct causes, not occurrences (20 unreachable "Change" buttons count
once). "Off-screen" is the measured count of leaf elements past the viewport edge at the
worst of the three profiles.

| Page | Layout | Prose | Off-screen (worst) | Notes |
|---|---:|---:|---:|---|
| Global chrome (navbar, breakpoint, safe area, keyboard) | 6 | 5 | — | affects every page below |
| **Settings shell** | 2 | 2 | 28 @360 | main region scrolls sideways |
| **Admin (7 tabs)** | 4 | 26 | 14 @360 | destructive buttons off-screen |
| **Document surface / viewer / editor** | 3 | 16 | 4 @390 | one URL scrolls the whole pane |
| Properties panel | 5 | 5 | 1 @844 | 5 sub-44 px controls, behind the drawer |
| Doc list (+ filters, empty, Trash) | 4 | 9 | 0 | open-control is 22.5 px tall |
| Folders (tree + contents) | 4 | 6 | 0 | drag-first, 24 px twisty |
| Search (box + results) | 3 | 7 | 4 @390 | snippets clipped mid-word |
| Command palette + keybindings | 2 | 5 | 20 @360 | keybinding table unreachable |
| Notices / banners (incl. kernel notice copy) | 2 | 9 | 1 @360 | panel clipped off the left edge |
| Themes ("Appearance") | 1 | 3 | — | |
| "This device" (shell section) | 1 | 3 | 1 @844 | no stylesheet at all |
| Boot / safe mode / re-auth screens | 2 | 4 | — | |
| Auth gate | 0 | 1 | 0 | cleanest screen in the app |
| **Totals** | **39** | **101** | | |

Layout item ids are `A-n` / `B-n` / `C-n`; prose item ids are `A-Pn` / `B-Pn` / `C-Pn`.
Every id below is unique and every row above is the count of ids assigned to that page.

### The worst three pages

1. **Settings** (`/settings/*`) — the owner's "the settings page is a mess" is measurable.
   The section list is a single horizontal strip **1757–1863 px wide** inside a 344–374 px
   scroller, so 2–3 of 11 sections are visible and there is no affordance that says the
   rest exist. Above it sits a three-sentence grey warning block that costs ~290 px before
   any control. And the pane itself is unclipped, so `main#shell-main` acquires a
   horizontal scroll (measured `scrollWidth` 388 / 493 / 828 against `clientWidth`
   360 / 360 / 574) — the page scrolls sideways instead of the table inside it.

2. **Admin** — 13 off-screen leaves at 390 px, 14 at 360 px, and the ones off-screen are
   `Reset link`, `Delete` and `Revoke`. The tables *do* have `overflow-x: auto` wrappers,
   but a nested horizontal scroller with no visible scrollbar on Android is a feature
   nobody finds. The audit log renders a 64-hex invite token as one unbreakable 485 px
   word that drags the entire column with it. The Plugins tab opens with a twelve-line
   essay and no content above the fold.

3. **Document surface / viewer** — the actual reading surface. A single unbreakable token
   in a document (a long URL, a long inline-code span) sets the pane's intrinsic minimum
   width and **the whole pane scrolls sideways**: measured `.docsurface-pane`
   `scrollWidth` 659 against `clientWidth` 390, with the `<h1>`, the paragraphs and
   everything else stretched to 651 px. This is the single most likely cause of "it
   overflows" on a real phone, because a pasted link is an ordinary thing to have in a
   note.

Honourable mention: **doc-list**, where the control that opens a document — the most-used
control in the product — is **22.5 px tall** on every row.

---

# 1. LAYOUT

## (A) shell-ui / settings / themes / admin + `web/app` screens

### A-1 · No `env(safe-area-inset-*)` anywhere, with `viewport-fit=cover` set — GLOBAL

`web/app/index.html:5` sets `viewport-fit=cover`, which tells Android to lay the page out
edge to edge, under the status bar and under the gesture bar. Nothing in the tree then
compensates: a grep for `safe-area-inset` across `web/app/src`, `web/kernel/src` and all
14 plugins returns **zero hits**.

Consequences on a real device (not reproducible in emulation, which has no insets — this
one is from the CSS, and it is why the owner's phone looks different from any screenshot
here):

- `plugins/base/shell-ui/src/style.css:60-69` — `.shell-navbar` has
  `padding: calc(var(--lm-space) * 0.5) var(--lm-space)` and no top inset; the first row
  of the navbar sits under the status bar.
- `plugins/base/shell-ui/src/style.css:415-426` — `.shell-sidebar` drawer is
  `inset-block: 0` with no bottom inset; its last panel sits under the gesture bar.
- `plugins/base/commands/src/style.css:311-323` — the palette becomes `height: 100%`,
  `border-radius: 0`, `padding: 0`: a full-bleed sheet with no insets at either end.
- `plugins/base/document-surface/src/style.css:124-130` — the document pane is the
  bottom-most scroller; its last line lands under the gesture bar.

Fix shape: a `--lm-safe-*` set of tokens on `:root` in `web/app/src/styles.css` derived
from `env(safe-area-inset-*)`, consumed by the navbar, the drawer, the palette and the
document pane. The tokens belong in the kernel stylesheet so a replacement shell inherits
them.

### A-2 · The layout viewport never shrinks for the keyboard

`web/app/src/styles.css:19-24` pins `html, body, #root { height: 100% }`, and
`:83-87` gives `.lm-frame` `height: 100%`. On Android the *layout* viewport does not shrink
when the soft keyboard opens (only the *visual* viewport does), so the frame keeps its full
height and the keyboard is painted over the bottom of it. Nothing in the tree reads
`window.visualViewport` — grep returns zero hits.

Measured with the keyboard proxy (`S13-account-keyboard-open__pixel7.png`): focusing
"Repeat the new password" on `/settings/settings.account` leaves the field at the very
bottom edge and the `Change password` submit button below the fold, with 200 px of the
remaining 504 px still spent on the two-row navbar. On a device this is worse, not better.

Fix shape: a `visualViewport` listener that writes the visible height into a
`--lm-viewport-height` token, and `.lm-frame`/`.cmd-palette`/`.lm-reauth` sized from it.

### A-3 · `.lm-reauth` centres a dialog the keyboard will cover

`web/app/src/styles.css:212-222` — `position: fixed; inset: 0; display: grid;
place-items: center`. The password field is vertically centred in the *layout* viewport,
so with the keyboard open it is behind it, and `position: fixed` on Android is anchored to
the layout viewport too, so scrolling does not rescue it. Same shape as A-2; same fix.

### A-4 · The navbar costs two full rows of permanent chrome

`plugins/base/shell-ui/src/style.css:445-459` deliberately wraps the navbar onto two rows
at ≤640 px. Measured: **~104 CSS px** of chrome on every screen, carrying a `Commands`
button (a keyboard affordance on a device with no keyboard — the `<kbd>` inside it is
already hidden at `commands/style.css:338-340`, but the button and its 42 px label are
not), a duplicate "New document" (the doc-list already has its own primary button), and a
search box that is duplicated again by the page-level form on `/search`.

The two-row fix solved a horizontal overflow (the comment at `:437-443` says so honestly)
by spending vertical space instead. On the document surface that leaves 640 px of an
844 px screen for the document, and in landscape it leaves ~150 px.

### A-5 · The notice panel is clipped off the **left** edge

`plugins/base/shell-ui/src/style.css:235-248` — `.shell-notice-panel` is
`position: absolute; right: 0; width: min(26rem, calc(100vw - var(--lm-space) * 2))`,
anchored to `.shell-notices`, which is the bell at the far right of the navbar. At 390 px
the width resolves to 374 px and `right: 0` puts the left edge at **x = −9**; at 360 px
the same. Measured on `19-notices-panel__pixel7.png` and `__narrow.png`: the only
off-screen leaf on that surface is the panel itself. The first characters of every notice
are cut.

Fix shape: at the mobile breakpoint, take the panel out of the bell's containing block —
`position: fixed`, `inset-inline: var(--lm-space)`, `width: auto`.

### A-6 · `.shell-notice-panel { max-height: 60vh }` — `styles.css:241`

`vh` is the *large* viewport on Android: with the URL bar shown, 60vh is more than 60% of
what is visible. Same file, same block as A-5. `dvh` with a `vh` fallback, or the
`--lm-viewport-height` token from A-2.

### A-7 · The 640 px breakpoint is width-only, so phone **landscape** gets the desktop layout

A phone rotated is 844 × 390 — wider than 640, so every `@media (max-width: 640px)` block
in the tree is off, and the app lays itself out as a desktop on a screen 390 px tall.
Measured at `20-settings-index__landscape.png` and `10c-doc-edit-keyboard__landscape.png`:

- the sidebar is **in flow** at `min(18rem, 32vw)` = 270 px, a third of the screen
  (`shell-ui/style.css:307-324`);
- the navbar is one row with the `Ctrl+K` hint and full `Settings` / `Admin` labels;
- `New document` is clipped to **38 px of its 107 px label** (measured `scrollWidth` 107,
  `clientWidth` 38) because `.shell-nav-list[data-side="start"]` is an `overflow-x: auto`
  strip (`shell-ui/style.css:95-99`) and the search box's `flex: 1 1 18rem` wins;
- settings keeps its two-column `minmax(10rem, 14rem) 1fr` grid at 302 px of content;
- with the keyboard open the editor has roughly one line of text visible.

Every breakpoint in the base distribution is affected and each needs the same edit:
`shell-ui/style.css:415`, `doc-list:300`, `folders:276`, `search:237`,
`document-surface:142`, `viewer:230`, `editor:118`, `properties:273`, `commands:311`,
`settings:221`, `admin:429`.

Fix shape: `@media (max-width: 640px), (max-height: 480px)`. That is a one-line change per
file and it is the highest-value single edit in this document, because it converts eleven
already-written mobile layouts into landscape layouts for free.

### A-8 · Settings: the section list is a 1860 px horizontal strip

`plugins/base/settings/src/style.css:232-241`:

```css
.settings-nav ul { display: flex; gap: …; overflow-x: auto; padding-bottom: …; }
.settings-nav-link { white-space: nowrap; }
```

Measured `ul` `scrollWidth`: **1757 px @390, 1863 px @360, 1856 px @360** across sections,
against a `clientWidth` of 374 / 344. Eleven sections; two and a half fit. There is no
scrollbar on a touch device, no edge fade, no scroll-snap, and the strip is the *only*
navigation into admin from settings.

The brief's rule for this page is "settings/admin become single-column stacked cards on
narrow widths". `.settings-panes` already collapses to one column at `:227-230`; the nav
should collapse with it — a stacked list of full-width rows (each already
`min-height: var(--lm-tap-target)` at `:57-65`), not a row.

### A-9 · Settings: the pane is unclipped, so `main` scrolls sideways

`plugins/base/settings/src/style.css:33-38` (`.settings-panes`, a grid) and `:76-78`
(`.settings-pane { min-width: 0 }`) leave `overflow-x` at `visible`. When a section renders
something wider than the column — the keybindings table (C-7), an audit target id (A-11),
the shell facts list (A-14) — the width propagates up through `.settings-pane`,
`.settings-panes`, `.settings-root` and lands on `main#shell-main`, which *is* an
`overflow: auto` box (`shell-ui/style.css:377-382`) and therefore scrolls.

Measured `main` `scrollWidth` vs `clientWidth`: **388 / 360** (keybindings @360),
**493 / 360** (audit @360), **828 / 574** (This device @844). The page scrolls sideways
rather than the wide thing inside it — the exact inversion of the design rule.

### A-10 · Admin tables put the destructive actions off-screen

`plugins/base/admin/src/style.css:103-120` gives `.admin-table-scroll { overflow-x: auto }`
and `.admin-table th, td { white-space: nowrap }`; `Users.tsx:74-75` and `:231-232`,
`Storage.tsx:74-75` and `:228-229` use it. It works — the probe classes these as
`SCROLL`, not `CLIP` — but on a 360 px viewport the measured content widths are:

| Table | content | visible | what is off-screen |
|---|---:|---:|---|
| Users (`Users.tsx:75`) | 519 px | 344 px | `Last sign-in`, `Actions`, `Reset link`, `Delete` |
| Invites (`Users.tsx:232`) | 465 px | 344 px | `Used`, `Actions`, `Revoke` |

`Delete` and `Revoke` are the two actions on those screens; both sit 64–167 px past the
right edge, reachable only by a horizontal swipe inside a nested scroller that draws no
scrollbar. This is the "single-column stacked cards" case in the brief.

### A-11 · The ≤640 rule makes the table worse, not better

`plugins/base/admin/src/style.css:434-437`:

```css
@media (max-width: 640px) { .admin-table th, .admin-table td { white-space: normal; } }
```

Releasing `nowrap` inside a scroller does not stack rows — it squeezes columns. Visible in
`21-settings-admin.users__pixel7.png`: the `Last sign-in` header renders as three stacked
fragments, `LAS` / `SIG` / `IN`. Either commit to the horizontal scroller (keep `nowrap`,
add a visible affordance) or stack each row into a card; the current rule does neither.

### A-12 · `CronTable` has no scroll wrapper at all

`plugins/base/admin/src/Plugins.tsx:722` — a six-column `<table className="admin-table">`
with **no** `.admin-table-scroll` parent, unlike every other table in the plugin. It is not
visible in this workspace (no base plugin has a backend half since the calendar removal),
so it is not in the screenshots; it will overflow the moment a plugin with cron is
installed.

### A-13 · A 64-hex token is one unbreakable 485 px word

`plugins/base/admin/src/style.css:64-71` — `.admin-link` sets
`min-height: auto !important; padding: 0 !important; …; text-align: left` and **no**
`overflow-wrap`. The audit log renders invite ids through it
(`Audit.tsx`, `.admin-audit-target > button.admin-link`), and measured at 360 px:

```
PAST L=8 R=493 w=485 | li>p.admin-audit-target>button.admin-link | "d252a17bfa451e699…"
```

485 px in a 344 px column, which then pushes `ol.admin-audit`, `section.admin-section`,
`.settings-pane`, `.settings-panes`, `.settings-root` and `main` — nine cascading `CLIP`
entries from one token. `.admin-problems li` already has `overflow-wrap: anywhere`
(`style.css:414-416`); `.admin-link` needs the same.

### A-14 · `.lm-shell-facts` has no stylesheet rule at all

`web/app/src/boot/ShellSection.tsx:91` renders `<dl className="lm-shell-facts">`, and a
grep for that class across `web/app/src` finds **one hit — the JSX**. There is no rule in
`web/app/src/styles.css`. It therefore renders as a browser-default `<dl>`: indented
`<dd>`s, no grid, no wrapping. Measured in landscape
(`20-settings-index__landscape.png`): a `<dd>` at `scrollWidth` 532 / `clientWidth` 262
(the bundle hash / server URL), which is what pushes `main` to 828 px there.

It also means this section alone in the app does not match `.settings-facts`
(`settings/style.css:108-121`), which is the same two-column `dt`/`dd` shape done properly.

### A-15 · `.lm-bare-table` — five columns, `width: 100%`, no wrapper

`web/app/src/styles.css:241-252` / `web/app/src/safe-mode/BareManager.tsx:55-84`.
Plugin · Version · Kernel · Base · Would load, with a free-text "no — <detail>" in the
last column. Safe mode is the screen someone reaches *because* something is already
broken; it should not be the screen that also does not fit.

### A-16 · `<summary>` gets no minimum height anywhere

The global `button { min-height: var(--lm-tap-target) }` in `web/app/src/styles.css:58-65`
does not reach `<summary>`, and no plugin adds a rule. Measured targets:

| Where | size | file |
|---|---|---|
| "Details" in a notice | 356 × 22.5 | `shell-ui/src/indicators.tsx:182-186` |
| "Detail" in an audit row | 374 × 22.5 | `admin/src/Audit.tsx` (per-entry `<details>`) |
| "Show this filter as the query language sees it" | 356 × 19.1 | `doc-list/src/FilterBar.tsx:291-296` |
| the same, in folder contents | 374 × 19.1 | `folders/src/FolderContents.tsx:172-177` |

Two of those are owner C's files; the rule that fixes all four belongs in the kernel
stylesheet beside the `button` rule.

### A-17 · Theme swatch radios are 17.6 × 17.6 px

`plugins/base/themes/src/style.css:51-55` gives `.theme-option` (the `<label>`)
`min-height: var(--lm-tap-target)`, so tapping the row works and this is **low severity** —
but the control itself is a quarter of the target, and the swatch beside it
(`:83`, `width: 3rem`) is the thing a user aims at.

### A-18 · `.shell-skip` is 121.8 × 34.5 px

`plugins/base/shell-ui/src/style.css:29-39`. Only reachable by keyboard focus, so low
severity; listed for completeness because it is in every probe.

---

## (B) document-surface / viewer / editor / properties / markdown

### B-1 · One unbreakable token scrolls the entire document pane — **the worst layout bug found**

Reproduced by putting a long URL in a document (`S9-viewer-wide-content__pixel7.png`):

```
SCROLL sw=659 cw=390 | div.docsurface-root > section.docsurface-pane
PAST  L=8 R=651 | div.md-root > h1#untitled                  | "Untitled"
PAST  L=8 R=651 | div.md-root > h1#wide-content-probe…       | "Wide content probe…"
PAST  L=8 R=649 | p > a.md-link                              | "https://example.com/a/very/long/…"
PAST  L=8 R=440 | p > code.md-inline-code                    | "bashkubectl get pods --all-namespaces…"
```

Note what is off-screen: not just the URL — the `<h1>`s and the paragraphs too. The whole
column is 659 px wide inside a 390 px pane, so reading requires horizontal swiping on every
line.

Three contributing causes, each independently fixable:

1. **`overflow-wrap: break-word` is the wrong keyword.**
   `plugins/base/markdown/src/style.css:15` (`.md-root`) and
   `plugins/base/viewer/src/style.css:26` (`.viewer-body`) both use `break-word`.
   `break-word` breaks a long word *visually* but does **not** reduce the element's
   min-content width; only `overflow-wrap: anywhere` does. An ancestor whose width is
   driven by min-content therefore still grows. This is precisely the distinction between
   the two keywords and precisely this bug.
2. **`.md-root a` and `.md-inline-code` have no wrap rule.**
   `markdown/src/style.css:32-34` sets only `color`; `:50-56` sets only background,
   radius, font and padding. Both need `overflow-wrap: anywhere` (and links want
   `word-break: break-word` as a belt).
3. **`.docsurface-pane` has no `min-width: 0`.**
   `plugins/base/document-surface/src/style.css:124-130` is
   `display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: auto`.
   The `min-height: 0` is there; its width twin is not. `shell-ui` got this right for
   `.shell-main` (`shell-ui/style.css:377-382` has `min-width: 0`) and `settings` got it
   right for `.settings-pane` (`settings/style.css:76-78`).

Fenced code and tables are already correct — `.md-code { overflow-x: auto }`
(`markdown/style.css:58-66`) and `.md-table-scroll` (`:78-85`) are exactly the sanctioned
pattern, and the comment at `:63` states the rule this file then breaks for prose.

### B-2 · Every frontmatter value field is 34 px tall

`plugins/base/properties/src/style.css:64-68`:

```css
.properties-input {
  /* 44 px touch target at the mobile breakpoint (SPEC §6.5). */
  min-height: calc(var(--lm-tap-target) - 10px);
}
```

The comment claims 44 px; the declaration is 34 px. Measured 253 × 34 on every row of
`S2-properties-in-drawer__pixel7.png`. `.properties-button` (`:209-211`) has the identical
`- 10px` and measures 52.9 × 34. There is a `@media (max-width: 640px)` block at `:273-281`
and a `@container (max-width: 20rem)` block at `:283-…`, and neither restores the height.

### B-3 · `.properties-remove` is 30 px wide — `properties/style.css:130-133`

`width: calc(var(--lm-tap-target) - 14px); height: calc(var(--lm-tap-target) - 14px)`.
Measured 30 × 44 (the flex row stretches it vertically, not horizontally). It is the
destroy-a-property button, one per row, sitting 8 px from a 34 px text field.

### B-4 · `.properties-chip-remove` is 24 px — `properties/style.css:169-179`

`width: 1.2rem; height: 1.2rem`. Measured 24 × 44. This is the "remove this tag" ×.

### B-5 · The properties panel is a sidebar panel, so on a phone it is behind the drawer

`plugins/base/properties/src/index.tsx:165-172` contributes to `POINTS.sidebarPanel` with
`order: 30, defaultOpen: true`. At ≤640 px the sidebar is a drawer over the document
(`shell-ui/style.css:415-426`), so editing the frontmatter of the document you are reading
means: open the drawer (which covers the document), scroll past the **Views** panel, past
the whole **Folders** tree, past the folders' three-sentence help paragraph, and then reach
**Properties**. Measured in `S2-properties-in-drawer__pixel7.png`: the first property row
starts ~1 100 px into the drawer's scroll with only two folders in the tree.

This is also what makes C-11 (folders are drag-to-move on a device with no drag) land
badly: the documented touch fallback is "edit its `path` in the properties panel", and the
properties panel is four scroll-screens down a drawer.

Not a CSS fix. It is a placement decision — see **Open questions**, Q1.

### B-6 · The task-state menu has no viewport clamp

`plugins/base/markdown/src/style.css:248-261` — `.md-menu` is
`position: absolute; top: 100%; inset-inline-start: 0; min-width: 12rem` anchored to
`.md-task-control` (`:215-…`), which is a 44 px inline-block. Measured menu width 192 px.
A task marker in an indented list, or in any layout that puts it past x ≈ 170 at 360 px,
puts the menu past the right edge; there is nothing in the file that flips or clamps it.
Marked **plausible** rather than confirmed: the probe opened the menu on a root-level task
at x ≈ 8, where it fits.

### B-7 · The editor's own rule forbids viewport units, and the file uses them

`plugins/base/editor/src/style.css:15` documents rule 1 as "**No viewport units anywhere.**
`100vh` does not shrink when the keyboard opens on…". `:54` and `:120` then set
`padding: … 40vh` on the content. The intent (scroll headroom so the caret can reach the
middle of the screen) is right and worth keeping, but `40vh` of the *large* viewport is
338 px at 844 and is not what the comment above it claims. Pair it with the
`--lm-viewport-height` token from A-2.

### B-8 · `.properties-input` is clipped in the landscape sidebar

Measured at 844 × 390: `sw=229 cw=201` on `dd.properties-value > input.properties-input`.
Consequence of A-7 (desktop layout in landscape) plus `properties/style.css:64-66`
(`flex: 1 1 6rem; min-width: 0`) inside a 270 px sidebar. Fixing A-7 resolves it.

---

## (C) doc-list / folders / search / commands + kernel notices

### C-1 · The primary "open a document" control is 22.5 px tall

`plugins/base/doc-list/src/style.css:186-196`:

```css
.doclist-open {
  min-height: auto !important;   /* cancels the kernel's 44 px button floor */
  padding: 0 !important;
  border: 0 !important;
  background: none !important;
  color: var(--lm-link);
}
```

Measured 100.2 × 22.5, 179.9 × 22.5, 219.2 × 22.5, 225.7 × 22.5 on the four welcome
documents. The `!important` overrides `web/app/src/styles.css:58-65`, which exists to give
every button the tap target. Making the whole `.doclist-item` row the target (it is a grid
at `:174-184`) is the obvious answer and also fixes the fat-finger problem of a
"Move to Trash" button sitting 8 px away.

### C-2 · Same, in folders — `plugins/base/folders/src/style.css:246-254`

`.folders-doc` repeats the identical four `!important` overrides and adds
`cursor: grab`. Measured 100.2 × 22.5 and 179.9 × 22.5 in
`12b-folders-contents-nested__pixel7.png`. (`cursor: grab` on a touch-only device is
cosmetic, but it is the tell for C-11.)

### C-3 · The folder twisty is 24 × 24 px

`plugins/base/folders/src/style.css:60-70` — `width: 1.5rem; min-height: 1.5rem`. The
mobile block at `:276-285` correctly upsizes `.folders-actions button` to
`var(--lm-tap-target)` in both dimensions, and does not include `.folders-twisty`. It is
the control that expands a folder — measured 24 × 24 in
`07-sidebar-drawer__pixel7.png`.

### C-4 · Search snippets are clipped mid-word with no ellipsis

`plugins/base/search/src/style.css:74-89` puts
`overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on both
`.search-hit-title` and `.search-hit-snippet`. The snippet's content is not plain text —
it is a run of `<span>` and `<mark>` children (the highlighter), and measured at 390 px
their boxes run to **x = 703**:

```
CLIP sw=500 cw=171 | li.search-hit > span.search-hit-snippet   | "This document lives in `welcome/examples`…"
PAST L=294 R=703   | span.search-hit-snippet > span            | "lives in `welcome/examples` because its…"
PAST L=554 R=617   | span.search-hit-snippet > mark            | "document"
```

At 360 px the snippet box is 141 px against 489–500 px of content. Three of five words per
result. `.search-result-snippet` (the page-level results, `:91-93`) already resets to
`white-space: normal` and reads fine; the navbar dropdown should do the same and clamp to
two lines with `-webkit-line-clamp`.

### C-5 · The navbar search box is too narrow for its own dropdown

`plugins/base/search/src/style.css:18-21` (`flex: 1 1 18rem; max-width: 28rem`) and
`:237-247`, which at ≤640 drops the basis to `10rem` so it stops crowding "New document" on
the second navbar row. The dropdown (`:43-50`) inherits that width: measured `clientWidth`
141 @360, 187 @390, **94 @844 landscape**. The dropdown should escape its trigger's width
on a phone the way the notice panel should (A-5).

### C-6 · `/search` shows two search inputs

The navbar contributes one (`plugins/base/search/src/index.tsx`, navbar item) and the
results page renders its own (`ResultsView.tsx:80`, `.search-form`). Both are visible
simultaneously in `13-search-results__pixel7.png`, with different contents (the navbar one
kept "doc" while the page one held "document"). On a phone, one of them is a whole navbar
row that could be spent on content.

### C-7 · The keybindings table puts every action button off-screen

`plugins/base/commands/src/style.css:223-235` — `.cmd-table { width: 100% }` with no
scroll wrapper, four columns (command + id, keys, actions), and `.cmd-actions`
(`:268-272`) set to `white-space: nowrap`. Measured at 360 px:

```
PAST L=303 R=388 | thead > tr > th                 | "Actions"
PAST L=309 R=382 | tr > td.cmd-actions > button    | "Change"     × 20 rows
```

Twenty `Change` buttons, every one of them 22–28 px past the right edge, and the page does
not scroll horizontally on its own (it pushes `main` instead — A-9). The keybindings
screen is unusable on a phone. `admin` solved the same problem with `.admin-table-scroll`;
here the right answer per the brief is stacked cards (command name, current binding,
Change) since there are only three fields.

### C-8 · The palette is a fixed full-height sheet with no keyboard or inset handling

`plugins/base/commands/src/style.css:40-49` (`.cmd-overlay`, `position: fixed; inset: 0`)
and `:311-323` (at ≤640, `.cmd-palette { width: 100%; height: 100%; max-height: 100%;
border-radius: 0 }`). The input is at the top so it survives, but the option list runs to
the bottom of the *layout* viewport: with the keyboard open the last options are behind it
(`S14-palette-keyboard-open__pixel7.png`), and with it closed the last option sits under
the gesture bar (A-1). `max-height: min(70vh, 36rem)` at `:55` is dead at the mobile
breakpoint, so `dvh` alone would not fix it.

### C-9 · The filter bar fills the first screen, and the list starts below it

`plugins/base/doc-list/src/style.css:65-165` / `FilterBar.tsx:91-299`. The bar is always
expanded — there is no disclosure — and renders, in order: "Title contains" + input,
"Show machine documents" checkbox, "Sort by" select, "Direction" select, "Add condition",
and the DSL disclosure. Measured at 390 × 844 (`04-doc-list__pixel7.png`): **zero document
rows above the fold**. Add one condition (`05b-…`) and the row block (field input,
operator select, type select, value input, `not` checkbox, ✕) pushes the list another
~560 px down.

Everything in the bar is correctly sized and wraps correctly; the defect is that a filter
UI with a nine-operator vocabulary is the first thing a phone user sees when they open
their notes. The brief's "stacked cards" rule does not cover this one — see
**Open questions**, Q2.

### C-10 · `<summary>` targets in doc-list and folders

`doc-list/src/style.css:150-153` (`.doclist-json`, measured 356 × 19.1) and
`folders/src/style.css:262-265` (`.folders-json`, 374 × 19.1). Same root cause as A-16;
listed here so owner C sees them in their own files.

### C-11 · Moving a document between folders is drag-first on a device with no drag

`plugins/base/folders/src/FolderTree.tsx` (drop targets),
`plugins/base/folders/src/FolderContents.tsx:155-159` and
`plugins/base/doc-list/src/DocListView.tsx:126-134` (`draggable` + `onDragStart` with a
`text/plain` payload). HTML5 drag-and-drop does not fire from touch. The fallback exists
and is real, but it is the last sentence of a three-sentence paragraph
(`FolderTree.tsx:366-371`) and it points at the properties panel, which on a phone is B-5.

This is a genuine design gap rather than a CSS bug. See **Open questions**, Q3.

### C-12 · Folder row actions are hover-gated above 640 px

`plugins/base/folders/src/style.css:95-113` — `.folders-actions { display: none }` unless
`:hover`, `:focus-within`, or `.folders-node-active`. `:276-280` turns them on
unconditionally at ≤640. A phone in landscape (844 px — A-7) is above the breakpoint and
has no hover, so "new document in this folder" and "rename" become invisible and
unreachable there. Fixing A-7 resolves it; a `@media (hover: none)` guard would resolve it
independently and more honestly.

### C-13 · Doc-list rows are ~150 px tall on a phone

`plugins/base/doc-list/src/style.css:300-311` stacks the row grid into
`"title" / "meta" / "actions"` at ≤640, which puts a full-width **Move to Trash** button
under every document. Measured: four documents fill the screen below the filter bar. The
delete action having equal visual weight to the document title on the browse screen is
also a safety question on a touch device.

---

# 2. PROSE

Rules applied: short, plain, specific; no exclamation marks; no "simply / just / easily";
no redundant explainer sentence under a label; no em-dash chains; empty states are one
line plus one action; warnings state the risk and the remedy in one breath. **Copy only —
no feature is renamed and no semantics change.**

**Good news first:** there is not one exclamation mark in user-facing copy anywhere in the
tree. There are exactly three "simply / just" instances. The systemic problems are
different: **em-dash asides used as a default connective** (80 occurrences across 36 files
in non-comment lines, excluding the `"—"` empty-value placeholder), **a second explanatory
sentence under almost every label**, and **five leaks of
internal vocabulary** (SPEC section numbers, a milestone number, `document.mode`,
`object-src 'none'`, "kernel contract") into copy a user reads.

## (A) shell-ui / settings / themes / admin + `web/app` screens

| # | File:line | Current | Suggested |
|---|---|---|---|
| A-P1 | `plugins/base/settings/src/SettingsView.tsx:65-70` | "Settings are stored as a **per-user document in this shared workspace**. They sync and work offline like everything else — and other users of this workspace can read them. Never put a secret here; plugin secrets belong in admin configuration, which is encrypted at rest." | "Other people in this workspace can read your settings. Put secrets in admin plugin configuration, which is encrypted." (risk + remedy, one breath; drops the sync sentence, which is true of everything) |
| A-P2 | `plugins/base/settings/src/SettingsView.tsx:135-137` | "provided by `admin`" on every section | Remove. Plugin attribution belongs in admin, not under every settings heading. |
| A-P3 | `plugins/base/admin/src/index.tsx:140` | `` `Administration — ${meta.title}` `` → "Administration — Orphan files" (230 px per tab) | `meta.title` alone ("Orphan files"). The em-dash prefix is repeated eleven times, is the main reason the strip is 1 860 px wide (A-8), and duplicates the `<h2>` right beneath it. |
| A-P4 | `plugins/base/admin/src/index.tsx:64-66` | "Who can sign in, who is an administrator, and one-time reset links." | "Accounts, admin rights, and password reset links." |
| A-P5 | `…/index.tsx:67-69` | "Single-use, 7-day invite tokens. Registration needs one after the first user." | "Single-use invite tokens, valid 7 days." (second sentence is background, not this screen's job) |
| A-P6 | `…/index.tsx:78-80` | "Stored blobs that no document references. Reported, never auto-deleted." | "Stored files no document references. Nothing is deleted automatically." ("blobs" is implementation vocabulary) |
| A-P7 | `…/index.tsx:86-88` | "Counters, and the markdown export that needs no database to restore." | "Workspace counters and the markdown export." |
| A-P8 | `plugins/base/admin/src/AdminView.tsx:82-84` | "You are not an administrator of this workspace. Every route behind this screen is refused by the server, so there is nothing here to show you. Ask an administrator — they can promote an account from this same screen." | "You are not an administrator. Ask one to promote your account." |
| A-P9 | `plugins/base/admin/src/Audit.tsx:94-95` | "Nothing recorded for this filter. Destructive and administrative actions — document deletes and restores, user, invite and plugin operations — land here." | "Nothing matches this filter." (empty state = one line) |
| A-P10 | `plugins/base/admin/src/Plugins.tsx:77-87` | Two paragraphs, ~90 words, opening "**Installing a plugin is an act of trust.**" and ending with three recovery flags. | Keep sentence one and the capabilities caveat; move the recovery paragraph behind a `<details>` or into the plugin card that is actually broken. Twelve lines and ~440 px before the first control on a phone. |
| A-P11 | `…/Plugins.tsx:129-131` | "Nothing is waiting for approval. An uploaded package, and any package dropped into the server's inbox directory, appears here until an administrator approves it — nothing of it runs and nothing of it is served in the meantime." | "Nothing is waiting for approval." |
| A-P12 | `…/Plugins.tsx:149` | "No plugins installed. If the app is rendering, it is doing so in safe mode." | "No plugins installed." |
| A-P13 | `…/Plugins.tsx:233-237` | "The package lands **pending**: its capabilities are shown for approval and nothing of it runs or is served until an administrator approves it. Uploading a version of an already-installed plugin is how an upgrade happens — it goes through the same approval." | "Uploads wait for approval. Nothing runs until you approve it. A new version of an installed plugin upgrades it." |
| A-P14 | `…/Plugins.tsx:350-352` | "Hosts are matched exactly — no wildcards, no scheme, no port. This is the one…" | "Hosts match exactly: no wildcards, no scheme, no port." |
| A-P15 | `…/Plugins.tsx:555` | "The frontend half is still served — half a plugin is usually better than none." | "The frontend half is still served." (the editorial clause is the author talking to a reviewer) |
| A-P16 | `…/Plugins.tsx:698-700` | "This is part of the base distribution. Uninstalling it removes a part of the visible app — that is by design (the base set is installed like any other plugin), but…" | "Uninstalling this removes part of the app." (risk, one breath) |
| A-P17 | `…/Plugins.tsx:817` | "Nothing recorded for this plugin since the server started. This list lives in memory; …" | "Nothing recorded since the server started." |
| A-P18 | `…/Plugins.tsx:687-688` | `confirm()` strings of 2–3 sentences each ("Uninstall X AND permanently delete its stored data and its %%% sections from every document? This cannot be undone.") | Shorten to one question plus one consequence. Also a layout problem: `confirm()` is an unstyled Android system dialog that ignores every token in the theme — see **Open questions**, Q4. |
| A-P19 | `plugins/base/admin/src/Storage.tsx:41-43` | "Blobs that no document's text references — including `%%%` sections, since the scan reads the materialized text. Nothing is deleted automatically. A file referenced only by a document in Trash is *not* an orphan." | "Files no document references. Nothing is deleted automatically; a file used only by a trashed document is not an orphan." |
| A-P20 | `…/Storage.tsx:161-162` | "…Restoring replaces the whole text — frontmatter included — in one CRDT transaction." | "Restoring replaces the whole text, frontmatter included." ("CRDT transaction" is internal) |
| A-P21 | `…/Storage.tsx:224-225` | "No snapshots yet. They are taken on the first edit after a quiet period, and capped daily." | "No snapshots yet." |
| A-P22 | `…/Storage.tsx:254` | Restore `confirm()`: three sentences with a `\n\n` in it. | "Replace “{title}” with this snapshot? Everyone sees the change; the current text is snapshotted first." |
| A-P23 | `…/Storage.tsx:329-331` | "The export is a zip of every document as plain markdown — the recovery path that needs no MongoDB. Back up the database as well (`dev-docs/resolved/OPERATIONS.md`); this export carries no CRDT history, snapshots or attachments." | "A zip of every document as markdown. It does not include history, snapshots or attachments — back up the database too." (drops the repo path, which no app user can open) |
| A-P24 | `plugins/base/admin/src/Users.tsx:58-59` | "One-time password reset link for **{email}**. It is shown once — copy it now." | "Reset link for {email}. Copy it now; it is shown once." |
| A-P25 | `…/Users.tsx:158-159` | "This is a shared workspace: every signed-in user can read, edit and delete every document. The audit log is the accountability here, not permissions." | "Everyone signed in can read, edit and delete every document. The audit log records who did what." |
| A-P26 | `…/Users.tsx:196` | "Email (optional — pins the invite to one address)" | "Email (optional). Pins the invite to one address." |
| A-P27 | `…/Users.tsx:227-228` | "No invites. After the first user, registration needs one — so this is also the answer to “why can nobody sign up”." | "No invites. People need one to register." (the scare-quoted joke is the author's voice) |
| A-P28 | `…/Users.tsx:279-280` | "The listing stores only a hash of each token, so a lost token cannot be recovered — revoke it and create another." | "A lost token cannot be recovered. Revoke it and create another." |
| A-P29 | `plugins/base/themes/src/Picker.tsx:112-113` | "Your choice is saved on this device and has not reached your settings yet — it syncs to your other devices as soon as the server is reachable." | "Saved on this device. It reaches your other devices when you are online." |
| A-P30 | `…/Picker.tsx:89` | "Currently showing the **{scheme}** appearance." | "Showing {scheme}." |
| A-P31 | `…/Picker.tsx:147` | "Applied when the {scheme} appearance is showing." | "Used in {scheme}." |
| A-P32 | `web/app/src/ui/BootScreen.tsx:93-95` | "Life Manager needs a browser with import-map support — Chrome or Edge 89+, Safari 16.4+, Firefox 108+. Everything else about your data is fine; this browser **simply** cannot load the app." | "Life Manager needs Chrome 89+, Edge 89+, Safari 16.4+ or Firefox 108+. Your data is unaffected." (**"simply" violation**) |
| A-P33 | `web/app/src/ui/BootScreen.tsx:65-67` | "The server cannot be reached, and this device has not signed in yet — so there is no local copy of your workspace to open. Connect once, and after that it opens offline." | "The server is unreachable and this device has never signed in, so there is nothing stored locally to open. Connect once and it will open offline after that." |
| A-P34 | `web/app/src/boot/ShellSection.tsx:44` | "The app shell around this workspace: bridge version, what it can do natively, and which bundle is running." | "Bridge version, native capabilities and the bundle running on this device." |
| A-P35 | `…/ShellSection.tsx:117-118` | "yes — this device is running the published bundle" / "no — a newer bundle is published; it installs at the next launch" | "Yes" / "No. A newer bundle installs at the next launch." |
| A-P36 | `…/ShellSection.tsx:136-137` | "scheduled — they fire with the app closed" / "foreground only — this device cannot schedule reminders" | "Scheduled. They fire with the app closed." / "Foreground only. This device cannot schedule reminders." |
| A-P37 | `web/app/src/ui/AppFrame.tsx:171-172` | "`{pluginId}` holds the UI mount and threw while rendering, so the app has no layout. Your documents are untouched — this is a display failure." | "{pluginId} draws the interface and it failed. Your documents are untouched." ("holds the UI mount" is internal) |
| A-P38 | `web/app/src/ui/AppFrame.tsx:193-194` | "The kernel started and the workspace is synced, but no plugin claimed the UI mount — normally `shell-ui`. Boot mode: `{bootMode}`." | "Your workspace loaded, but no plugin drew the interface." Keep the boot mode on its own line as a diagnostic. |
| A-P39 | `web/app/src/safe-mode/BareManager.tsx:88-90` | "Enabling and disabling plugins is an administrator action on the server **(M4)**. To stop the server serving plugins to every client at once, set `DISABLE_PLUGINS=1` and restart it." | Drop "(M4)" — **a milestone number in shipped copy**. "An administrator enables and disables plugins on the server." |
| A-P40 | `web/app/src/safe-mode/BareManager.tsx:43` | "No plugins are loaded. Kernel contract `{KERNEL_API_VERSION}`." | "No plugins are loaded." Keep the version in the table's footer as a diagnostic. |
| A-P41 | `plugins/base/shell-ui/src/Shell.tsx:283` | "Pick something from the sidebar or the navigation bar." | "Pick a view from the menu." On a phone there is no visible sidebar — it is behind ☰. |
| A-P42 | `plugins/base/shell-ui/src/Shell.tsx:292-293` | "Nothing provides the view `{view.id}`. The plugin that does may have failed to load — check the notices in the navigation bar." | "Nothing provides this view. Check the notices for a plugin that failed to load." |
| A-P43 | `plugins/base/shell-ui/src/sync-status.ts:74` | "Offline. Everything is still readable, and documents you have opened are still editable." | Good as-is; trim to "Offline. Everything is readable; documents you have opened are editable." |
| A-P44 | `web/app/src/boot/AuthGate.tsx:122` | `` `Too many attempts — ${cause.message}` `` | `` `Too many attempts. ${cause.message}` `` |

## (B) document-surface / viewer / editor / properties / markdown

| # | File:line | Current | Suggested |
|---|---|---|---|
| B-P1 | `plugins/base/editor/src/index.tsx:362-363` | "Fetching the editable copy… Reading works meanwhile; offline, a document you have never opened stays read-only until this device reconnects **(SPEC §4.1)**." | "Opening for editing… You can read it now. A document you have never opened stays read-only until this device reconnects." (**spec reference in shipped copy**) |
| B-P2 | `plugins/base/properties/src/index.tsx:282-284` | "At least one frontmatter line could not be read and is missing from the list below. **The document text is untouched** — open edit mode to fix the line by hand. **(SPEC §3.4: a malformed line is dropped, never rewritten.)**" | "One frontmatter line could not be read, so it is missing below. The text is untouched — fix the line in edit mode." (**spec reference**) |
| B-P3 | `plugins/base/document-surface/src/index.tsx:648-649` | "No way of showing a document is installed. A workspace needs at least one `document.mode` contribution." | "No plugin can display a document. Ask an administrator to install one." (`document.mode` is a plugin-author term) |
| B-P4 | `plugins/base/viewer/src/index.tsx:279-281` | "Inline PDF embedding is blocked by the app's content-security policy (`object-src 'none'`). Use “Open the file”." | "PDFs cannot be shown inline. Open the file instead." |
| B-P5 | `plugins/base/markdown/src/task-item.tsx:92` | `title={…"${state.label} — right-click for all states"}` | "{label}. Long-press for other states." On a phone "right-click" names a gesture that does not exist, and `title` is hover-only there anyway. |
| B-P6 | `plugins/base/document-surface/src/index.tsx:595-597` | "Nothing in this workspace has the id `{id}`. It may have been permanently deleted, or this client may not have finished its first sync." | "No document with this id. It may have been deleted, or this device may still be syncing." ("this client" → "this device") |
| B-P7 | `…/index.tsx:616-617` | "This document's frontmatter has a line that could not be read. The text is untouched; open the properties panel to see which keys are missing." | "One frontmatter line could not be read. The text is untouched — see the properties panel." |
| B-P8 | `…/index.tsx:622-626` | "Editing is unavailable: the editable copy could not be fetched ({error}). Reading works from the replicated copy." | "Cannot edit: the editable copy did not load ({error}). You can still read it." |
| B-P9 | `…/index.tsx:748-749` | "This document is in the Trash (deleted {iso}). It is restorable for 30 days." | "In the Trash since {date}. Restorable for 30 days." The raw ISO string is rendered unformatted — every other timestamp in the app goes through `formatWhen`. |
| B-P10 | `…/index.tsx:138` | point description: "A way of showing one document — `read`, `edit`, or anything else." | Developer-facing; visible only in admin. Low priority: "How a document is displayed." |
| B-P11 | `plugins/base/editor/src/index.tsx:379-380` | "This copy is local only — the server connection for this document is down. Edits are kept and will sync on reconnect." | "Offline. Your edits are saved here and sync when the connection returns." |
| B-P12 | `plugins/base/editor/src/index.tsx:448` | "Offline — everything typed so far is saved locally" | "Offline. Everything typed is saved on this device." |
| B-P13 | `plugins/base/editor/src/index.tsx:453` | "Sign in again to sync (nothing is lost)" | "Sign in again to sync. Nothing is lost." |
| B-P14 | `plugins/base/editor/src/index.tsx:147-148` | setting: "Fold frontmatter when a document opens" / "Machine `%%%` sections always start folded; frontmatter is yours." | Label is fine. Description → "Machine sections always start folded." (Also: this setting is unreachable — no screen renders it. `POLISH-BACKLOG.md` item 2.) |
| B-P15 | `plugins/base/properties/src/index.tsx:290-291` | "This document has no frontmatter yet. Adding a property writes a `---` block at the top of the text." | "No properties yet." plus the existing Add row as the one action. (empty state = one line + one action) |
| B-P16 | `plugins/base/properties/src/index.tsx:471-472` | "Types follow the document: `3` is a number, `true` a boolean, `"3"` a string, empty is null." | "`3` is a number, `true` a boolean, `"3"` text, empty is null." |
| B-P17 | `plugins/base/properties/src/index.tsx:485` | "Frontmatter editing needs the kernel's splice helpers, which this build does not implement yet." | "This build cannot edit properties yet." |
| B-P18 | `plugins/base/properties/src/index.tsx:273` | "Open a document to see its properties." | Fine. Keep. |
| B-P19 | `plugins/base/markdown/src/runtime.ts:240-241` | "That checkbox moved while you were reading — nothing was changed." / "Reopen the document and try again." | "The document changed while you were reading, so nothing was ticked. Reopen it and try again." |
| B-P20 | `plugins/base/markdown/src/index.tsx:300` | "Select an embedded file first, then promote it to a document." | "Select an embedded file first." |
| B-P21 | `plugins/base/viewer/src/index.tsx:69` | "This document's text has not reached this device yet." | Fine. Keep. |

## (C) doc-list / folders / search / commands + kernel notices

| # | File:line | Current | Suggested |
|---|---|---|---|
| C-P1 | `plugins/base/doc-list/src/DocListView.tsx:294-296` | "No document matches these conditions. Clearing them shows everything — the filter runs on this device, so it is not a connection problem." | "No document matches. Clear the filter." (empty state = one line + one action; the reassurance about connections is a redundant explainer) |
| C-P2 | `…/DocListView.tsx:301-309` | "No documents yet." + "Everything here is one markdown file: `---` frontmatter at the top, text in the middle. Put `path: home/lists` in the frontmatter and it appears in the folder tree." + "Create the first document" | "No documents yet." + the button. The markdown tutorial belongs in a welcome document, which the first run already seeds. |
| C-P3 | `…/DocListView.tsx:221-222` | "Documents stay here for {n} days, then the server purges them permanently. Restoring brings a document back exactly as it was." | "Deleted documents are kept for {n} days." |
| C-P4 | `…/DocListView.tsx:237` | "Trash is empty. Deleted documents appear here for {n} days." | "Trash is empty." |
| C-P5 | `plugins/base/doc-list/src/FilterBar.tsx:112` | `title="Documents whose fm.path starts with a dot — the kernel's per-user settings documents, and anything a plugin files the same way. They are ordinary documents; this only decides whether they are listed here."` | "Documents plugins keep for themselves." Three sentences in a `title` attribute, which on a touch device never appears at all. |
| C-P6 | `…/FilterBar.tsx:246` | "Incomplete — this condition is not being applied." | "Incomplete. This condition is ignored." **Also flagged as a possible correctness bug** — see Open questions, Q5. |
| C-P7 | `…/FilterBar.tsx:294` and `plugins/base/folders/src/FolderContents.tsx:175` | "Show this filter as the query language sees it" | "Show the filter as JSON". Eight words on a 19 px-tall summary. |
| C-P8 | `…/FilterBar.tsx:99, 174, 214` | placeholders "groceries", "fm.status", "open" | `groceries` reads as a value the user typed (screenshots repeatedly mistaken for one). Prefer "Search titles", "Property name", "Value". |
| C-P9 | `plugins/base/doc-list/src/index.tsx:89-94` | "The document could not be created." + detail "Creating a document needs the server: it mints the id and records the document before it can be edited. Existing documents stay readable offline, and recently opened ones stay editable." | "Could not create the document — the server is unreachable. Existing documents still work offline." ("mints the id" is internal) |
| C-P10 | `plugins/base/folders/src/FolderTree.tsx:229-231` | "A folder is **just** a `path:` line in a document's frontmatter — `path: home/lists` puts it in `home` → `lists`. Nothing is created or deleted: the tree is whatever paths exist." | "A folder is a `path:` line in a document's frontmatter. `path: home/lists` files it under home/lists." (**"just" violation**) |
| C-P11 | `plugins/base/folders/src/FolderTree.tsx:366-371` | "Drag a document onto a folder to move it, or use a folder's rename button (✎, or F2 on the keyboard). Renaming rewrites `fm.path` in every document inside it. On a touch screen, move a document by editing its `path` in the properties panel." | On touch: "Move a document by editing its `path` in its properties." Three sentences, two of which describe gestures the device does not have (see layout C-11). |
| C-P12 | `plugins/base/folders/src/FolderTree.tsx:335` | `title="Rename or move (F2)"` | "Rename or move". F2 on a phone. |
| C-P13 | `plugins/base/folders/src/FolderContents.tsx:140` | "Every document has a folder." | Reads as a claim, not an empty state. "Nothing here yet." |
| C-P14 | `plugins/base/folders/src/FolderContents.tsx:143-146` | "A document joins this folder by having `path: {path}` in its frontmatter — drag one here, or create one." | "Set `path: {path}` in a document's properties to file it here." |
| C-P15 | `plugins/base/folders/src/index.tsx:188` | "“{target}” is inside “{source}” — that would move the folder into itself" | "Cannot move “{source}” into itself." |
| C-P16 | `plugins/base/search/src/ResultsView.tsx:112-114` | "Some providers need a network connection. Results below come from the ones that answered — the local index covers every document on this device, online or off." | "Some results need a connection. These come from this device." ("providers" is a plugin-author term) |
| C-P17 | `…/ResultsView.tsx:119-120` | "Type to search titles, text and frontmatter. Search runs on this device, so it works offline." | "Search titles, text and properties." |
| C-P18 | `…/ResultsView.tsx:128-135` | "Nothing matches “{q}”." + "If this workspace was just opened on this device, the local index may still be building — it indexes in the background and this page updates when it finishes." | "Nothing matches “{q}”." Show the index-building sentence **only while it is building**, not as a standing hedge. |
| C-P19 | `…/ResultsView.tsx:91` | `title="Documents whose fm.path starts with a dot — the per-user settings documents the kernel keeps, and anything a plugin files the same way."` | Same as C-P5. |
| C-P20 | `…/ResultsView.tsx:102` | "unavailable — {error}" | "unavailable: {error}" |
| C-P21 | `plugins/base/search/src/index.tsx:71, 79` | provider labels "This device" / "Server (needs a network)" | "On this device" / "On the server". The parenthetical is a caveat in a label. |
| C-P22 | `…/ResultsView.tsx` counts | "This device: 3 hits  Server (needs a network): 3 hits" above "2 results for document" | Three numbers, two nouns, one screen. Pick "results" and show one total, with the per-source split behind a disclosure. |
| C-P23 | `plugins/base/commands/src/KeybindingsSection.tsx:102-105` | "Plugins suggest defaults; your changes win. Between plugins the first registration wins and the rest are listed below. Settings are stored in a document in the shared workspace — other users can read them." | "Your bindings override plugin defaults." The conflict rule is already shown by the Conflicts section beneath it; the storage sentence repeats A-P1 verbatim one screen down. |
| C-P24 | `…/KeybindingsSection.tsx:110-112` | "Per-user keybindings need the kernel settings store, which this build does not provide yet. The table below shows the effective defaults and is read-only." | "This build cannot save keybindings. The table shows the defaults." |
| C-P25 | `…/KeybindingsSection.tsx:181` | "Press a key… (Esc cancels, Backspace unbinds)" | Correct on a keyboard, meaningless on a phone. Gate the whole keybindings section on a keyboard being available, or say "Connect a keyboard to change bindings." |
| C-P26 | `plugins/base/commands/src/index.tsx:348` | "Rebind any command. Your bindings win over plugin defaults." | "Change any command's shortcut." |
| C-P27 | `plugins/base/commands/src/Palette.tsx:202-203` | "No commands are registered yet." / "Nothing matches “{query}”." | Both fine. Keep. |
| C-P28 | `web/app/src/boot/kernel-init.ts:152-155` | "This browser may evict offline data." + detail "Storage persistence was not granted, so the browser can clear the local workspace copy under disk pressure. Unsynced edits are the only thing at risk." | "The browser may delete this workspace's offline copy if storage runs low. Sync while you are online so nothing is lost." — **risk and remedy in one breath**, in the message, not split into a `<details>` the user must open. Also "evict" is storage-engine vocabulary. |
| C-P29 | `web/app/src/boot/kernel-init.ts:134` | "Your settings could not be read; defaults are in use." | "Your settings could not be read, so defaults are in use. Reload to try again." (adds the remedy) |
| C-P30 | `web/app/src/loader/loader.ts:207-211` | `"${n} plugins failed to load; ${skipped} skipped."` | Drop the second clause when `skipped === 0`. Today the common message reads "1 plugin failed to load; 0 skipped." |
| C-P31 | `web/app/src/main.tsx:456-460` | "Offline, and this device has never fetched the plugin list." + detail "Your documents are here and readable, but no plugin could be activated — including the one that draws the interface. Reconnect and reload once; after that the list is remembered for offline boots." | "Your documents are here, but the interface could not load. Reconnect and reload once." |
| C-P32 | `web/app/src/main.tsx:313-314` | "An app update is ready. Close and reopen Life Manager to finish it." | Good. Keep. |
| C-P33 | `web/app/src/main.tsx:356` | `"${count} plugin problem${…} in this session."` | "{n} plugins had problems." ("in this session" is scoping trivia) |
| C-P34 | `web/app/src/main.tsx:404-405` | "The runtime layer is incomplete; plugins may fail to load." + "The import map does not resolve: {list}. Rebuild the app bundle (`npm run build:app`)." | A build command in end-user copy. Keep the detail for the console; the notice should read "Some plugins may not load. Reinstall or update the app." |
| C-P35 | `web/app/src/main.tsx:145, 255` | "An update is available." + `Reload` action | Good. Keep. |
| C-P36 | `web/kernel/src/runtime/registry.ts:119, 164` | `` `duplicate key "${key}" — the contribution from "${winner}" wins` `` | Reaches the notice centre via `onPluginProblem`. "Two plugins claim “{key}”. {winner} is being used." |

---

## Open questions the fix agents cannot settle alone

**Q1 — Where does the properties panel live on a phone?** (owner B, with an owner A seam)
It is a `settings.section`-style sidebar contribution (`properties/src/index.tsx:165-172`),
so on a phone it is four screens down inside a drawer that covers the document. Options:
(a) make it a `document.mode` tab beside Read/Edit on compact widths — cheap, but
`document-surface` treats modes as symmetric and Properties is not a way of *showing* the
document; (b) a bottom sheet the surface opens from a header button; (c) leave it and
accept the drawer. This is a product decision about what a document screen *is*, and it
interacts with C-11 (the documented touch path for moving a document goes through this
panel).

**Q2 — What does the doc-list show first on a phone?** (owner C)
Today the filter bar is always expanded and pushes every document below the fold. A
disclosure (`<details>` collapsed by default at ≤640) is the obvious fix and is a
one-file change — but it hides the sort control too, and "sort" is the thing a phone user
actually reaches for. Someone should decide whether sort stays visible while the condition
builder collapses.

**Q3 — Is there a touch path for moving documents between folders?** (owner C)
Drag-and-drop is the only direct affordance and does not exist on touch. The fallback is
editing `fm.path` by hand in a panel behind a drawer (Q1). A "Move to folder…" command
with a folder picker would close it, but that is a new feature, not copy or CSS, and the
brief forbids changing semantics. Flagging rather than fixing.

**Q4 — Native `confirm()` for destructive admin actions.** (owner A)
`Users.tsx:135`, `Storage.tsx:104`, `Storage.tsx:253`, `Plugins.tsx:469`, `Plugins.tsx:689`
all use `window.confirm()`. On Android that is an unstyled system dialog that ignores every
kernel token, cannot be themed, and renders three-sentence strings (A-P18, A-P22) as an
unformatted blob. Replacing them with an in-page dialog is the right answer but is a new
component; shortening the strings is in scope, replacing the mechanism is not.

**Q5 — "Incomplete — this condition is not being applied" may be lying.** (owner C)
Adding a condition with an empty value shows that note, and the document list nonetheless
went to **zero rows** in two separate runs (`05b-doc-list-filter-expanded__pixel7.png`,
taken with four documents in the workspace). Either `buildEffectiveFilter`
(`doc-list/src/filter.ts`) includes the incomplete clause while `invalidClauses` reports
it as dropped, or something else empties the list. This is a correctness bug, not a
layout or copy one, and is outside all three ownerships — someone should own it.

> **Answered 2026-09-25 (core-improvements pass). The note was telling the truth; the
> observation was the fold.** Measured on a running build at 390 px with six documents:
> pressing "Add condition" leaves the list at six rows and the emitted filter byte-identical
> to the machine-document exclusion alone. `buildFilter` drops a clause the moment
> `buildClause` returns `undefined`, and `invalidClauses` asks the same function, so the two
> could not disagree. What `05b` shows is item **C-9** one screen further down: the expanded
> bar was 1 700 px tall and the rows were below the fold of a viewport-sized screenshot. The
> old empty state — "No document matches **these conditions**" — is what made any empty list
> read as a claim that the conditions had run.
>
> Pinned rather than closed on a paragraph: `filter.test.ts` now asserts that an unusable row
> changes nothing about the effective filter (alone, beside a good one, in `and` and in `or`),
> and that `clauseProblem` and `buildClause` agree over a 3 000-row matrix of every field,
> operator, value type and value the controls can produce. `app/e2e/list-alignment.spec.ts`
> asserts the same thing where the audit looked: the rendered row count does not move.
>
> Three real defects were found while proving it, all fixed: the "Filters" badge counted a
> whitespace-only title box as an applied condition; **Clear** silently unticked "Show machine
> documents"; and the note said "Incomplete" over rows that were entirely filled in and
> refused for a type reason (a text operator against a date, an ordering operator against
> true/false). The note now gives the reason.

**Q6 — Two search boxes.** (owner C, with an owner A seam)
Removing the navbar search item on compact widths buys back a third of the mobile navbar,
but the navbar item is a `navbar.item` contribution owned by `search` while the navbar's
compact rules are `shell-ui`'s. Whoever takes it should decide whether `shell-ui` gains a
"hide on compact" flag for navbar items (a contract-shaped change) or `search` checks
`kernel.ui` compactness itself.

---

## Artefacts

- Screenshots: `…/scratchpad/mobile-audit/<surface>__<profile>.png` — **168 files**:
  66 surfaces at `pixel7` (51 from the main walk + 15 supplementary), and the same 51 at
  `narrow` and at `landscape`.
- Raw probe data: `…/scratchpad/probe-pixel7.json`, `probe-narrow.json`,
  `probe-landscape.json`, `supplement-pixel7.json` — per surface, the full overflow /
  off-screen / touch-target lists with measured pixel values.
- The walker: `…/scratchpad/audit.mjs`, `supplement.mjs`, `probe.mjs`.
- Server log: `…/scratchpad/server.log` (port 8131, database `life_manager_mobile_audit`).

---

# RESULTS — after the fix wave (verified 2026-09-25)

Three fix agents worked the three ownerships above; this section is the verification
pass over their combined output, re-measured the same way the audit was measured.

## How this was verified

Same method, new numbers. An isolated stack, a fresh database, and the **real** binary
serving the **real** rebuilt bundle over a private registry snapshot, so a parallel
agent recomposing the shared registry could not swap plugin files mid-run:

```bash
LM_E2E_PORT=8191 LM_E2E_DB=life_manager_verify \
  LM_E2E_PLUGINS=<scratchpad>/registry  node web/app/e2e/server.mjs
```

The owner's stack on `:8080` was never touched: it is a compose container serving the
assets baked into its image (`/srv/web`, `/srv/plugins`), not the working tree, and it
stayed up and healthy throughout. The only shared resource is Mongo, and
`life_manager` was never opened — the test database is a different name and the
launcher drops only that one. Checked at the end: container still `Up (healthy)`,
`life_manager.documents` still 11.

## Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | **PASS** — clean |
| `npm run test` (vitest) | **PASS** — 832 passed, 1 skipped, 45 files |
| Playwright, full app suite | **PASS** — **54/54** |
| `mise run web-build` from clean | **PASS** — `web/app/dist`, `plugins/base/dist` and `kernel-api/dist` deleted first; exit 0 |
| `cargo test -p life-manager-server` | **not run, and correctly so** — no file under `backend/` changed in this wave |

The 54 are the 32 the fix agents left green plus the 6 new route-sweep tests below, in
one run against one stack. Two things that were reported as failing during the fix wave
pass here: `journeys.spec.ts:477` (the strict-mode violation from `admin`/`settings`
contributing two regions with the same accessible name — closed by `AdminSectionFrame`),
and the whole-suite runs that were dying with `ERR_CONNECTION_REFUSED`, which were
agents stopping each other's servers rather than a defect.

## Defect counts per page: before → after

Layout counts are the audit's own item ids, so they are comparable line for line.
"Off-screen" is the measured count of leaf elements past a viewport edge at the worst
of the three profiles — the same probe, re-run.

| Page | Layout before | Layout open | Prose before | Prose open | Off-screen before | Off-screen after |
|---|---:|---:|---:|---:|---:|---:|
| Global chrome (navbar, breakpoint, safe area, keyboard) | 6 | **1** | 5 | 0 | — | — |
| Settings shell | 2 | **0** | 2 | 0 | 28 @360 | **0** |
| Admin (7 tabs) | 4 | **0** | 26 | 0 | 14 @360 | **0** |
| Document surface / viewer / editor | 3 | **0** | 16 | 0 | 4 @390 | **1** (sanctioned) |
| Properties panel | 5 | **1** | 5 | 0 | 1 @844 | **1** (the same one) |
| Doc list (+ filters, empty, Trash) | 4 | **0** | 9 | 0 | 0 | 0 |
| Folders (tree + contents) | 4 | **1** | 6 | 0 | 0 | 0 |
| Search (box + results) | 3 | **1** | 7 | 0 | 4 @390 | **0** |
| Command palette + keybindings | 2 | **0** | 5 | 0 | 20 @360 | **0** |
| Notices / banners | 2 | **0** | 9 | 0 | 1 @360 | **0** |
| Themes ("Appearance") | 1 | **0** | 3 | 0 | — | — |
| "This device" (shell section) | 1 | **0** | 3 | 0 | 1 @844 | **0** |
| Boot / safe mode / re-auth screens | 2 | **0** | 4 | 0 | — | — |
| Auth gate | 0 | 0 | 1 | 0 | 0 | 0 |
| **Totals** | **39** | **4** | **101** | **0** | | |

Prose: **96 of the 101 items applied**; the other five are the ones the audit itself
marked "keep, already good" (B-P18, B-P21, C-P27, C-P32, C-P35). One of the 96, C-P18,
is applied as far as it can be — see the deferred list.

### The three headline numbers

- **The body never scrolls sideways**, on any of 49 surfaces at any of three profiles.
  It did not before either; what changed is the level below. `main#shell-main` no
  longer scrolls sideways anywhere, and the settings pane that measured
  `scrollWidth` 388 / 493 / 828 against `clientWidth` 360 / 360 / 574 is now equal at
  all three.
- **No text block is wider than the screen.** This is the check that actually catches
  the audit's worst bug: `.docsurface-pane` measured 659 px in a 390 px viewport with
  its `<h1>` and paragraphs stretched to 651 px. Re-measured: 390 / 390, and zero
  over-wide headings, paragraphs or list items on any surface at any profile.
- **Four off-screen leaves, down from 28 at the worst page — and all four are the same
  element**: the `<code>` inside `<pre class="md-code">` on the deliberately-hostile
  test document, in a container with `overflow-x: auto` that really does scroll. That
  is the pattern the brief asks for ("wide content scrolls inside its own container"),
  not a defect.

## Found and fixed during verification

Four things the per-ownership lists did not cover, each verified against the running
app before and after:

1. **A-7 was still open in four stylesheets.** `document-surface`, `editor`, `viewer`
   and `properties` still carried the width-only `@media (max-width: 640px)` while
   `_shared/compact.ts`'s `COMPACT_MEDIA_QUERY` had moved to
   `(max-width: 640px), (max-height: 480px) and (pointer: coarse)`. The consequence was
   precisely A-7: on a phone **in landscape**, `isCompact()` said yes and those four
   stylesheets said no — so the editor's soft-keyboard bottom padding, the mode
   switcher's compact layout, the viewer's phone typography and B-4's 44 px chip target
   were all unreachable in the orientation people read in bed in. All four now spell
   the canonical query, with the same "change both together" comment the other nine
   carry. Every compact `@media` line in the tree is now byte-identical.
2. **The snapshot picker's rows were 20–41 px tall.** `.admin-link` strips the kernel's
   button styling with `!important` so an id inside a sentence reads as a link — right
   for the audit log's use, wrong for `.admin-picker`, where the same class is a
   wrapped row of document chips and picking one is the only way into the rest of the
   screen. This is the C-1 defect ("the primary control is 22.5 px tall") in a place
   nobody's list reached. Scoped fix on `.admin-picker .admin-link`; the inline audit
   ids are deliberately left alone. Measured: 25 sub-44 px controls on the snapshots
   tab → **0**.
3. **The recovery screens had sub-44 px controls.** `?safe=bare` is where someone lands
   when everything else is broken, and its two ways out ("Normal boot", "Base plugins
   only") were 20 px tall inline links, beside a notice-dismiss button the kernel
   stylesheet had explicitly sized to `tap-target − 12px` (32 px) with no justifying
   comment. Also the 404's single action, at 141 × 20. All three now take the full
   target; `?safe=bare` measures **zero** sub-44 px controls at all three profiles.
4. **One prose straggler**, found by scanning the 402 distinct strings the app actually
   renders rather than by grepping source: `extra-task-states`' manifest description
   shipped "(SPEC §6.6)" and backtick markup into the admin plugin list. Copy only.

## Still open, with reasons

Four layout items and one prose item. None is a regression; each is a decision or a
missing capability rather than a defect anyone declined to fix.

| Item | Page | Why it is still open |
|---|---|---|
| **A-4** (partial) — the navbar costs two rows | Global chrome | Padding and row gap are spent (104 → ~96 px). The rest is **Q6**: removing the duplicate `Commands`/search items needs a decision between a `shell-ui` "hide on compact" flag for `navbar.item` (a contract-shaped change) and `search`/`commands` testing compactness themselves. Two plugins' ownership plus a contract question. |
| **B-5** — the properties panel is behind the drawer | Properties panel | **Q1**, a product decision about what a document screen *is* on a phone: a third mode tab beside Read/Edit, a bottom sheet, or leave it. `document-surface` treats modes as symmetric and Properties is not a way of *showing* the document, so (a) is not free. Copy and control sizing inside the panel are fixed; where it lives is not a CSS question. |
| **C-6** — two search inputs on `/search` | Search | The other half of **Q6**, same seam: the navbar item belongs to `search`, the compact navbar rules to `shell-ui`. |
| **C-11** — moving a document between folders is drag-first | Folders | **Q3**. HTML5 drag-and-drop does not exist on touch, and the fallback is editing `fm.path` in the panel Q1 is about. Closing it means a "Move to folder…" command with a picker — a new feature, which the brief forbids. The *copy* is fixed: the tree's hint now tells a touch device the truth about which gestures it has, and the `cursor: grab` tell is gone. |
| **C-P18** (partial) — the search index hedge | Search | `@kernel` exposes **no index-status signal**, so "show this only while the index is building" is not implementable from a plugin. Reduced from three sentences to one clause, with the gap named in a code comment. Closing it properly is a kernel contract addition. |

Three further items the audit raised are **resolved rather than deferred**, and are
recorded here because their resolution differs from what the audit proposed:

- **A-17** (theme radios 17.6 px) — the boxes are now 1.5 rem, and the 44 px target
  stays the row `<label>`, which is the correct hit area for a radio. The 195 sub-44 px
  `input` elements the re-measurement counts across the app are all checkbox and radio
  boxes inside 44 px labels; that is the pattern, not a backlog.
- **B-8** (`.properties-input` clipped in the landscape sidebar) — the audit said
  "fixing A-7 resolves it", and A-7 is now fixed in `properties/style.css`. The other
  half, `shell-ui` declaring `container-type: inline-size` on the sidebar so
  `properties`' `@container (max-width: 20rem)` rules can fire at all, has landed too.
- **Q5** ("Incomplete — this condition is not being applied" may be lying) — **it is
  not lying, and there is no bug.** `buildFilter` skips exactly the clauses
  `invalidClauses` reports, because both call `buildClause` and test it for
  `undefined`; `buildLiteral("str", "")` returns `undefined`, so a new empty condition
  is genuinely dropped. Driven against the running app: 45 rows before adding an empty
  condition, 45 rows after, with the note shown. Whatever emptied the list in the audit
  screenshot, it was not this. Q5 can be closed.

**Q4** (native `confirm()` for destructive admin actions) is unchanged and remains a
real defect on Android: an unstyled system dialog that ignores every kernel token. The
five strings are shortened as the brief allowed; replacing the mechanism is a new
component. `POLISH-BACKLOG.md` is the right home for it.

## The permanent regression net

`web/app/e2e/mobile-routes.spec.ts` — 6 tests that visit **every route** at 390 px and
assert the page does not scroll sideways. It exists because the per-group mobile specs
each own a set of surfaces and none of them can enforce the global rule for another:
a plugin that reintroduces the defect now fails here even when nobody extended that
plugin's own spec.

Routes are **discovered from the running app**, not listed in the file — settings
sections from the rendered nav, admin sections from the rendered tablist — so a section
contributed tomorrow is swept tomorrow. The document it sweeps carries a
300-character URL, an unbreakable inline-code span, a five-column table and an
unwrapped fence, because a sweep over empty documents proves nothing about the page
people paste links into. Coverage: the browse/search/document routes plus edit mode,
every settings section, every admin section, the drawer, the palette, the notice panel,
the auth gate in both modes, `?safe=bare` and `?safe=1`.

**It checks three levels, and the third is the one that matters.** The first two —
`documentElement` and `main#shell-main` — were not enough, and this was verified rather
than assumed: with the B-1 regression deliberately put back into the served CSS, the
spec **passed**, because `.docsurface-pane` is itself an `overflow-x: auto` box, so the
page held, `main` held, and the article inside was 651 px wide with its `<h1>` running
off the screen. The third check asserts that **a block of text fits the screen** —
headings, paragraphs and list items, with `pre`, `table` and `code` exempt because
scrolling those inside their own container is the sanctioned pattern. With that check
added, the same reintroduced regression fails with:

```
/doc/<id> — a block of text is wider than the screen in a 390 px viewport;
offenders: h1 627px wide, p 627px wide, p 627px wide, li.md-item.md-task 627px wide, …
```

The CSS was then restored and the spec re-run green. A net nobody has seen catch
anything is not known to work.

## Artefacts

- Screenshots: `…/scratchpad/mobile-after/<surface>__<profile>.png` — **147 files**,
  49 surfaces at `pixel7`, `narrow` and `landscape`.
- Raw probe data: `…/scratchpad/mobile-after/measurements.json` (per surface and
  profile: body scroll, clipped vs scrollable overflow, off-screen leaves, sub-44 px
  controls, over-wide text blocks) and `summary.json`.
- Rendered-text prose scan: `…/scratchpad/prose-strings.txt` (402 distinct strings the
  app actually renders, including `title`/`aria-label`/`placeholder`) and
  `prose-findings.txt`.
- The walkers: `…/scratchpad/sweep.mjs`, `prose-scan.mjs`, `q5.mjs`.
- Server log: `…/scratchpad/server-8191.log` (port 8191, database
  `life_manager_verify`).
