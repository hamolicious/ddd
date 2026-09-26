# Plugin review guide

A walk through every plugin in the base distribution, one at a time, so each can be
ticked off once it has been audited. Work top to bottom: each plugin builds on the ones
above it, so a problem found low in the list often explains one found higher up.

**How to use it.** For each plugin, read *What it does*, open it where *Where to see it*
says, run the **common checks** below, then the plugin's own checks. Tick a box when it
passes; write anything that needs changing under *Notes*. When every box in a section is
ticked, tick the plugin in the **Progress** table. A plugin that gets changed during the
review is re-checked after the change, not before.

To see the app: `mise run dev-hot` and open <http://localhost:8080>. For phone width use the
browser's device toolbar at 390 × 844, and 844 × 390 for landscape.

## Progress

| # | Plugin | Reviewed | Notes |
|---|---|---|---|
| 1 | `shell-ui` | [x] | Top bar split out to `header`; ☰ became a seat item |
| 2 | `router` | [x] | No changes |
| 3 | `header` | [x] | Seats; Settings → Top bar reorder and hide |
| 4 | `notices` | [x] | Split out of `header`; bell restyled |
| 5 | `sync-status` | [x] | Split out of `header`; icon-only dot, ✕ / ↻ when down |
| 6 | `commands` | [x] | Palette Escape, footer, bar button, list indent |
| 7 | `context-menu` | [ ] | New: one menu / sheet service for every plugin. Deferred — reviewed last |
| 8 | `settings` | [x] | Base sections first, extensions below a divider |
| 9 | `themes` | [x] | No changes |
| 10 | `doc-list` | [x] | Icon sort/direction/filters, row ⋯ menu, machine filter, paging |
| 11 | `folders` | [x] | Lifted drags, folder reorder, tighter rows |
| 12 | `search` | [x] | Folded into `doc-list`: search bar, docked on phones |
| 13 | `document-surface` | [x] | Icon mode switch, phone bubble, save icon, any number of modes |
| 14 | `editor` | [x] | Icon folds that re-collapse; save state in the header; paste / drop hook; text surface |
| 15 | `attachments` | [x] | New: paste to upload, preview / link per file type, viewer registry |
| 16 | `native-preview` | [x] | New: images, PDF, audio, video, text viewers |
| 16a | `slash-commands` | [x] | New: `/` menu over any editor's `text.surface`; `/attach` |
| 17 | `markdown` | [x] | `markdown.attachment`; preview / link toggle; promote → link; document embeds |
| 18 | `viewer` | [ ] | File documents go through `markdown.attachment` |
| 19 | `admin` | [ ] | |
| 20 | `extra-task-states` (example) | [ ] | |
| 21 | `alt-editor` (example) | [ ] | |

`properties` was removed on 2026-09-26 and is not reviewed.

## Common checks (every plugin)

Run these for each plugin, in addition to its own list.

- [ ] **Looks like the rest of the app.** Same spacing, radius, borders and button style
  as its neighbours; nothing left over from before the Tailwind migration (stray bullets,
  default browser margins, unstyled buttons).
- [ ] **Phone, 390 px portrait.** Nothing runs off the right edge, the page never scrolls
  sideways, every control is at least 44 px tall.
- [ ] **Phone, 844 × 390 landscape.** Still usable; nothing that waits for hover is
  unreachable.
- [ ] **Dark theme.** Settings → Appearance → Dark: text is readable, nothing is
  hard-coded light.
- [ ] **Keyboard only.** Everything it offers can be reached with Tab / arrows / Enter,
  focus is visible, Escape closes whatever it opened.
- [ ] **Offline.** Stop the server (or cut the network) and use it: it degrades with an
  explanation rather than breaking.
- [ ] **Survives being disabled.** Admin → Plugins, disable it, reload: the rest of the
  app still works and says what is missing. Re-enable it afterwards.
- [ ] **Its commands work** from the palette (Mod+K), and its shortcuts do what they say.

---

## 1. `shell-ui` — the layout

**What it does.** The frame everything renders into: a spot for the top bar, the
sidebar of panels, the main area, and always-mounted overlays (the command palette). At
640 px or narrower the sidebar becomes a slide-over drawer. It also contributes the ☰
sidebar toggle to the top bar.

