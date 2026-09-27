# Offline → online sync recon

Read-only architecture review, 2026-09-27. This records risks found while tracing the
current client outbox, document hydration, change feed, IndexedDB persistence, and
offline attachment queue. It is a review document, not a statement that the items below
have been fixed.

## Verdict

The design is unusually thoughtful and the ordinary offline/reconnect path is strong.
Yjs state-vector reconciliation, durable local replicas, atomic projection checkpoints,
and explicit recovery UX are good foundations.

It is not yet safe to claim that "nothing typed is dropped" under interrupted delivery
and multi-tab concurrency. The remaining risks are concentrated in queue ownership,
cross-tab coordination, and treating a successful `WebSocket.send()` as if the server
had committed the update.

## What is strong

- Document recovery is state-derived. Reconnect, resync, and hydration compare Yjs state
  vectors rather than trusting a remembered sequence of frames
  (`web/kernel/src/sync/doc-hydration.ts`).
- Projection rows and the feed checkpoint commit in one IndexedDB transaction, preventing
  a watermark from advancing past rows that were not stored
  (`web/kernel/src/store/idb-store.ts`, `applyRows`).
- Bootstrap pins a server watermark and only publishes it after a complete pass; feed
  replay is idempotent by document sequence (`web/kernel/src/sync/bootstrap.ts`).
- Offline edit journals survive reloads and preserve when edits were made. Oversize
  documents remain pending, a purge offers unsynced text for recovery, and expired
  sessions can export unsent work.
- The product behavior is explicit: offline creation, trash/restore, attachment queuing,
  stale server-only screens, persistent-storage warnings, and reconnect status all have
  defined UX (`dev-docs/resolved/SYNC-DECISIONS.md`).

## Findings

### P0 — the shared outbox can lose operations between tabs

`Outbox.add()` and successful removal both update one array in the metadata store using
separate read and write operations:

1. read the whole queue with `getMeta`;
2. produce a new array;
3. replace the whole queue with `setMeta`.

The Web Lock covers `drain()`, but it does not cover producers calling `add()` or the
read-modify-write operation itself (`web/kernel/src/runtime/outbox.ts`, `add`, `#drain`,
`#update`, and `#withLock`). `IdbProjectionStore.getMeta` and `setMeta` are also separate
transactions (`web/kernel/src/store/idb-store.ts`).

Consequences:

- two tabs can both read the same queue and the later write can erase the earlier add;
- an add racing with a successful removal can be erased;
- the opposite ordering can resurrect an already delivered operation;
- without Web Locks, drains in different tabs are not serialized at all.

This contradicts the outbox's stated "one tab at a time" invariant.

Recommended direction: store operations as individual IndexedDB rows with unique
operation IDs, and make claim/complete transitions transactional. If the array remains,
every producer and consumer mutation must use the same cross-tab lock, with a defined
fallback for browsers without Web Locks.

### P0 — a queued create can be completed by the wrong tab

At startup every tab reads the shared outbox and calls `holdUntilCreated()` for its queued
create IDs (`web/kernel/src/runtime/documents.ts`, `DocumentsHost.start`). Whichever tab
later obtains the drain lock sends the create and calls `hydrator.created(id)`.

That completion only clears the in-memory `#awaitingCreate` set in the tab that happened
to drain (`web/kernel/src/sync/doc-hydration.ts`, `created`). Other tabs receive no
completion signal. A tab with that note open can therefore remain in the awaiting-create
state, never subscribe the document, and keep later edits device-only until a reload.

Recommended direction: make create completion shared state and broadcast it, or elect a
single sync owner and have all tabs consume its queue-status events. A feed row for the
new ID could also clear `#awaitingCreate`, provided that transition is explicit and tested.

### P0 — document writes are marked synced before server commit

`SyncTransport.sendBinary()` only calls the browser's `WebSocket.send()`; it establishes
that the frame entered the client socket buffer, not that the server read or committed it
(`web/kernel/src/sync/transport.ts`).

Despite that, an online edit is not journaled after `sendBinary()` returns, and an offline
journal is cleared immediately after its frames are sent
(`web/kernel/src/sync/doc-hydration.ts`, `#onLocalUpdate`, `#flush`, and `#clearOutbox`).
The server deliberately does not echo an applied update to its originating socket
(`backend/PROTOCOL.md` §3.4; `backend/crates/server/tests/sync_ws.rs`). There is therefore
no application-level commit acknowledgement.

Failure window:

1. the browser accepts a frame into the socket buffer;
2. the client clears `pending` and persists the replica with `unsynced: false`;
3. the connection or page dies before the server applies the frame.

If the same in-memory document reconnects, the state-vector handshake heals the gap. A
reload does not proactively heal it: `sendUnsynced()` only opens replicas whose
`unsynced` flag is true. The edit is also absent from the unsent export and can be treated
as safe to discard on a later purge. Reopening that exact document will normally heal it,
but until then the status is wrong and the work is vulnerable to browser storage eviction
or purge.

