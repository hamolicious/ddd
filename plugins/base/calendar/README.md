# `calendar` — the M4 proof

Two halves, one directory, one job: **an ICS feed becomes documents, and documents become a
month grid.**

```
manifest.json          capabilities, config schema, cron, routes  (SPEC §6.2)
backend/               the Rust → wasm32 half           (cargo, plugins/ workspace)
ics/                   the pure half — parser, renderer, reconciler; host-testable
src/index.tsx          the React half                   (Vite, web/scripts/build-plugins.mjs)
src/dates.ts           months, grids, and the one query — pure, unit-tested
src/CalendarView.tsx   the month grid and the week list
src/style.css
```

Build both halves:

```text
mise run plugins        # frontend halves
mise run wasm-plugins   # backend halves → plugins/base/dist/calendar/1.0.0/backend.wasm
```

## What it demonstrates, and why each part is where it is

| SPEC §6.3 niche | Here |
|---|---|
| cron while nobody's looking | `backend.cron: ["0 6 * * *"]` → `lm_cron` |
| outbound HTTP with secrets | `feed_url` + an optional `secret: true` `auth_header`, through the host's `http_request` |
| machine-owned documents | one `VEVENT` → one document with `fm.date`, `created_by: plugin:calendar` |
| a plugin's own bookkeeping | `%%% calendar` in each document; the sync cursor and the deleted-uid list in KV |
| an inbound route | `POST /sync` (the "Sync feed" button), `GET /status` |

**The frontend half talks to no private channel.** It runs one local projection query over
`fm.date` and draws the grid — so the calendar works offline, before the first sync
completes, and for documents the plugin never wrote (a note dated Tuesday is on Tuesday).
That is SPEC §1's "share state through documents", and it is the reason `agenda` can be a
pure frontend plugin over the same field.

## The document it writes

```markdown
---
title: Standup
date: 2026-09-24T09:00:00Z
date-end: 2026-09-24T09:15:00Z
path: calendar/Work
location: Room 3
source: ical
source-uid: 2f1c…@google.com
---

# Standup

Daily standup, 15 minutes.

%%% calendar
feed: work
status: confirmed
sequence: 3
all-day: false
%%%
```

Two regions, two jobs:

- **Frontmatter is the portable half.** `date` is the field every dated view already queries
  — this plugin's grid, `agenda`, `properties`' date picker, the filter DSL's date type — and
  `source`/`source-uid` record where the event came from in text that survives an export to
  plain markdown. `date-end` is **inclusive**: RFC 5545's `DTEND` is exclusive, so a one-day
  all-day event would otherwise look like two. The document is machine-*owned* (SPEC §3.3),
  which is what makes authoring the whole block correct here and nowhere else.
- **The `%%%` section is bookkeeping**, spelled the way SPEC §3.3 spells it (hyphens), and it
  is the only region a *later* write touches: a vanished event is marked by splicing
  `status: cancelled` into it.

## Decisions worth disagreeing with deliberately

1. **The feed wins.** These documents are machine-owned (SPEC §3.3), so a changed event is
   `rewrite_document`d and a user's edit to `fm.title` is overwritten on the next sync. The
   honest alternative — merge, and keep a user's edit — needs a per-field "user touched
   this" record, which is a second source of truth about the event. If you want to annotate
   an imported event, write in the body of a *different* document and `doc://` link it.
2. **A vanished event is cancelled, not deleted.** `splice_section` sets
   `status: cancelled`; nothing is removed, and the grid strikes it through. There is no
   `delete_document` host function (`backend/HOST-ABI.md` §8), and removing a meeting from
   someone's workspace because a feed hiccuped is the wrong default even if there were. An
   event that comes back is restored by the ordinary changed-event path — the cancelled line
   makes the rendered text differ, so the rewrite heals it with no special case.
3. **A user's delete is respected, twice over.** The `document.deleted` hook records the uid
   on a bounded KV suppression list (500 entries, oldest dropped), *and* the reconciliation
   query runs with `trash: All` so a tombstoned event is recognised even if that at-most-once
   hook never arrived. Without either, trashing an imported event would look like the Trash
   being broken; with only the hook, one missed delivery would resurrect it.
4. **Unchanged events are not rewritten at all.** Reconciliation compares the *rendered text*
   with the document's materialized text and writes nothing when they match. A no-op
   `rewrite_document` is still a CRDT transaction and a feed row on every connected client.
   This is also why nothing time-varying is rendered into the document: the last-sync stamp
   lives in KV (`feed.last_sync`), not in the `%%%` section.
