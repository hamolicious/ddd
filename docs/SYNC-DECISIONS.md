# Sync and offline: decisions

Found while testing offline editing end to end (`web/app/e2e/offline.spec.ts`). Each item is
a state where the right behaviour is a product choice, not a bug. **Now** is what the app
did when the question was asked; the options follow, then the answer (`>`) and what was
built. Every answer is covered by `web/app/e2e/offline.spec.ts`.

Fixed along the way (no decision needed): a closed tab's offline edits were lost when
another tab saved the same note; an offline edit over the size limit was refused silently
while the status said "saved"; a session that ended while offline left the app saying
"Offline" forever instead of asking to sign in; a note deleted for good elsewhere dropped
this device's unsynced edits; signing in again within 5 seconds of pressing Reconnect left
the sign-in dialog up for good; offline errors showed the browser's "Failed to fetch"; a
never-opened note offline showed two messages, one with its raw id. A theme changed offline
already applied at once and synced later.

---

## 1. Creating a note while offline

**Now:** refused. A notice says the server is unreachable, with **Try again**.

The server already accepts ids minted on the device (SPEC §3.5), so this is a choice, not
a limit.

- **A. Keep refusing.** Simple; the notice is honest.
- **B. Create it on the device** with a device-minted id, editable at once, sent to the
  server on reconnect (as a create, then its edits). **Recommended**: new notes are the
  most common thing to want offline.
- **C. Allow it only from the palette**, not from folder menus.

> b

**Done (B).** A note made offline gets a device-minted ULID and a local replica, opens for editing at once, and shows in the list (a local row). It waits in the outbox and is created on reconnect from the device's own CRDT state (`POST /documents { id, state }`, PROTOCOL.md §3.8), so later edits merge instead of repeating the text. A retried create is recognised as ours; an id someone else holds becomes a new note. Online creates take the same path.

## 2. Trash, restore, rename or move a folder, move a note, while offline

**Now:** refused with a plain message in the list ("You are offline…"); nothing changes.

- **A. Keep refusing.**
- **B. Queue them** and apply on reconnect, showing them as done straight away. Moving a
  note or renaming a folder is a text edit (`path:`), so for documents this device has
  opened it could be a normal offline edit; trash and restore would need a small queue of
  their own. **Recommended for moves and renames** (they are text edits already);
  trash/restore can wait.

> b

**Done (B), including trash and restore.** Moves and folder renames are text edits, and with §7 every note has a replica, so they work offline and show in the list at once. Trash and restore wait in the outbox, in order, and show at once; a refusal on reconnect undoes the local change and says why. Queued ones count in "n unsynced" and block sign-out like any unsent edit.

## 3. A note moved to Trash elsewhere while this device edited it offline

**Now:** on reconnect the edits are applied to the trashed note and kept there. Nothing
tells the person their note is now in Trash.

- **A. Say so:** a notice "“X” was moved to Trash while you were offline; your changes
  are kept there", with **Restore** and **Open**. **Recommended.**
- **B. Restore it automatically** because someone edited it.
- **C. Leave it** (today).

> a

**Done (A).** After offline edits are sent, if the note turns out to be in Trash (and this device did not put it there), a notice says so, with **Restore** and **Open**.

## 4. A note deleted for good elsewhere while this device held unsent edits

**Now (fixed today):** the edits are saved as a **new note** straight away and a notice
says so, with **Open it**. Before, they were dropped silently.

- **A. Keep the automatic new note.** Nothing can be lost by ignoring a prompt.
  **Recommended.**
- **B. Ask first** ("Save your version as a new note?"). Risk: dismissing it loses the
  edits for good.

Related: there is **no "Delete permanently"** action; notes purge only after 30 days in
Trash. Decide whether people should be able to empty Trash sooner.

> a

**Kept (A).** Still open: a "Delete permanently" / empty-Trash-now action was not added; say if you want it.

## 5. An offline edit that pushes a note over the 1 MB limit

