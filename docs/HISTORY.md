# Document history

Every edit to every document is kept, forever, and any point in a document's life can be
read back, diffed, or reverted. This is the design; the phases at the end say what is
built.

No backwards compatibility: the database is wiped when this ships, so there is no
migration, and nothing here reads the old automatic snapshots.

## Principles

- **Clients keep writing CRDT updates**, online or offline, exactly as now. History is
  the server's job.
- **The live document stays small.** History never enters the Y.Doc that devices sync;
  it lives in its own collections, beside it.
- **Nothing is deleted except on purpose**: purging the document, or an admin's "forget
  history". Old history is squashed (less detail), never dropped.
- **Any point in time is at most `CHECKPOINT_EVERY_CHANGES` steps from a checkpoint**, so
  reading a years-old version costs the same as reading last week's.

## Who does what

**Client**
- Applies its own edits to its local Y.Doc at once and stores it (IndexedDB), as now.
- Keeps an **edit journal** per document: `{ time, update }`, one entry per ~2 s of
  typing. Live edits are cleared from it once the server acknowledges them.
- On (re)connect: subscribes, sends its journal in order as `HISTORY { client_time,
  update }` frames, then the usual state-vector exchange as a safety net (a no-op when
  the journal covered everything). Clears the journal on acknowledgement.

**Server**
- Applies every update through the per-document room, as now, and records what it did to
  the text as a **change**: hunks (at byte X of the text before, A → B), who, made-at,
  received-at, offline or not.
- Writes a **checkpoint** (the full text at that `seq`) every `CHECKPOINT_EVERY_CHANGES`
  changes, inside the same write.
- Squashes raw changes older than `RAW_CHANGE_DAYS` into one record per **group** (one
  author, no pause over two minutes), in a background job.
- Rebuilds any point in time from the nearest checkpoint.

## Storage

| Collection | Holds | Kept |
|---|---|---|
| `documents` (`crdt`) | the live, compacted CRDT and the materialized text | live |
| `document_updates` | recent binary updates: the sync buffer for reconnecting clients | last 200 / 1 MiB |
| `document_changes` | **raw tier**: one record per write, with hunks and times | `RAW_CHANGE_DAYS`, then squashed |
| `document_history` | **squashed tier**: one record per group, net hunks | forever |
| `document_checkpoints` | full text at a `seq`, every `CHECKPOINT_EVERY_CHANGES` changes | forever |
| `document_snapshots` | **manual** and **pre-restore** snapshots only | forever |

Automatic snapshots (after a pause, daily) are gone: changes plus checkpoints cover them.

## Offline times

A claimed `client_time` is clamped between the previous change's time and the time it
arrived, so a wrong device clock cannot reorder history. Offline edits are marked. A lost
journal (site data cleared) falls back to one change stamped when it arrived, marked
offline.

## Reading

- **Text at `seq`**: the nearest checkpoint, before or after, then forward or backward
  through at most `CHECKPOINT_EVERY_CHANGES` changes. Each step checks the text holds what
  the change says, so a gap is refused rather than guessed at.
- **A group's diff**: the text before and after the group, rebuilt from checkpoints, then
  diffed by line.
- **Revert**: the group's net hunks, carried forward through every later change;
  refused, naming who was in the way, when a later change touched the same text. Written
  as a new change that records what it reverted.

## Squashing

Per document, per closed group older than `RAW_CHANGE_DAYS`: rebuild the text before and
after it, diff, write one `document_history` record keyed by `(document_id, from_seq)`
(an upsert, so a rerun is harmless), then delete the raw records in its range. Readers
prefer a squashed record wherever it overlaps raw ones, so a crash between the two writes
leaves correct, duplicated data that the next run tidies.

## Forget history

An admin action per document: deletes its changes, squashed groups, checkpoints and
snapshots, writes a fresh checkpoint of the current text, and records who did it in the
audit log. For the "I pasted a secret" case.

## Scale (estimates, to be measured)

- Raw tier: bounded by `RAW_CHANGE_DAYS` of writes per document.
- Squashed tier: roughly 5–15 MB a year for a note edited constantly; MongoDB compresses
  text 3–5× on disk.
- Checkpoints: one full text per 1000 writes.

## Configuration

| Variable | Default | |
|---|---|---|
| `CHECKPOINT_EVERY_CHANGES` | `1000` | a checkpoint after this many changes |
| `RAW_CHANGE_DAYS` | `30` | raw changes older than this are squashed |
| `HISTORY_SQUASH_INTERVAL_SECS` | `3600` | how often the squash job runs |

## Phases

1. **Checkpoints and reading any point in time.** Changes are kept (no trimming);
   checkpoints every 1000; `GET /documents/:id/text?at=<seq>`; "view as of here"; group
   diffs and reverts rebuilt from checkpoints; automatic snapshots removed.
2. **Squashing and forget history.** The background job, `document_history`, readers
   that merge both tiers, the admin action.
3. **Edit journal and `HISTORY` frames.** Real offline times, the offline mark.
4. **Measure** on real notes; tune `CHECKPOINT_EVERY_CHANGES` and `RAW_CHANGE_DAYS`.
