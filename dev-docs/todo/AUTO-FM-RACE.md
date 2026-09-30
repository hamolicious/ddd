# auto-fm: two devices add the same property

Found 2026-09-30 while fixing the app e2e suite after kernel 3.0. Not fixed; the test that
tripped it (`web/app/e2e/reader-live.spec.ts`) was changed to close its extra browser
contexts, so the suite no longer triggers it.

**What happens.** A person has the workspace open on more than one device (or in more than
one tab) and makes a note that matches an auto-fm rule. More than one of those
clients adds the property, so the note ends up with the key twice, or with the two values
run together (`status: freshfresh`).

**Why the guard misses it.** `plugins/base/auto-fm/src/watcher.ts` only acts on a change
this user made while this window has focus, or on a new note whose row is still this
device's own (`materialized_version: "local"`). Both checks are per device and read only
the local replica, so two clients can each pass them before either sees the other's
splice. "Never a key the note has" is re-checked just before the write, but against the
local copy, which does not have the other device's splice yet.

**Options.**

- **A. Idempotent write.** Splice the key only if it is absent in the document state
  the splice is applied to (a CRDT-level "set if missing"), so the second writer does
  nothing. Needs a splice helper that can express that condition.
- **B. One writer.** Let the server add the properties (a backend hook on
  `document.created`), and drop the client watcher for new notes. Offline-created notes
  get their properties when they reach the server instead of at once.
- **C. Tidy afterwards.** Keep the client write, and have the watcher collapse a
  duplicated key it wrote into one. Cheapest, but the doubled value is visible briefly.