5. **Matching is a query, not a KV index.** `fm.source-uid` is in the projection already; a
   5 000-entry uid → id map in KV would blow the 64 KiB value cap and be a second source of
   truth for something that self-heals after any failure. The query is **not** scoped to one
   feed — a `UID` is globally unique in RFC 5545, so two feeds carrying one event share one
   document instead of each creating their own — while *cancelling* is feed-scoped, so two
   feeds cannot cancel each other's events.
6. **`capabilities.http.hosts` ships empty.** The plugin cannot know the operator's feed host
   when it is packaged, so the admin adds it at approval — the one capability an approval may
   widen (`backend/HOST-ABI.md` §7.2). Nothing is fetched until they do, and `lm_init` says
   so once in the server log rather than failing per call.
7. **No timezone database.** M4 keeps `DTSTART`'s wall-clock value and its `TZID` verbatim
   rather than inventing an offset. `fm.date` for a floating or zoned event is therefore the
   local time as written, which is what a human reading the feed expects and what a later
   version can refine without re-fetching. The view follows the same rule: a row's day is the
   day its frontmatter says, with no conversion — identical on every client — while "today"
   is the viewer's own local day, because that is a claim about the person, not the data.
8. **`RRULE` is carried, not expanded.** A recurring event is one document with its rule in
   the `%%%` section, and a `RECURRENCE-ID` override keeps the first occurrence (the parser
   records why). Expansion means deciding how far into the future to materialize documents,
   which is a product decision M4 does not need to make to prove the mechanism.
9. **The feed's own name names the folder.** `X-WR-CALNAME` becomes the last `fm.path`
   segment under the configured `folder`, normalized as one segment — a feed called
   `Work / Ops` is a folder called `Work - Ops`, not two nested ones. A feed does not get to
   invent a hierarchy in someone's workspace.
10. **The manual "Sync feed" button runs the same job, on a smaller budget.** A route
    invocation gets the 5 s per-call deadline, not cron's 60 s (`backend/HOST-ABI.md` §5). On
    a feed large enough to need more, the button reports `timeout` and the scheduled run —
    bigger budget, idempotent — finishes the job. The route is session-authenticated and
    deliberately **not** a public route: a refresh anyone could trigger is a free
    outbound-request amplifier.
11. **A partial run does not store the feed validators.** `ETag`/`Last-Modified` are written
    only when every write succeeded; otherwise the next run would get a `304` and never
    retry, leaving the workspace permanently half-synced.
12. **The schedule is the manifest's.** There is no `refresh_cron` config key, because a
    plugin cannot change its own schedule — the host owns the scheduler. Changing the
    refresh interval means editing `backend.cron` and reinstalling. If admin-chosen
    schedules become a feature, the seam is the approval step, not this plugin.

## Testing it

The pure half is a plain crate, so it is tested on the host target:

```text
mise run plugin-test    # cargo test -p calendar-ics --target x86_64-unknown-linux-gnu
```

- `ics/tests/corpus.rs` — feeds as publishers actually emit them: folded lines (space *and*
  tab continuations), escapes (`\n`, `\,`, `\;`, `\\` and the ones no RFC defines), CRLF/LF/CR
  line endings, date-only and `VALUE=DATE` events, `TZID`-qualified and floating times,
  quoted parameters with colons in them, `DURATION` instead of `DTEND`, `VALARM` and
  `VTIMEZONE` sub-components, a repeated `UID`, an unterminated `VEVENT`, an event with no
  `UID` and one with no `DTSTART`, a `SEQUENCE` that is not a number, and an HTML error page
  served as a feed.
- `ics/src/plan.rs` tests — reconciliation over fixture states: the empty workspace, the
  unchanged feed (which must write **nothing**), a changed event, a vanished one, one that
  comes back, a trashed one, a suppressed uid, a human's own note carrying a `source-uid`,
  another feed's documents, duplicate documents for one uid, and a metadata-only read.
- `ics/src/render.rs` / `yaml.rs` tests — the exact document text, and the quoting rules that
  keep a summary like `Review: budget #3` from corrupting the frontmatter.
- `src/dates.test.ts` — the frontend's grid arithmetic and **the range query it builds**,
  including the assertion that the upper bound is exclusive (an `lte` bound on the last day
  silently drops every timed event on it, because the DSL compares canonical date strings
  byte-wise). Run from `web/`: `npx vitest run ../plugins/base/calendar`.

A wasm plugin crate cannot be unit-tested on the host — it links the Extism host imports — so
keep the logic in `ics/` and the glue in `backend/`. The end-to-end path (a real module in a
real Extism host) is `mise run plugin-smoke`.