**Where to see it.** Every screen.

- [x] Skip link: press Tab on a fresh page; "Skip to content" appears and jumps to the
  main area.
- [x] Sidebar: ☰ hides and shows it; dragging its edge resizes it; arrow keys on the edge
  resize, Home resets; the width is remembered after a reload.
- [x] Panels: each sidebar panel collapses and expands, and remembers it.
- [x] Phone: the sidebar is a drawer; tapping the dimmed area or Escape closes it, and
  focus goes back to ☰.
- [x] "Nothing open" / "That view is not available" messages read sensibly.

**Notes.** Top bar moved out to `header` (2026-09-26); ☰ is now a seat item.

## 2. `router` — URLs to views

**What it does.** Maps the part of the URL after `#` to the view shown in the main area,
so the Android app works from a local file. Shows "Nothing here" for an unknown URL, and
provides the `Link` component that bolds links to the current page.

**Where to see it.** The address bar; `#/nonsense` for the not-found page.

- [x] Back and forward move between views as expected.
- [x] `#/nonsense` shows "Nothing here" with a way back to the start.
- [x] Links to the current page are bold (sidebar views, folder tree).

**Notes.** No changes.

## 3. `header` — the top bar

**What it does.** The top bar, with two seats (left `start`, right `end`) that other
plugins fill. It draws nothing of its own. Settings → Top bar lets each user reorder
items, move them between seats, and hide them.

**Where to see it.** The bar; Settings → Top bar.

- [x] Every item is in the seat and order Settings → Top bar shows.
- [x] ↑ / ↓ reorder, "To start" / "To end" move, Hide / Show toggle, Reset restores;
  changes appear instantly and survive a reload.
- [x] One row at every width, including 390 px.

**Notes.** Built during the review (2026-09-26).

## 4. `notices` — the notice bell

**What it does.** A bell in the right seat with a count badge, opening a list of kernel
notices (a plugin that failed to load, an update ready). It is the only place notices
show while the app is running, so hiding it hides them.

**Where to see it.** Break a plugin (Admin → Plugins, or a bad install) to raise a notice.

- [x] Badge colour follows the worst notice: red for errors, amber for warnings.
- [x] The panel opens on click, closes on Escape and on a click outside.
- [x] On a phone the panel spans the screen width and clears the gesture bar.
- [x] Notice actions (e.g. Reload) work; Details expand.

**Notes.** Split out of `header` and restyled (2026-09-26).

## 5. `sync-status` — the sync pill

**What it does.** A coloured dot in the right seat: green synced, accent while syncing,
amber / red when something is wrong. An "n unsynced" chip appears while edits are
waiting. When the connection is down the dot becomes a red button, ✕ while offline and ↻
after a sync error, and clicking it reconnects. An expired session shows "Sign in".

**Where to see it.** The right end of the bar; stop the server to see it go down.

- [x] Hovering the dot gives the full sentence.
- [x] Stop the server: after a moment the ✕ appears and stays (no blinking); start the
  server and click it: back to green.
- [x] Edit offline: the unsynced count appears, and clears once back online.
- [x] Same width as the dot in every state.

**Notes.** Split out of `header`; icon-only (2026-09-26). "Sign in" is still a text button.

## 6. `commands` — actions and shortcuts

**What it does.** The list of every command other plugins register, the palette that
searches and runs them (Mod+K), and per-user keyboard shortcuts with conflict reporting
(Settings → Keybindings). Shortcuts without a modifier do not fire while typing.

**Where to see it.** Mod+K anywhere; Settings → Keybindings.

- [x] Mod+K opens the palette; Escape closes it, even after clicking inside it.
- [x] Typing filters; ↑ / ↓ / Home / End move; Enter runs; results are grouped by category.
- [x] Each command's shortcut is shown beside it.
- [x] On a phone the palette is a bottom sheet that fits above the keyboard.
- [x] Settings → Keybindings: Change captures the next key combination; Backspace
  unbinds; Esc cancels; Reset restores the default; "changed" badge appears.
- [x] A clash between two commands is listed under Conflicts with who won.
- [x] Rebinding survives a reload and works straight away.

