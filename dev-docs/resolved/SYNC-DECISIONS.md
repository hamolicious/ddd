# Sync and offline: decisions

Found while testing offline editing end to end. Each item was a state where the right
behaviour was a product choice, not a bug. This records what was chosen and what the app
does now. Every item is covered by `web/app/e2e/offline.spec.ts`.

Fixed along the way (no decision needed): a closed tab's offline edits were lost when
another tab saved the same note; an offline edit over the size limit was refused silently
while the status said "saved"; a session that ended while offline left the app saying
"Offline" forever instead of asking to sign in; a note deleted for good elsewhere dropped
this device's unsynced edits; signing in again within 5 seconds of pressing Reconnect left
the sign-in dialog up for good; offline errors showed the browser's "Failed to fetch"; a
never-opened note offline showed two messages, one with its raw id; the sign-in dialog
unmounted during reconnect attempts, wiping a typed password; sign-out counted only open
notes' unsent edits.

| # | Situation | Decision |
|---|---|---|
| 1 | Creating a note offline | Create it on the device |
| 2 | Trash, restore, move, rename offline | Queue, show at once |
| 3 | Note trashed elsewhere while edited offline | Say so, offer Restore |
| 4 | Note purged elsewhere while holding unsent edits | Save as a new note automatically |
| 5 | Offline edit over the size limit | Refuse, keep, ask to trim |
| 6 | Cannot sign in again after going offline | Save unsent changes to a file |
| 7 | Notes never opened on this device | Every note editable offline |
| 8 | Uploading files offline | Queue on the device |
| 9 | Server-only screens offline | Show the last-loaded version, marked |
| 10 | Time to show "Offline" | Keep 2–5 s |
| 11 | Wrong device clock | Keep clamping |
| 12 | Storage persistence warning | Ask once, warn only if refused |

---

## 1. Creating a note offline

A note made offline gets a device-minted ULID and a local replica, opens for editing at
once, and shows in the list (a local row). It waits in the outbox and is created on
reconnect from the device's own CRDT state (`POST /documents { id, state }`,
`backend/PROTOCOL.md` §3.8), so later edits merge instead of repeating the text. A retried
create is recognised as ours; an id someone else holds becomes a new note. Online creates
take the same path.

## 2. Trash, restore, move and rename offline

Moves and folder renames are text edits (`path:`), and with §7 every note has a replica, so
they work offline and show in the list at once. Trash and restore wait in the outbox, in
order, and also show at once; a refusal on reconnect undoes the local change and says why.
Queued changes count in "n unsynced" and block sign-out like any unsent edit.

## 3. A note moved to Trash elsewhere while edited offline

The edits are applied and kept in Trash. After they are sent, if the note turns out to be
in Trash (and this device did not put it there), a notice says "“X” was moved to Trash
while you were offline. Your changes are kept there.", with **Restore** and **Open**.

## 4. A note deleted for good elsewhere while this device held unsent edits

The edits are saved as a new note straight away and a notice says so, with **Open it**.
Nothing can be lost by ignoring a prompt. (Emptying Trash sooner than 30 days is a separate
question: `dev-docs/todo/DELETE-PERMANENTLY.md`.)

## 5. An offline edit that pushes a note over the 1 MB limit

The server refuses it; the device keeps everything; a notice names the note and says to
trim it; the status shows unsynced edits instead of "saved"; trimming it saves again and
clears the notice.

## 6. Signing in again is not possible

The sign-in dialog has **Save my unsent changes to a file**: a Markdown file with every
note holding unsent changes, in full, plus any queued trash or restore. For someone whose
password was reset or account removed while offline.

## 7. Notes never opened on this device

Every note is editable offline. While online, every note's CRDT state is kept on the device:
fetched in the background a moment after connecting, refreshed when a note changes
elsewhere, and merged so unsent edits are never touched. Nothing is pruned; a purge drops a
copy. A note not copied yet is readable and says "has not been copied to this device yet".

## 8. Uploading files offline

Every file pasted or attached is kept on the device (IndexedDB, up to 100 MB in total) until
the server has all of it, and goes up in chunks (`/api/uploads`): a dropped connection, a
pause or a reload carries on from the last chunk the server kept. Over the 100 MB a file
still uploads, from memory, and a reload loses it. Each upload has a notice with a progress
bar, where the file goes, the time left, and Pause, Cancel and Open.

A file pasted or attached offline is kept on the device the same way
and its placeholder stays: an embed of `attachment://waiting-<token>` whose alt text reads
"Uploading *name*…" (the same placeholder an online upload has while its request runs, so
nothing is rewritten when the connection turns out to be gone). Read mode shows the file
from the device meanwhile
(an image as the image, anything linked as a chip), noting it is on this device only; a
device without the file says it has not been uploaded yet. The server ignores the id, as it
is not a ULID. On reconnect it uploads and the placeholder becomes the link or preview, in whichever note
holds it, even after a reload. Signing out deletes waiting files.

## 9. Server-only screens offline

Admin tabs, the Changes panel, a change or snapshot view, and the file page keep their last
answer on the device (opt-in per request through `kernel.session.fetch`; documents never go
through it). Offline they show it with "You are offline. This is what was loaded *when*; it
may be out of date." A screen never loaded on the device still says it needs the server.
Signing out deletes the copies.

## 10. How long the app takes to say "Offline"

Kept: 2–5 seconds after the connection drops (measured). Edits in that window are kept like
any other. Shorter would mean false alarms on a flaky connection.

## 11. A device with a wrong clock

Kept: an offline edit is recorded at the time the device claims, clamped between the
previous change and the moment it arrived, so history never goes out of order or into the
future. A clock that is wrong but plausible still shows a wrong time in history.

## 12. Persistent storage

Asked for once per device, at the first sign-in. The warning ("The browser may delete this
workspace's offline copy…") shows only when that ask is refused, with **Ask again**.
