# Polish backlog

> **Owner-queued (scripted as the `core-improvements` workflow, runs after the mobile/prose
> wave):** task-list left alignment; frontmatter unfolded in edit mode + pretty properties
> header in read mode; folders as a real drag-and-drop file tree (pathless notes at root,
> empty-folder bookkeeping via settings, inline rename, delete with move-or-trash choice);
> a settings entry for where new notes go (root by default); a settings entry for the
> default document mode when opening (Read / Edit, read by default).

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

## 1. Creating a document drops you into read mode on an empty page

**Repro.** Click "New document" (navbar, `Mod+N`, the palette, or a folder's `+`). The
route changes to `/doc/<id>`, the title reads "Untitled", and the selected mode tab is
**Read** — so the first thing after the app's most common action is an empty page and a
tab you have to find before you can type.

**Why it was not fixed in a sweep.** The obvious fix — have `doc-list` set the mode to
`edit` after it navigates — is the one thing `document-surface` is built to prevent. SPEC
§6.5 makes `viewer` and `editor` symmetric contributions with no built-in favourite, and
that symmetry is what M3's acceptance test rests on; a `doc-list` that spells `"edit"`
makes the built-in editor special again, in a plugin that has no business knowing modes
exist. Its manifest does not even depend on `document-surface`.

**There is no user-level workaround today, and there nearly is one.**
`document-surface` already declares a per-user setting for exactly this —
`defaultMode`, labelled "Default document mode", default `read`
(`plugins/base/document-surface/src/index.tsx:141`). It works; it is simply not reachable,
because nothing renders it (item 2). Closing item 2 gives this item an opt-out that costs
no contract change at all, and is the cheapest thing to do first.

**The shape of a real fix.** A `?mode=<id>` query on the document route, resolved by
`document-surface` the way it already resolves `?line=N`, plus a `create`-time default
that `doc-list` passes as *data* rather than as a mode id it chose (e.g. the surface
treating "created this session and still empty" as a reason to prefer the first writable
mode). Either is a design call about the route contract.

## 2. Two base plugins declare user settings that no screen renders

**New in the integration pass.** `kernel.settings.defineSchema` has four callers. Two of
them — `themes` and `commands` — also contribute a `settings.section` and render their own
values. The other two contribute no section, so the settings they declare, with labels and
descriptions written for a human, are reachable from no UI in the product:

| Plugin | Key | Label | Default |
|---|---|---|---|
| `document-surface` | `defaultMode` | Default document mode | `read` |
| `editor` | fold-frontmatter | Fold frontmatter when a document opens | `true` |

**Not dead code.** `defineSchema` is load-bearing: the runtime lays the declared defaults
under the stored values (`web/kernel/src/runtime/settings.ts`, `#effective`), which is why
both settings behave correctly at their default. It is only the `label`/`description`/
`type` half — the half that exists for a settings screen — that nothing consumes.

**Why `settings` cannot fix this centrally.** `SettingsApi.schema()` is plugin-scoped: it
returns *the calling plugin's* schema, and the frozen contract offers no way to enumerate
another plugin's (`web/kernel-api/src/settings.ts:51`, comment "for the settings UI"). So
a generic "render every plugin's schema" section in `settings` would need a new `@kernel`
surface. The in-bar fix is the other direction and is small: **`document-surface` and
`editor` each contribute their own `settings.section`** rendering their own `schema()` —
the same thing `themes` and `commands` already do, and no contract moves.

Worth doing first, because it is small, it is the pattern two base plugins already follow,
and it hands item 1 an escape hatch.

## 3. A document can only be moved between folders by dragging

**Repro.** On a phone (390 px), open the sidebar drawer and try to move a document into
`welcome/examples`. There is no way: the only move affordance is an HTML5 drag from a
`doc-list` row onto a `folders` tree node, and HTML5 drag-and-drop does not exist on touch.
A `doc-list` row's only document action is still "Move to Trash".

**Mitigated, not fixed.** The folder tree's hint names the real touch path — editing
`path` in the properties panel — so the gap is signposted rather than silent. The fix is a
"Move to folder…" action (a row action, a command, and a properties-panel folder picker),
which is new UI in two plugins rather than a correction to existing UI.

*(The `FolderTree.tsx` header comment that described a "Move to…" row prompt as though it
existed was corrected in the integration pass — it now states that drag and the properties
panel are the only two paths, and points here.)*

## 4. Folder rename is a `window.prompt`

**Repro.** Click a folder's ✎ (or press F2 on it). A native browser prompt appears;
`folders/src/index.tsx` calls `globalThis.prompt` in two places.

Three problems, in order of how much they matter:

1. **In the Flutter shell its behaviour is unpinned and untested.**
   `app/lib/shell/webview_host.dart` registers **no `onJsPrompt` handler**, so what a
   `prompt()` does inside the shell is whatever `flutter_inappwebview`'s default happens to
   be on that Android version. Nothing in this repo pins it, no host test can reach it, and
   `app/TESTPLAN.md` does not cover it — which puts it in the same category as the
   notification receivers of SPEC §11.5: a control that a green suite says nothing about.
   If the default is to suppress, the rename button does nothing at all on a phone.
2. It is not theme-aware — a white box in a dark workspace.
3. It blocks the whole page while a rename that may touch hundreds of documents is being
   *typed*, which is the one moment the progress reporting underneath it cannot be seen.

Needs a small in-tree dialog (`folders` already has the busy/progress/problem states to
render into), which is new UI, not a tweak. Doing so also removes the untested webview
dependency in (1) rather than documenting it.

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
