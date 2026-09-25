# Polish backlog

> **Owner-queued (scripted as the `core-improvements` workflow, ran after the mobile/prose
> wave) — done, 2026-09-25.** Task-list left alignment; frontmatter unfolded in edit mode +
> pretty properties header in read mode; folders as a real drag-and-drop file tree (pathless
> notes at root, empty-folder bookkeeping via settings, inline rename, delete with
> move-or-trash choice); a settings entry for where new notes go (root by default); a
> settings entry for the default document mode when opening (Read / Edit, read by default).
> That wave closed items 1–4 below; see [Closed](#closed) for each one's outcome, and
> `web/CONTRACTS.md`'s "Core-improvements pass" for what it cost.

**Item numbers are stable.** Several source comments cite an item by number
(`folders/src/FolderTree.tsx` §3 and §4, `editor/src/index.tsx` item 2), so a closed item
keeps its number in the Closed table and the ones above it are *not* renumbered. A gap in
the list is an item that was fixed, not a mistake.

What UX sweeps of the core flows found and **did not** fix, with enough to reproduce each
one. Everything here was seen in a running build — the real server, the real bundle, the
real plugin registry — at 1280 px and at 390 px, after the calendar and agenda removal.

**The bar used.** Fixed in a sweep means: small, inside a base plugin or the kernel's own
stylesheet, no redesign, no frozen contract touched, and covered by a test. Everything
that needs a server endpoint, a new `@kernel` surface, a design decision about what the
product *is*, or another builder's file lands here instead.

**Curated 2026-09-25 (integration pass).** Items are ordered by value — roughly, how often
a user hits it multiplied by how stuck they are when they do. Everything that has since
been fixed or proved non-reproducible has been moved out of the list into
[Closed](#closed), one line each, so this file is the open work and the record is still
here for anyone who wonders whether it was looked at. Every open item below was
re-verified against the tree at this revision, not carried over on trust.

---

## 5. A document has no delete, and no way back to where you came from

**Repro.** Open `#/doc/<id>` in a fresh tab. You can read and edit it; you cannot trash it
(that action exists only on a `doc-list` row) and there is no "back to documents" control.
The sidebar's "All documents" and the browser's back button are the only exits, and on a
phone the sidebar is a drawer you have to open first. The document header holds a title and
the mode tablist, nothing else (`document-surface/src/index.tsx`, `docsurface-header`).

A `document.delete` command plus a breadcrumb in `docsurface-header` would cover it. Both
are additions rather than corrections, and the header is a layout other people contribute
into.

## 6. The notice bell opens itself, and there is no "dismiss all"

The duplicate strip is **gone** (see Closed). What remains was seen at 390 px:

- The bell's popover **opens by itself** when a notice arrives and covers roughly a third
  of the screen, including the page heading underneath it. Dismissing means finding the
  bell again; the popover has no close control of its own.
- A workspace with three notices still has no single dismiss.

Note for whoever takes it: if the full-width strip is ever brought back as anything but the
no-mount fallback, it sits outside `.shell-root` and pushes the whole shell down by its own
height — on a phone that is about a navbar's worth of space.

## 7. An invite is a bare token with no link

**Repro.** Admin → Invites → Create invite. The token is shown once with a Copy button —
correctly, since only its hash is stored — but the recipient gets a 43-character string and
no indication of what to do with it. They have to be told separately to open the app, press
"I have an invite", and paste. `Users.tsx` renders `<code>{created.token}</code>` and a copy
button, and builds no URL.

A registration URL (`<origin>/#/register?invite=<token>`) that the auth gate reads would
make this self-explanatory. It needs a route on the gate, which is kernel-owned
(`web/app/src/boot/AuthGate.tsx`), not a plugin.

## 8. Trash has no "delete permanently" and no "empty Trash"

**Repro.** Delete a document, open Trash: the only action is "Restore". A tombstone purges
on the server's 30-day schedule (SPEC §3.5) and there is no way to say "now".

There is no endpoint for it — `DELETE /api/documents/:id` tombstones, and purge is a
background job. A UI fix would be fiction. If this is wanted it starts in
`backend/crates/server/src/routes/documents.rs` with an admin-or-owner purge route, with
the graveyard rules (SPEC §3.5: the id stays forever) unchanged.

## 9. A list-valued property is shown twice

**Repro.** Open any welcome document and look at `tags` in the properties panel: the value
appears as removable chips *and* again in a comma-separated text field.

This is deliberate and documented in `ListValueEditor` — the field is the editable form
(the document holds a YAML flow sequence), the chips are how you remove one item without
retyping the rest — and in a narrow sidebar it still reads as a bug. The fix is one
tokenised input that supports both, which is a component, not a CSS change.

## 10. The registration form offers no display name

A preference, not a defect, and recorded at this size deliberately — see Closed for the
larger claim this was cut down from. The gate offers no way to *choose* a display name, so
everyone is stuck with their email's local part until someone adds a field.
`POST /api/auth/register` already accepts `name`.

## 11. Two people setting the same frontmatter key at once get a value neither typed

**Repro** (two browsers, one document filed at `home/lists`). A drags it to `archive`;
B drags it to `inbox` before A's update arrives. Both replicas converge on
`path: archiveinbox` — a valid path neither user chose — and both progress rows say the
move succeeded. Drag a *folder* and it happens once per document inside it
(`folders/src/index.tsx`, `planFolderMove` → `pool`).

**Why.** `setFrontmatterValue` replaces the key's **value span**, which is what SPEC §3.3
mandates for human-owned frontmatter: it is the only write that keeps a trailing comment,
the key's position and the rest of the block byte-identical. Under concurrency the two
replicas delete the same span and insert at the same origin, so both inserts survive
*inside one line* and concatenate. A `%%%` section write does not have this problem
because it replaces the key's whole **line**: two lines survive, and the parser's
last-occurrence-wins rule (SPEC §3.3, §3.4) picks one of the two values a user actually
asked for. Both behaviours are now pinned by
`web/kernel/src/runtime/splice.test.ts` → "concurrent writes to one key", which is where
this was verified rather than argued about.

**Why it is not fixed in `folders`.** Every plugin-level workaround is worse than the
bug. Writing `path` as a line (remove-then-set through the two public helpers) merges
correctly — the test above asserts that too — but re-inserts the key at the block's
insert point, so a `path` that sat above `title` moves below it: exactly the reformatting
§3.3 forbids, and exactly what `app/e2e/journeys.spec.ts` compares byte for byte. There
is no pure removal planner in the frozen `@kernel` contract, so the two cannot be fused
into one transaction either, and a plugin computing its own line spans would be
reimplementing `core::splice` outside the kernel helper.

**Where the fix is.** `core::splice::set_frontmatter_value` replacing the key's line
**in place** (delete the line span, insert the new line at its start) rather than its
value span: same resulting text for a lone writer, key position preserved, duplicate
lines under concurrency. That is Rust and the TypeScript port changed together,
`backend/crates/core/corpus/splices.json` regenerated (`replaced` and `edits` change for
every `set_fm` case), and SPEC §3.3's "replace only the affected key's value span"
reworded — plus a decision about the trailing comment on that line, which the value-span
write already clobbers but which a line write clobbers more visibly. Cross-area, and a
SPEC edit: it is not a sweep.

---

## Minor, for whenever someone is already in the file

- `TRASH_LIMIT` in `doc-list/src/DocListView.tsx` is still 1 000. It was generous *because*
  the ordering used to be correct only over the rows it held; now that Trash sorts through
  the query it can go back to a normal page size. Costs nothing where it is.
- `%%% calendar` survives as an arbitrary section-id string in fixtures, corpus rows and
  ABI examples, and `plugin:calendar` as the canonical "a plugin that crons a feed" idiom
  in protocol docs. This is deliberate (see `backend/CONTRACTS.md`); the parser does not
  know what a plugin is, and churning the conformance corpus would buy nothing. Named here
  only so nobody re-discovers it as a loose end.

---

## Closed

Kept as one line each, because "we looked and it was fine" is worth as much to the next
reader as the open items.

| Was | Outcome |
|---|---|
| **Item 1** — Creating a document drops you into read mode on an empty page | **Closed with a user-level opt-out**, which is as far as it can go without a route-contract decision. `document-surface` now renders its own `settings.section` ("Documents" → "Open documents in"), so a workspace that wants to land in Edit says so once. The options come from the `document.mode` registry rather than being spelled, so SPEC §6.5's symmetry — and M3's acceptance test — still hold. `?mode=<id>` on the route is still the real fix and is still a design call. |
| **Item 2** — Two base plugins declare user settings that no screen renders | **Fixed, one by rendering and one by removal.** `document-surface` contributes the section above (without declaring a `settings` dependency — contributions to undefined points buffer). `editor`'s `foldFrontmatter` was **deleted along with the behaviour**: frontmatter is now absent from the fold service's answer entirely, so there is no gutter arrow, no `foldEffect` target and nothing `foldAll` can collapse — a preference whose only honest value was `false` is not worth a screen. |
| **Item 3** — A document can only be moved between folders by dragging | **Fixed.** Long-press (500 ms), right-click, the row's `⋯`, or `M` opens a portalled sheet with Move to…, New document/folder here, Rename and Delete; the picker always offers Root first. Portalled because `shell-ui`'s sidebar declares `container-type: inline-size`, which traps a `position: fixed` panel. Covered at 390 px by `web/app/e2e/zz-folder-tree.spec.ts`. |
| **Item 4** — Folder rename is a `window.prompt` | **Fixed.** Rename is an inline field in the row (Enter/✓ commit, Escape/✕ cancel; blur does neither, because a rename can splice hundreds of documents and a stray click is not consent). `globalThis.prompt` is gone from the plugin, which also removes the untested `onJsPrompt` dependency inside the Flutter shell rather than documenting it. The e2e spec fails the run if *any* native dialog opens, so this cannot quietly come back. |
| Trash's ordering caveat will go stale the moment `deleted_at` lands | **Done.** `deleted_at` is a fixed root of the shared DSL, `TrashView` sorts through the query, the client-side re-sort and the "sorted on this device" paragraph are gone, corpus parity passes. |
| Wide tables scroll the view, not themselves, on a phone | **Not reproducible.** Re-measured at 390 px across all thirteen routes: `scrollWidth === clientWidth` on both the page and `.shell-main`. The keybindings table fits at 380 px. The `min-width: 0` fix on the settings pane is what let it wrap. |
| `.cmd-category` contributes no space to the accessibility tree | **Fixed** (second pass). It affected the palette *and* the settings keybindings table — same markup — which is what moved it over the bar. |
| Notices appear twice | **Fixed** elsewhere in the same pass. `AppFrame` draws the strip only when nothing holds the mount or the holder threw; `shell-ui`'s bell is the sole renderer otherwise. The two sub-problems that survive are open item 6. |
| The registration form never asks for a name | **Mis-diagnosed.** The stated symptom was false: `routes/auth.rs` has always fallen back to the email's local part, with a unit test, so nothing is blank. Reduced to open item 10. |
| `FolderTree.tsx` promises a "Move to…" row prompt that does not exist | **Fixed** (integration pass). The comment now describes the two paths that exist and points at open item 3. |

---

## Fixed in the sweeps

For the record, and so nothing here is looked for twice. Each has a test unless marked.

### First pass (2026-09-24)

| What was wrong | Where | Covered by |
|---|---|---|
| The navbar ran past a 390 px viewport, scrolling the whole page sideways, and squeezed "New document" and the search box to zero width | `shell-ui` (two-row nav, sync label, `data-kind` on nav items), `commands` (the `Ctrl+K` hint), `admin` (an icon so the label can collapse), `search` (flex basis) | `app/e2e/polish.spec.ts` |
| The settings section list grew to 1 700 px as a grid item and its own `overflow-x` never fired | `settings` (`min-width: 0`) | `app/e2e/polish.spec.ts` |
| A folded **frontmatter** block was labelled "⋯ machine data" — wrong, and contradicted by the plugin's own setting text | `editor` (`preparePlaceholder`/`placeholderDOM`; sections now name their plugin id) | `app/e2e/polish.spec.ts` |
| Trash attributed a deletion to a raw 26-character ULID | `doc-list` (`by you` / `by another user`, id on hover) | `app/e2e/polish.spec.ts` |
| "Show document as: Read/Edit" sat in the palette from every view and did nothing off a document route | `document-surface` (`when` also requires a document) | `app/e2e/polish.spec.ts` |
| The unfiltered palette interleaved the categories its own rows are labelled with | `commands` (tie-break on category, then title) | `app/e2e/polish.spec.ts`, `commands/src/match.test.ts` |
| The properties panel wrapped each row's "remove" button onto a line of its own, orphaned under the control | `properties` (flex basis) | — (visual) |
| The properties panel's `@container` rules could never fire, because nothing declared a container | `shell-ui` (`container-type: inline-size` on the sidebar) | — (visual) |
| `.cmd-trigger span { display: none }` matched nothing: the trigger's label is a text node and its hint is a `<kbd>` | `commands` | `app/e2e/polish.spec.ts` |
| End-user copy referenced source files and spec sections — "see `filter.ts`" in Trash, "SPEC §4.2" in the filter bar | `doc-list` | — (copy) |
| The folder hint offered only `F2`, though a visible rename button exists and F2 does not, on a phone | `folders` | — (copy) |

### Second pass (2026-09-25)

| What was wrong | Where | Covered by |
|---|---|---|
| The task-state menu took focus and never gave it back: Escape (and choosing a state) left `document.activeElement` on `<body>`, dumping a keyboard user at the top of the document. A right-click does not focus its target, so the element to return to could not be read from `activeElement` and had to come from the menu's own position in the DOM | `markdown` (`PopupMenu` remembers its trigger at mount and restores on the two *deliberate* dismissals only — never on outside-click, which would fight the pointer) | `app/e2e/polish.spec.ts` (both directions) |
| The folder tree's row actions were unreachable by keyboard: `tabindex="-1"` like everything in a roving-tabindex tree, and `display: none` until the row was active. Rename had F2 as a fallback; **"new document in this folder" had no keyboard path at all** | `folders` (the active row's two actions become a tab stop; `:focus-within` keeps the group visible while they hold focus) | `app/e2e/polish.spec.ts` |
| `.cmd-category`'s separator gap was `margin-right`, which the accessibility tree cannot see — every palette row *and* every keybindings row announced as one word, "Admin ›Browse snapshots" | `commands` (`content: " › "`, margin reduced so the visual gap is unchanged) | `app/e2e/polish.spec.ts` (asserts the **accessible name**, since `innerText` omits generated content) |
| Two more end-user strings citing the spec at the reader — the folder contents filter disclosure still said "SPEC §4.2", and admin's users note said "(SPEC §5.4)" | `folders`, `admin` | — (copy) |

### Core-improvements wave (2026-09-25)

Larger than a sweep — three owners' worth of work against the owner's own three asks — so
the detail lives in `web/CONTRACTS.md`. What was *found* on the way is here, because each
one was a surface that passed every existing assertion while rendering something else.

| What was wrong | Where | Covered by |
|---|---|---|
| Task lists were indented **twice**: a list's marker gutter was `calc(--lm-space * 3)` in two rules and `--lm-tap-target` in a third, so a task's text sat 50 px from the body margin against a bullet's 24, and nesting stepped 50 against 24. The `li` edge was already flush, which is why nothing caught it | `markdown` (one `--md-gutter` token; the 44 px target **overhangs** its column instead of widening it) | `app/e2e/list-alignment.spec.ts` (measured edges, at 1280 px and 390 px) |
| The "Filters" badge counted a whitespace-only title box as an applied filter, **Clear** silently unticked "Show machine documents", and an unusable condition was marked "Incomplete" over rows that were entirely filled in and refused for a *type* reason | `doc-list` (`appliedCount()`; `clauseProblem()` returns the reason and `invalidClauses` is derived from it, so the mark and the query are one decision) | `doc-list/src/filter.test.ts` (incl. a ~3 000-row matrix pinning `clauseProblem(c) === undefined ⟺ buildClause(c) !== undefined`), `app/e2e/list-alignment.spec.ts` |
| A date-only frontmatter value rendered a day early west of Greenwich (`new Date("2026-09-23")` is UTC midnight), and an impossible date like `2026-02-30` was printed as "2 Mar 2026" — a day the document does not contain | `_shared/fm-display.ts` (components read into a *local* `Date`; validity checked before formatting) | `_shared/fm-display.test.ts`, run under four time zones |
| `mobile-shell.spec.ts`'s audit test measured the "Detail" disclosures *after* filtering the log to one target id — whether that target has a detail block is an accident of which admin action sorts first, so it failed about one run in four with nothing wrong | `app/e2e/mobile-shell.spec.ts` (the two independent claims made in that order) | itself |

### Review follow-ups to the core-improvements wave (2026-09-25)

The wave's own review, applied. Two of the six were latent rather than reproducible and
are marked as such; the seventh finding is open item 11, because its fix is not in a
plugin.

| What was wrong | Where | Covered by |
|---|---|---|
| `folders` spliced `fm.path` on **any** id it was handed. Excluding machine-owned documents from the tree's `rows` protects what the tree draws and nothing else, and two entry points never consult `rows`: the `folders.moveDocument` command (an id out of the URL) and a drop (`text/plain` off a `DataTransfer` any plugin fills in). Aimed at the kernel's per-user settings document it moved it out of `.settings`, where `settingsFilter()` is looking for it — every stored setting for that user then read as its schema default, recoverable only by hand-editing `path` back | `folders` (`refuseMachineWrite` on the write path, against the document's *stored* `fm.path` rather than tree membership, so a document past `TREE_ROW_LIMIT` is still movable; the command refuses with a notice before opening a sheet; a dotted *destination* is refused too, since `.hidden` typed into an inline rename is the same hole from the other side) | `folders/src/…` + the guard's own refusals; `browsing.spec.ts` still pins the three-plugin agreement about hiding |
| The empty-folder list is one settings key, so two devices creating a folder at once wrote `emptyFolders:` concurrently and the host kept one line — the folder made on the losing device vanished from both trees with no error. The plugin's documentation called a *stale* entry the only failure mode; a dropped one is the opposite | `folders` (`mergeTracked`, plus an "unconfirmed" set that an entry leaves the first time a stored value contains it — so a lost race is merged back and a folder deleted later on another device stays deleted) | `folders/src/empty-folders.test.ts` |
| "New notes go to" handed its settings write to nobody: a failure was an unhandled rejection in the console, the picker kept showing the folder the user chose, and `doc-list` went on filing notes in the old one | `folders` (`DefaultLocation` optimistic-and-reverted with a `role="alert"`, the shape `DefaultModeSection` already used) | — (visual; the rejection path is not reachable from a passing e2e run) |
| "Open documents in" and its "N documents open the way you last left them" count were read once at mount. A second tab, a second device, or switching modes on a few documents left the select stale and the count wrong — and that count is what "Forget remembered modes" is about to clear | `document-surface` (`kernel.settings.subscribe`, skipped while a write of its own is in flight so the optimistic value still wins) | `frontmatter.spec.ts`'s "Open documents in" test still passes, which is what pins the optimistic path |
| `formatDateValue` built a local `Date` from the raw components, and `new Date(26, 0, 1)` is **1926**: `date: 0026-01-01` printed as "1 Jan 1926" — the same "a date the document does not contain" the function's own comment exists to prevent | `_shared/fm-display.ts` (`setFullYear` after construction) | `_shared/fm-display.test.ts` |
| Removing the surface-level `fm_parse_error` notice left **edit mode** with no warning at all: the read-mode header does not render there and the properties panel is a drawer that starts closed at 390 px — and edit mode is where the read-mode warning tells the reader to go | `editor` (its own `role="status"` notice, in both the hydrated and the read-only branch) | `frontmatter.spec.ts` (its `fm_parse_error` assertions run in both modes) |
| `pressHandled` had a path that set it and no path that cleared it: a long press on the blank part of a folder row opens the sheet, and the click that follows has no handler to consume it. **Latent, not reproducible** — every touch `pressStart` also resets the flag, so the next tap clears it before its own click — but the flag's lifetime depended on that rather than stating it | `folders` (the folder row consumes its own press, the way the document row already did) | — (reasoned; the tree's 390 px journeys in `zz-folder-tree.spec.ts` exercise the sheet) |


**Verified good, for the next person who wonders:** empty states for the document list,
folders and Trash (all three written, all three reachable with `SEED_WELCOME_DOCS=false`);
the admin invite flow including the shown-once token; the keybinding capture dialog
(Escape cancels, Backspace unbinds, no focus trap); search's empty result including its
"the local index may still be building" caveat; the dark theme across every view; the
drawer's Escape-and-return-focus behaviour; the auth gate at 390 px; task toggling writing
a single-character splice; the properties panel adding a typed key (`priority: 3` lands as
a number, spliced after the existing keys, rest of the block byte-identical); CodeMirror
typing syncing to the server; search typeahead, the full results view, provider attribution
and `?line=N` deep links; Trash delete → restore; theme switching; the admin users table;
and page-level horizontal overflow at 390 px across all thirteen routes.
