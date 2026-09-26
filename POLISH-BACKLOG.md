# Polish backlog

Open UX/product work that a sweep could not fix — each item needs a server endpoint, a new
`@kernel` surface, or a product decision. Everything was seen in a running build at 1280 px
and 390 px. **Item numbers are stable**: source comments cite them, so closed items keep
their number in the Closed table and nothing is renumbered — a gap means "fixed".

Ordered by value: how often a user hits it × how stuck they are when they do.

## 11. Two people setting the same frontmatter key at once get a value neither typed

The one **correctness** item. Two clients drag one document to different folders
concurrently → both value-splices survive inside one line → `path: archiveinbox`. Pinned by
`web/kernel/src/runtime/splice.test.ts` "concurrent writes to one key" (which also shows
`%%%` line-writes merge correctly — last-occurrence-wins picks a value a user asked for).

Not fixable in `folders`: every plugin-level workaround either reformats the block (§3.3
violation, byte-compared by e2e) or reimplements `core::splice` outside the kernel. **The
fix**: `core::splice::set_frontmatter_value` replaces the key's **line in place** (delete
line span, insert new line at its start) instead of the value span — same text for a lone
writer, duplicate lines under concurrency, parser resolves. Touches Rust + the TS port
together, regenerates `corpus/splices.json`, rewords SPEC §3.3, and needs a decision about
trailing comments on the line. A kernel/core wave, not a sweep.

## 5. A document has no delete, and no way back to where you came from

Open `#/doc/<id>` directly: no trash action (lives only on `doc-list` rows), no
"back to documents" control; on a phone the drawer is the only exit. Needs a
`document.delete` command + a breadcrumb in `docsurface-header` — additions to a header
other plugins contribute into.

## 6. The notice bell opens itself, and there is no "dismiss all"

At 390 px the popover auto-opens on arrival, covers a third of the screen, and has no close
control of its own; three notices have no single dismiss. (If the full-width strip ever
returns as anything but the no-mount fallback, note it sits outside `.shell-root` and
pushes the shell down by its own height.)

## 7. An invite is a bare token with no link

Admin → Invites shows the token once with Copy — but no URL. The recipient must be told
the steps separately. Fix: a registration URL (`<origin>/#/register?invite=<token>`) the
auth gate reads — a route on kernel-owned `AuthGate.tsx`, not a plugin change.

## 8. Trash has no "delete permanently" and no "empty Trash"

No endpoint exists — purge is a 30-day background job (SPEC §3.5). Starts in
`routes/documents.rs` with an admin-or-owner purge route; graveyard rules unchanged.

## 9. A list-valued property is shown twice

Chips + a comma-separated field for the same array (deliberate, documented in
`ListValueEditor`) still reads as a bug in a narrow sidebar. Fix is one tokenised input —
a component, not CSS.

## 10. The registration form offers no display name

`POST /api/auth/register` already accepts `name`; the gate never asks. Everyone keeps
their email's local part. A preference, not a defect.

## Minor

- `TRASH_LIMIT` (doc-list) is still 1 000; Trash now sorts through the query, so a normal
  page size is fine.
- `%%% calendar` / `plugin:calendar` survive as arbitrary example ids in fixtures, corpus
  and ABI docs — deliberate (see `backend/CONTRACTS.md`); not a loose end.
- The sync pill's expired-session state is still a "Sign in" text button, where offline
  and sync errors are now red ✕ / ↻ icons (`sync-status`).
- Typecheck fails on the unused `touchOnly` in `plugins/base/folders/src/FolderTree.tsx`
  (line 184).

---

## Closed

One line each; detail is in git history (this file before ff2e177/b5b2d12) and
`web/CONTRACTS.md`'s "Core-improvements pass".

| Was | Outcome |
|---|---|
| 1 — new doc lands in read mode on an empty page | Per-user "Open documents in" setting; `?mode=` on the route remains a design call |
| 2 — two plugins declared settings no screen rendered | One rendered (`document-surface`), one deleted with its behaviour (`editor` fold pref) |
| 3 — folder moves were drag-only | Long-press/right-click/`⋯`/`M` sheet with Move-to, portalled past the sidebar's container trap |
| 4 — folder rename was `window.prompt` | Inline field; native dialogs fail the e2e run so it can't return |
| Trash sort caveat | `deleted_at` is a DSL root; Trash sorts through the query |
| Wide tables scroll the view on a phone | Not reproducible after the settings-pane `min-width: 0` fix |
| Palette/keybindings rows announced as one word | Generated-content separator; accessible-name asserted |
| Notices appeared twice | Kernel strip only when nothing holds the mount; bell is sole renderer (remainder = item 6) |
| Registration "never asks a name" | Mis-diagnosed — server falls back to the email local part; reduced to item 10 |
| Task lists double-indented; filter badge counted whitespace; date-only fm rendered a day early west of Greenwich; machine-doc write hole in folders; empty-folder settings races; stale default-mode reads; fm_parse_error invisible in edit mode | All fixed in the core-improvements wave + its review follow-ups (b5b2d12), each with a test |

**Verified good** (so nobody looks twice): empty states (list/folders/Trash), invite flow,
keybinding capture dialog, dark theme everywhere, drawer focus behaviour, auth gate at
390 px, single-character task-toggle splices, typed property adds (byte-identical rest of
block), CodeMirror sync, search incl. `?line=N` deep links, delete→restore, theme
switching, admin users table, zero horizontal overflow on all thirteen routes at 390 px.