**Now (fixed today):** the server refuses it; the device keeps everything; a notice names
the note and says to trim it; the status shows unsynced edits instead of "saved"; trimming
it saves again and clears the notice.

- **A. Keep this.** **Recommended.**
- **B. Offer to split** the note automatically at the limit.

> a

**Kept (A).**

## 6. Signing in again after the session ended offline, when that is not possible

**Now (fixed today):** reconnecting asks to sign in again; the unsent edits wait on the
device and go through after sign-in. But if the person _cannot_ sign in (password reset by
an admin, account deleted), the edits stay on the device with no way out.

- **A. Offer "Save my unsent changes to a file"** on the sign-in dialog. **Recommended.**
- **B. Let another account sign in** and take the edits (they would be attributed to it).
- **C. Nothing** (today).

> a

**Done (A).** The sign-in dialog has **Save my unsent changes to a file**: a Markdown file with every note holding unsent changes (in full), plus any queued trash or restore. The dialog also no longer flickers away (and wipes a typed password) when a reconnect attempt runs behind it.

## 7. Notes this device has never opened, offline

**Now:** readable (every note's text is on every device), not editable: one sentence says
why. The device keeps editable copies of the last 50 notes opened.

- **A. Keep it.**
- **B. "Keep available offline"** per note or folder, to pin editable copies.
- **C. Make every note editable offline** (a full editable copy of the workspace on every
  device: more storage, slower first sync). **Recommended: B**, when someone asks.

> c

**Done (C).** While online, every note's CRDT state is kept on the device (fetched in the background, a moment after connecting, refreshed when a note changes elsewhere, merged so unsent edits are never touched). Nothing is pruned any more; a purge drops a copy. A note not copied yet says so ("has not been copied to this device yet").

## 8. Uploading files while offline

**Now:** a paste or drop offline is refused with a notice (the placeholder is removed).

- **A. Keep refusing.**
- **B. Queue the file on the device** and upload on reconnect, with the placeholder
  staying until it does. **Recommended** eventually; needs storage limits.

> b

**Done (B).** A file pasted or attached offline is kept on the device (IndexedDB, up to 100 MB in total) and its placeholder stays, reading "Uploading *name* when back online… #token". On reconnect it uploads and the placeholder becomes the link or preview, in whichever note holds it, even after a reload. Over the limit, it is refused as before. Signing out deletes waiting files.

## 9. Server-only screens while offline

**Now:** Admin tabs, the Changes panel, a change's diff and the file page say "You are
offline, or the server cannot be reached…" instead of loading.

- **A. Keep it.** **Recommended.**
- **B. Show the last-loaded version** marked as possibly out of date.

> b

**Done (B).** Admin tabs, the Changes panel, a change or snapshot view, and the file page keep their last answer on the device (opt-in per request through `kernel.session.fetch`; documents never go through it). Offline they show it with "You are offline. This is what was loaded *when*; it may be out of date." A screen never loaded on the device still says it needs the server. Signing out deletes the copies.

## 10. How long the app takes to say "Offline"

**Now:** 2–5 seconds after the connection drops (measured). Edits in that window are kept
like any other.

- **A. Keep it.** **Recommended.**
- **B. Shorter** (more false alarms on a flaky connection).

> a

**Kept (A).**

## 11. A device with a wrong clock

**Now:** an offline edit is recorded at the time the device claims, kept between the
previous change and the moment it arrived, so history never goes out of order or into the
future. A clock that is wrong but plausible still shows a wrong time in history.

- **A. Keep it.** **Recommended.**
- **B. Mark offline times as approximate** in the Changes panel.

> a

**Kept (A).**

## 12. The "browser may delete this workspace's offline copy" notice

**Now:** shown whenever the browser has not granted persistent storage, which in tests is
always.

- **A. Keep it.**
- **B. Ask for persistent storage** at first sign-in (the browser may prompt), and only
  warn if refused. **Recommended.**

> b

**Done (B).** Persistent storage is asked for once per device, at the first sign-in; the warning shows only when that ask is refused, with **Ask again**.