**Notes.** Top-bar button removed; palette moved to a `shell.overlay`; count footer
removed; the result list's 40 px left indent (lost in the migration) removed
(2026-09-26).

## 7. `context-menu` — menus and sheets

**What it does.** One service every plugin uses to show a menu or a sheet: a list of
actions (in titled sections, choices marked ✓), or a body the plugin draws itself. With
the button that opened it on a wide screen it is a popover under that button; on a
phone, or with no button, it is a bottom sheet (a centred dialog above phone width). It
renders from `shell-ui`'s overlay spot. Split out of `folders` on 2026-09-26; `folders`
and `doc-list` use it.

**Where to see it.** Any ⋯ button (document rows, folder rows); the document list's sort
icon; a folder's Move to… picker.

- [ ] A popover sits under its button, right-aligned, and stays on screen near the edges.
- [ ] Phone: the same menus are bottom sheets with a title and ✕.
- [ ] Arrows, Home / End move between items; Tab stays inside; Escape and a click outside
  close it; focus returns to the button that opened it.
- [ ] Choice menus (sort) mark the current choice and open with focus on it.
- [ ] Danger items (Move to Trash, Delete folder) are red.

**Notes.**

## 8. `settings` — the settings screen

**What it does.** The Settings view: a list of sections contributed by other plugins,
plus its own Account section (sign out). On a phone the list and the section take turns
on screen.

**Where to see it.** The ⚙ button, Mod+,, or `#/settings`.

- [x] Every section opens, and the URL names it (`#/settings/<id>`).
- [x] Phone: the list is full width; opening a section fills the screen; "All settings"
  goes back.
- [x] Account: sign out warns when there are unsynced edits.
- [x] Sections from base plugins come first; an extension's sections sit below a divider.

**Notes.** Base / extension grouping added (2026-09-26).

## 9. `themes` — appearance

**What it does.** Theme registry and picker (Settings → Appearance). Themes override the
kernel's colour and spacing tokens; light / dark can follow the system.

**Where to see it.** Settings → Appearance; the "Change theme" and "Toggle light / dark
appearance" commands.

- [x] Each theme applies instantly across every screen and survives a reload.
- [x] "System" follows the OS light / dark setting.
- [x] The toggle command flips light / dark.

**Notes.** No changes.

## 10. `doc-list` — documents and Trash

**What it does.** The start page: every document, sortable and filterable, with saved
views in the sidebar's Views panel. The top row is three icons — sort (a menu of
fields), direction (flips the order) and filters (a funnel that unfolds the filters, its
badge counting those applied). Each row has a ⋯ menu with Open and Move to Trash. Also
the Trash view (restore within 30 days) and the "New document" command.

**Where to see it.** `#/`, `#/trash`, the Views panel. Mod+N for a new document.

- [ ] Sort icon: each field sorts the list; direction icon flips it and says which way.
- [ ] Funnel: unfolds the filters; filters narrow the list; the badge counts them, "Show
  machine documents" included; Clear resets all of them.
- [ ] Views panel: switching views changes the list; the current one is highlighted; no
  bullets.
- [ ] Mod+N creates a document and opens it.
- [ ] Row ⋯ → Move to Trash, then restore from `#/trash`.
- [ ] Paging: with more than 50 documents the list shows 50 and "Showing 50 of N";
  scrolling near the end loads the next page; "Load N more" works by keyboard; changing
  the sort or a filter starts again from one page. Trash pages the same way.

**Notes.** Views list bullets fixed; the list header's "New document" button removed —
Mod+N and the palette create documents, and an empty workspace still offers "Create
the first document" (2026-09-26). Sort and direction became icons, the sort field a
`context-menu` popover; "Filters" became a funnel icon with a count badge; "Show machine
documents" is a filter (counted, cleared by Clear); each row's Move to Trash button
became a ⋯ menu (2026-09-26). Paged, 50 at a time, replacing the hard 200-row cap; the
local engine's full-store scan behind it is POLISH-BACKLOG item 12 (2026-09-26).

## 11. `folders` — the folder tree