Recommended direction: do not clear the journal until there is server proof. That can be
an explicit committed-update acknowledgement, or a state-vector challenge whose server
vector is verified to cover the local update. The proof must survive reloads and work for
documents that are no longer open.

### P1 — the attachment queue has no cross-tab owner or idempotency key

The attachment IndexedDB queue is shared by tabs, while `draining` is only an in-memory
boolean inside one plugin instance (`plugins/base/attachments/src/index.tsx`). Every
synced tab can read the same entries and upload them.

`POST /api/attachments` creates a fresh server ID for every request
(`backend/crates/server/src/routes/attachments.rs`, `upload`). It has no client operation
ID or idempotency key. Two tab drains, or a committed upload whose HTTP response is lost,
can therefore create duplicate blobs. One reference may be placed successfully while the
other becomes an orphan.

The 100 MB limit is also a non-atomic `bytes()` followed by `add()`, so concurrent pastes
can exceed it.

Recommended direction: use a cross-tab queue claim, give each queued upload a stable
idempotency key accepted by the server, and account for capacity in the same IndexedDB
transaction that inserts the blob.

### P1 — "every document editable offline" is an expensive replication policy

The application sets `persistedReplicas` to infinity and the background copier fetches a
full CRDT state over REST for every missing or stale document, two requests at a time
(`web/app/src/boot/kernel-init.ts`; `web/kernel/src/runtime/offline-copies.ts`).

At the 5,000-document acceptance size, a new device performs roughly 5,000 individual
CRDT requests and stores the full editable workspace locally. Multiple tabs can repeat
the scanning and fetching work. This is a valid product choice, but it needs explicit
network, storage, quota, and first-sync acceptance targets rather than relying only on the
projection bootstrap target.

Recommended direction: measure initial CRDT-copy duration and bytes at 5,000 documents,
deduplicate the work across tabs, expose progress, and decide what happens when the device
cannot hold the full workspace.

### P2 — crash durability has a debounce window

Replica persistence is delayed by 500 ms by default. Normal editor release flushes it,
but there is no application `pagehide`/`beforeunload` lifecycle flush; `sync.stop()` is
used during controlled teardown. A process kill, browser crash, or very fast tab close
inside the debounce window can lose the newest local transaction.

Some durability window may be unavoidable in a browser, but the promised semantics and
test expectations should name it. Consider a shorter/idle persistence path plus a
best-effort `pagehide` flush.

### P2 — pending status can undercount unopened queued creates

Outbox pending counts deliberately exclude create operations on the assumption that the
document replica counts them. A seeded create that is not currently open has no `DocEntry`
whose `pending` value can be counted. After reload, `holdUntilCreated` restores the wait
state but not the sync indicator count. Sign-out protection uses `unsentIds()` and remains
more conservative, but the visible pending count can still claim zero.

## Missing adversarial tests

Add coverage for these before considering the sync guarantee complete:

- two tabs append different outbox operations at the same time;
- one tab appends while another removes a successfully delivered operation;
- the browser lacks `navigator.locks` and two tabs reconnect together;
- an offline-created note is open in tab A but drained by tab B;
- `WebSocket.send()` succeeds, the server never applies the frame, and the page reloads;
- the same lost-after-send case followed by unsent export and by a purge;
- two tabs drain the same queued attachment;
- an attachment commits but its HTTP response is lost, then the queue retries;
- two concurrent attachment inserts at the 100 MB boundary;
- a tab/process closes immediately after an offline keystroke, inside the persistence
  debounce.

Existing end-to-end tests already cover useful nearby cases: offline reconnect, reload,
two devices, two tabs editing one document, session expiry, trash conflicts, oversize
documents, queued creation, and one queued attachment. The missing tests above target
ownership and ambiguous-delivery boundaries rather than those established happy paths.

## Suggested hardening order

1. Replace or transactionally protect the shared outbox and define one cross-tab owner.
2. Propagate queued-create completion to every tab.
3. Add durable server-commit proof for document updates before clearing `unsynced`.
4. Add attachment queue claims and server-side idempotency.
5. Stress the all-documents offline-copy policy at the 5,000-document gate.
6. Close the crash-debounce and pending-count honesty gaps.

## Recon validation

The review did not modify implementation files. The focused checks run during recon were:

```text
web/kernel/src/runtime/outbox.test.ts
web/kernel/src/sync/doc-hydration.test.ts
web/kernel/src/store/idb-store.test.ts
```

All 69 tests passed, and `npm run typecheck` passed. Those results confirm that the
current intended behavior is internally consistent; they do not cover the concurrency
and ambiguous-delivery scenarios listed above.