**What it does.** A tree in the sidebar built from each document's `path:`; documents
with no path sit at the root. Moving a document or a folder rewrites only the `path:`
line. Every row has a ⋯ menu (also long-press or right-click) with new document, new
folder, rename, move and delete. Settings → Folders sets where new notes go.

**Where to see it.** The Folders panel; `#/folder`.

- [ ] Drag a document onto a folder, and onto the root strip; the tree updates. The
  dragged row lifts (a solid, shadowed copy under the pointer; a faded slot behind).
- [ ] Drag a folder onto the top or bottom edge of another: a line shows where it goes,
  and it lands before / after it (into that folder's parent if different). The order
  survives a reload. The middle of a folder still means "inside".
- [ ] ⋯ menu: every action works; rename is inline, never a browser prompt.
- [ ] Keyboard: arrows move, Enter opens, F2 renames, M moves, Delete deletes a folder.
- [ ] Landscape phone: the ⋯ buttons are visible without hover.
- [ ] Settings → Folders: "New notes go to" is honoured by Mod+N.

**Notes.** The ⋯ menus, delete confirmation and Move to… picker now open through
`context-menu` rather than the tree's own sheet (2026-09-26). Drags are pointer-driven
with a lifted copy instead of the browser's translucent ghost; folders can be reordered
(per-user `folderOrder` setting); desktop rows tightened to ~24 px (folder names no
longer take the app's button tap height); on a phone the chevron sits beside its name,
its 44 px tap area reaching into the indent (2026-09-26).

## 12. `search` — now part of `doc-list`

**What it does.** Search is the document list's search bar, not a plugin or a page of
its own. It runs every `search.provider` (now defined by `doc-list`): the local index,
which works offline, and the server's. The list becomes the ranked results. It is still
filtered like the list, and each result shows the line that matched.

**Where to see it.** The search bar on `#/`. Ctrl+Space (or the "Search documents"
command) opens the list and focuses it. The URL keeps the text (`#/?q=milk`), and the
old `#/search?q=` address opens the same list.

- [ ] Body text and titles both match; a result opens at the matching line.
- [ ] Sort switches to "Best match" when a search starts and back when it is cleared.
- [ ] Filters (machine documents included) apply to results.
- [ ] Offline: search still finds documents already synced; the note says some results
  need a connection.
- [ ] Phone: the toolbar card is docked at the bottom; focusing search slides the three
  icons away and blurring brings them back; the filters open upwards over the results.
- [ ] Desktop: the search bar is at the top, the icons to its right, and the filters
  start folded.

**Notes.** The top-bar search box was removed (2026-09-26). Search was folded into
`doc-list`, its page removed, "Title contains" replaced by the search bar, the
default key moved from Mod+Shift+F to Ctrl+Space, and the filters start folded on a
wide screen too (2026-09-26). The per-source counts ("Where these came from") went with
the page. The list only shows documents already on this device, so a result found only
by the server, before it has synced, does not appear.

## 13. `document-surface` — opening a document

**What it does.** Owns the `#/doc/<id>` page. It loads the document, shows its title,
the save state and the mode switch, and hands the document to the active mode. Any
number of modes can register (`document.mode`), and each mode's own `when` decides
which documents it is offered on. Mod+E cycles modes.

**Where to see it.** Open any document.

- [ ] Desktop: the title is on the left; on the right are the save icon and one icon
  per mode (book = Read, pencil = Edit), in a short segmented control. Each icon's
  tooltip is the mode's name.
- [ ] Phone: the header is the title and the save icon. A round button bottom-right
  shows the mode it switches to. With three or more modes it fans out the choices.
- [ ] Save icon: a cloud with a tick when saved. It pulses while saving or
  reconnecting and is crossed out offline; hover for the words.
- [ ] Mod+E switches modes; the choice is kept per document.
- [ ] Its settings section shows how many modes are remembered and can forget them.
- [ ] A missing document shows "Document not found"; a trashed one shows the Trash banner.

**Notes.** Read/Edit became icons, and the header became shorter (2026-09-26). The phone
got the floating mode button. The editor's "Saved" strip moved into this header as an
icon, shown in every mode. A new example, `plugins/examples/source-view`, is a third
mode offered only on documents with frontmatter or machine sections. It is tested by
`web/app/e2e/modes.spec.ts`.

## 14. `editor` — Edit mode

**What it does.** CodeMirror bound to the live document, so edits sync as you type. Shows
frontmatter as raw text, can fold machine-written sections, and warns when the
frontmatter could not be read.

**Where to see it.** Any document → Edit.

- [x] Typing is saved and appears in a second browser within a second or two.
- [x] Machine sections fold and unfold: the chevron at the end of the `%%% id` line
  opens one and folds it back; the palette's "Collapse / Show machine sections" does all.
- [x] Broken frontmatter shows the "could not be read" notice.
- [x] Phone: the editor scrolls inside itself; the keyboard does not cover the cursor.
- [x] Pasting plain text with `attachments` disabled pastes as before.
- [x] Dragging a selection within the editor still moves the text.

**Notes.** The "Saved" strip under the editor moved to the document header as an icon
(2026-09-26). A folded `%%%` section is now a chevron icon with no text. Once opened,
it shows a chevron in the same place that folds it again (2026-09-26). New
`editor.paste` point: handlers see a paste or a drop (files and text) before
CodeMirror, and the text they insert is followed through later edits, so an upload
that finishes later can swap its placeholder. A drop inserts where it was dropped. It
also publishes a `text.surface` for `slash-commands` (2026-09-26).

## 15. `attachments` — pasting and showing files

**What it does.** Pasting or dropping a file into Edit mode uploads it: an "Uploading name…"
placeholder holds its place, then becomes `![name](attachment://…)` (preview) or
`[name](attachment://…)` (link), per file type. It also owns the `attachments.viewer`
registry and renders every embedded file through the viewer for its type; when several
viewers claim a type, the user picks one. It depends on no plugin.

**Where to see it.** Paste a screenshot or a copied file into a document in Edit mode;
Settings → Attachments.

- [x] Paste a screenshot: the placeholder appears at the cursor and becomes an image
  embed; Read mode shows the image.
- [x] Paste two files at once: both land, one per line, in order.
- [x] Drag a file from the desktop onto a line: it lands where it was dropped.
- [x] Paste a PDF: it is a link by default; switch `.pdf` to Preview and paste again: it
  shows inline.
- [x] Paste a type never seen before (`.heic`, say): it appears in Settings → Attachments.
- [x] Switch to Read before a large upload finishes: the result still lands in place.
- [x] Delete the placeholder mid-upload: nothing is put back, a notice says so.
- [x] Offline paste: the placeholder goes, an error notice says it could not upload.
- [x] Settings: Preview / Link per type saves and survives a reload; "Shown with" only
  appears when two viewers claim a type.
- [x] Disable it: embeds render the way `markdown` draws them (image or chip).

**Notes.** New (2026-09-26).

## 16. `native-preview` — browser viewers

**What it does.** Viewers for every type a browser shows by itself: images, video,
audio, PDF (the browser's own viewer in a frame) and plain text (the first 256 KB). Not
SVG or HTML. All at the default order, so another plugin can take a type over.

**Where to see it.** Any embedded file in Read mode; a file document (wrapper).

- [x] Image, video, audio, PDF and text each show inline and full-page.
- [x] A video in a codec the browser lacks says "cannot play", not a broken player.
- [x] Android app: a PDF says "cannot show" rather than an empty frame.
- [x] Phone: nothing is wider than the column; a PDF frame scrolls inside itself.
- [x] Disable it: every type shows as `markdown`'s chip / image again.

**Notes.** New (2026-09-26). PDFs needed `frame-src 'self' blob:` added to the app's
CSP (`statics.rs`, `shell.rs`).

## 16a. `slash-commands` — the `/` menu

**What it does.** Typing `/` at the start of a word in an editor opens a dropdown of
actions (`slash.command`), narrowed as you type. It works over any editor that publishes
a `text.surface` — `editor` and the `alt-editor` example both do — and draws from
`shell-ui`'s overlay spot. `attachments` adds `/attach`.

**Where to see it.** Edit mode, type `/`.

- [x] `/` at a line start or after a space opens it; `a/b` and URLs do not.
- [x] Typing narrows; ↑ / ↓ move, Enter or Tab choose, Escape shuts it until the text
  changes; a click or tap chooses without losing the editor's focus.
- [x] `/attach` opens the device's file picker; chosen files land where `/attach` was
  typed; cancelling leaves the text as it was, minus the `/attach`.
- [x] Phone: the menu fits the width and sits above the caret when the keyboard is up.
- [x] Android app: the file picker opens (needs the shell's file chooser).
- [x] With `alt-editor` as Edit mode, the same menu works in the textarea.
- [x] Disable it: `/` is just a character.

**Notes.** New (2026-09-26). `alt-editor` declares the surface locally, as a
third-party editor would.

## 17. `markdown` — rendering markdown

**What it does.** Turns markdown into what Read mode shows: headings, lists, tables,
code, links between documents (`doc://`), attachments, and task checkboxes with a state
menu. Other plugins extend it (custom task markers, directives, code-fence renderers).

**Where to see it.** A document with a bit of everything, in Read mode.

- [x] Tables and code blocks scroll inside themselves on a phone.
- [x] An embedded file's menu (right-click / long-press) says "Show as link" on a
  preview and "Show as preview" on a link; each adds or removes the `!`.
- [x] "Promote to document" (menu or palette) creates the file's document, opens it,
  and replaces the embed with a `[name](doc://…)` link to it.
- [x] `![](doc://…)` shows that document's body in a framed block, titled with a link
  to it; an edit there shows here live; its checkboxes tick the embedded document.
- [x] Embeds nest up to Settings → Markdown's depth (default 4; 0 = links only); a
  document already shown above (including itself) is a link.
- [x] Clicking a task toggles it; long-press / right-click opens the state menu.
- [x] `doc://` links open the target; a missing target is marked.
- [x] Attachments preview; "Promote attachment to document" works.

**Notes.** Embeds (`![…](attachment://…)`) go through the new `markdown.attachment`
point when something contributes to it (`attachments`), with markdown's own image /
chip as the fallback; `MarkdownApi.renderAttachment` exposes the same to `viewer`. The
file menu toggles preview / link, and promoting now swaps the embed for a link to the
new document; both are guarded splices that write nothing if the text moved on.
`![](doc://…)` embeds documents recursively, with a Settings → Markdown section for the
depth (2026-09-26).

## 18. `viewer` — Read mode

**What it does.** The Read mode: the rendered body, with a properties header above it
showing the frontmatter (dates formatted, lists as chips) and machine sections hidden.
Display only; editing happens in Edit mode.

**Where to see it.** Any document → Read.

- [ ] The properties header shows every key; empty ones are greyed, not dropped.
- [ ] Broken frontmatter: the header says which lines could not be read.
- [ ] The text column holds its width on a phone; nothing overflows.

**Notes.** The properties panel it referred readers to was removed (2026-09-26). A
file document's preview goes through `markdown.renderAttachment` first, its own
preview being the fallback (2026-09-26).

## 19. `admin` — administration

**What it does.** Users, invites, the audit log, orphan files, snapshots, the plugin list
(enable, disable, capabilities, configuration, cron), and a markdown export. Admins only.

**Where to see it.** The 🛡 button or `#/admin`; its sections also appear in Settings.

- [ ] Every section loads; tables fit or scroll inside themselves at 390 px.
- [ ] Create an invite; a second browser can register with it.
- [ ] Plugins: disable / enable one; capability approvals and plugin config save.
- [ ] Plugin event log: warnings and errors are marked on the left edge.
- [ ] Export produces a markdown archive.

**Notes.** Styles lost in the migration restored (2026-09-26).

## 20. `extra-task-states` (example)

**What it does.** Proves plugins can extend markdown: adds three task markers, `[/]` in
progress, `[-]` dropped, `[?]` question.

- [ ] Each marker renders distinctly and is offered in the task state menu.

**Notes.**

## 21. `alt-editor` (example)

**What it does.** Proves the built-in editor is replaceable: a plain textarea Edit mode
bound to the same live document.

- [ ] With it enabled and `editor` disabled, Edit mode is the textarea and edits sync.
- [ ] Read-only with an explanation when the document could not be loaded.

**Notes.**
