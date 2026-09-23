# Spec Critique (Opus agent, 2026-09-23)

Adversarial critique of the DECISIONS made in SPEC.md. Severity tiers: **[R] = would force a rewrite of a committed subsystem**, **[P] = real implementation pain / production bugs**, **[S] = precision/style**.

---

## TIER R — rewrite risk

### R1. Full replication of *CRDT state* to every client forecloses ACLs and will not fit on the M5 target device
**Claim (§4, §10):** "clients replicate the entire document set… at this app's scale (text documents) it's tens of MB. Selective sync… is a v2 concern." Plus §5.2: "Schema reserves room for ACLs later."

**Why it's wrong:**
- The size estimate counts *materialized markdown*, but clients hold **Yjs state**, not plaintext. Per-character CRDT items carry client-id, clock, and origin links; for edited prose, post-GC state is typically 2–10× plaintext, worse before compaction. Then it's held **twice** (IndexedDB + in-memory `Y.Doc`) plus a materialized string per doc for the query engine plus a MiniSearch index (in-memory, roughly 1–2× source text). Realistic client footprint is **3–5× workspace plaintext in RAM**. A 5,000-doc / 20 MB-plaintext workspace lands at 60–200 MB resident — inside an Android WebView (§7), that is an OOM kill, not a slowdown.
- **One `Y.Doc` per document × all documents, all loaded.** `Y.Doc` is not a cheap value object (own StructStore, observer graph), and the standard `y-indexeddb` provider opens **one IndexedDB database per doc** — thousands of IDB connections at boot.
- Initial/reconnect sync is **N per-doc state-vector handshakes** (y-protocols sync step 1 is per-doc). "State-vector exchange transfers only the diff" hides an O(all docs) round-trip count on *every* cold start.
- ACLs are not a schema concern under this design. Per-doc ACLs require selective sync, which requires a server-authoritative doc feed and kills "search, filter, and sort work identically offline and online" (a client can only index what it's allowed to hold). So "ACLs later" = **rewrite the sync protocol and the entire query story**, not add a field.

**Instead:** separate *the index* from *the CRDTs*.
- Replicate a **lightweight projection** to the client (`_id`, `fm`, search text, `updated_at`, tombstone flag) over a single workspace-level change feed ("what changed since seq X" — one round trip, not N). Store it in one IndexedDB store. That's ~1× plaintext and is all the offline query engine and MiniSearch actually need.
- Hydrate full `Y.Doc`s **lazily, LRU-bounded** (say 20 open docs) for documents actually opened/edited. Offline editing of a doc you never opened is not a requirement anyone has.
- Make the sync protocol **per-doc subscription with a server-filtered doc feed from day one**. It costs a few days in M2 and makes ACLs a filter on that feed instead of a rewrite. Keep "subscribe to everything" as the v1 default policy if you like — but build the seam.

Note also: with everyone subscribed to everything, "subscribe/unsubscribe per doc id" is vestigial in v1, and every keystroke by any user fans out to every connected device of every user. Fine at 5 users; say so explicitly rather than implying selectivity exists.

### R2. Synchronous materialization on *every applied update* is the system's first hard wall, and the stated justification is a false dichotomy
**Claim (§3.3):** "`fm` is re-parsed… on **every applied update**, and written in the **same Mongo write** as `crdt`/`content` — a query can never observe content and fm out of step."

**Why it's wrong:** per keystroke-ish update you do: apply to `Y.Doc` → re-serialize the **entire** `content` string → rewrite the Mongo doc (crdt blob + content + fm) → maintain the **`$text` index on `content`** (retokenizes the whole field) → maintain the **wildcard `fm.**` index**. That's a full-document rewrite plus two expensive index updates per keystroke, per editor. Two people co-editing one document will saturate this before anything else in the system.

The invariant actually wanted is *"content and fm are consistent with each other,"* which does **not** require *"materialized view equals newest CRDT version."* Those are independent properties and the spec conflates them.

**Instead:** split durability from materialization.
- Synchronous: append the update to the log (durability + broadcast). This is the only latency-critical path.
- Debounced/coalesced per doc (250–1000 ms, forced flush on idle/disconnect): rewrite `content` + `fm` **atomically together**, plus a `materialized_version` (state-vector hash) field so callers can detect staleness.
- REST `GET` can force a flush before responding if a caller needs read-your-writes.

Also: **"Parsing is skipped cheaply when the update didn't touch the block's byte range" is not implementable as stated.** A Yjs update is (client, clock) items, not byte offsets. You can only learn this by applying the update to a loaded doc and observing the `Y.Text` delta — and it's *wrong* whenever the block's boundary moves (insert before the opening `---`, deleting the opening fence, typing `---` early). Rewrite as: "observe the text delta after apply; re-parse if the delta intersects or precedes the block terminator, or if either fence was touched."

### R3. Two YAML parsers (Rust + JS) for an indexed, queryable field is the highest-variance bet in the spec
YAML is the worst possible format for cross-implementation parity, and a divergence here means **the same document appears in a filtered view on one client and not another, or online and not offline**. Divergence surface: YAML 1.1 vs 1.2 implicit typing (`yes`/`no`/`on`/`off`, sexagesimal `12:30` → 750, leading-zero octal), timestamp resolution (ISO-8601 strings require explicitly disabling timestamp resolution, which every library does differently), duplicate keys, anchors/aliases/merge keys `<<`, `!!tags`, integers exceeding i64/f64, `.inf`/`.nan`, block scalars, BOM/CRLF, unquoted strings starting with `*`/`&`/`@`. **`serde_yaml` was archived and deprecated in 2024**; the Rust replacements have *different* quirks from `js-yaml`. A shared test suite documents divergence; it doesn't fix it. "Obsidian-compatible" in practice means "`js-yaml`-compatible with Obsidian's options."

**Instead, pick one:**
1. **Write the parser once in Rust, compile it to Wasm, ship it to the client as part of the kernel.** Parity by construction, forever. Small (general YAML not needed) — the recommended option; also a home for the shared filter evaluator (P4).
2. Define a **strict frontmatter subset** in the spec (block mappings, flow sequences, string/int/float/bool/null scalars only, no anchors/tags/merge keys/multi-doc/block scalars) with a conformance corpus, and hand-write both.

Make the tolerant parser **per-line, stateless**: a malformed line is dropped with a recorded error, remaining keys parse. Deterministic — which the current rule is not (R3b).

### R3b. The "keep last known-good `fm`" rule makes client and server disagree by construction
Stateful fallback: the server has a last-known-good from write history; a client that just cold-booted has none. While someone is mid-edit with an unbalanced quote, server queries return the doc under old fm and a fresh client returns it under empty fm — contradicting §4's "identical offline and online." Per-line tolerant parsing removes the state and the contradiction.

### R4. `fm` is declared derived and read-only, then written through a YAML round-trip + whole-block text replace
**Why it's wrong:**
- **Data loss:** a YAML parse→serialize round-trip destroys comments unconditionally, changes quoting style, reflows multi-line strings, and "key order preserved where possible" means "not preserved" for map-backed deserializers. Users hand-author this block. They will notice.
- **CRDT hostility:** "replace the block" is a large delete+insert. Text CRDTs merge that against a concurrent insert *inside* the deleted range by keeping the orphaned insert — duplicated fragments and half-keys, not clean LWW. A machine-generated corruption path that fires during normal collaboration.
- It's also the **primary write path for M4's proof plugin** (tasks/agenda writing fm) and for `folders` ("move = rewrite `fm.path`"). A folder drag of 200 docs = 200 whole-block rewrites.

**Instead (cheapest consistent rule):** **text-shaped fm is human-owned; machines write `plugins.*`.** Drop `fm` from `PATCH` and from `update_document`, or restrict it to *minimal splices* (replace only the single key's value span — requires a CST-preserving parser; the JS `yaml` package has one, Rust does not — another argument for R3 option 1). If `folders` must be Obsidian-portable via `fm.path`, do the splice client-side as one batched transaction, and specify escaping for `/` in names plus path+name collision behavior.

### R5. The design requires single-writer per-doc ownership; the deployment section implies a scalable Deployment
The server must keep hot `Y.Doc`s in memory behind a per-doc owner (actor/mutex) — REST writes, WebSocket updates, and Wasm plugin writes all apply transactions to the same doc, and a naive read-blob → apply → write-blob loses updates. Once you have in-memory ownership, **two replicas both own the same doc and clients on different pods cannot see each other** — no pub/sub, change-stream fan-out, or sticky routing is specced. The second pod silently breaks collaboration and diverges the materialized view.

**Instead:** state explicitly that v1 is **single-replica, scale vertically** (`replicas: 1`, `strategy: Recreate`), with a per-doc actor owning the `Y.Doc` and optimistic concurrency on the Mongo blob write. The HA seam later is a Mongo change-stream or Redis fan-out on the update log.

### R6. Local-file WebView + cookie sessions do not work together — M5 as specified is blocked
A WebView loaded from `file://` or a custom scheme is a **different origin** from the API server. The session cookie becomes a third-party cookie on every XHR and the WebSocket upgrade: requires `SameSite=None; Secure`, CORS with credentials, `setAcceptThirdPartyCookies` — and modern WebViews are actively hostile to exactly this. Discovered on day one of M5, after the auth model is built around cookies.

**Instead, decide now:** (a) **token auth** for the shell (bearer token in native secure storage, sent on XHR and as a WS subprotocol); or (b) serve the bundle from the server origin + service worker for offline (contradicts the local-file updater's rationale); or (c) intercept requests in the WebView so local assets are served *as* the API origin (`shouldInterceptRequest` / Capacitor's approach — see P8).

Related: two offline-boot mechanisms with different invalidation semantics (service worker for browser, bundle updater for shell) is a permanent tax the spec doesn't acknowledge.

---

## TIER P — significant pain

### P1. The Extism promises are overstated
Traps are caught; **infinite loops and memory growth are not crashes**. Without epoch/fuel interruption, per-call timeouts, and a linear-memory cap, one `while(true)` in a hook pins a thread and a leaky cron plugin OOMs the host. Extism plugin instances are **not reentrant** (`call` takes `&mut self`) — needs a pool or per-plugin mutex, and concurrent `document.changed` across many docs serializes on it. "Hot unload" needs refcounting against in-flight calls. Capability surprise: **"undeclared host functions are simply not linked" means instantiation failure, not call-time failure** — a plugin *optionally* using `http_request` can't install without the capability. Either link erroring stubs, or accept capabilities as install-time hard requirements and say so.

### P2. `markdown.taskState` lives on the client; M4's proof plugin needs it on the server
A Wasm backend plugin cannot see a client-side registry, and to find task items it would need a **third parser** (Rust markdown/task scanner agreeing with the JS remark pipeline). Straight contradiction between two decided sections.

**Instead:** make **agenda a frontend plugin** — it has every document locally and the live registry. Honest question raised: given full client replication + client query engine, a Wasm backend plugin's real niche is **cron while nobody is looking, outbound HTTP with secrets, inbound webhook routes**. Scope host functions to that; reconsider M4's priority (P11). Second-order: marker semantics come from the plugin registry, so `[-]` means "cancelled" on one client and "literal text" on another — **two users can get different task counts from the same document**. Accept and document, or reserve a fixed core marker set.

### P3. The import map must contain the base plugins' internals, which breaks "any row is replaceable"
The singleton list can't stay small: `react/jsx-runtime`, `react-dom/client`; `editor.extension` accepts CodeMirror/Lezer objects so **`@codemirror/state`, `@codemirror/view`, `@lezer/*` must be singletons** (CM6 breaks with duplicate `@codemirror/state`); `markdown.remark` couples `unified`/`remark-*`/`mdast` versions. The kernel's public contract ends up pinning **CodeMirror and remark** — you cannot replace the `editor` row with a non-CodeMirror editor without a kernel change. Also: **import maps cannot be extended after page load**, so the full map must be computed server-side pre-render, and **plugins cannot bring their own version of a shared library** — the server must resolve shared-library semver ranges across all plugins into one version. §6.1's resolver only resolves *plugin* dependencies; this is unscheduled work.

**Instead:** admit a **"blessed runtime" layer** — kernel API + a versioned set of shared libraries declared in manifests as `peerLibraries` with ranges, resolved by the server into one import map. Replaceability claims then become accurate (replace `editor` with another CodeMirror-based editor; replacing the runtime layer is a kernel-major event).

### P4. Mirroring "a Mongo-operator subset" is a parity tarpit
The chosen operators carry Mongo's hardest semantics: implicit array traversal, type bracketing, `{x: null}` matching missing and null, `$ne`/`$nin` as "no element matches", dotted paths incl. numeric segments, `$in` with regexes, mixed-type sort order, arrays-sort-by-min/max. This is why `sift.js` has its bug history.

**Instead: own the language.** Define a small filter DSL with unambiguous documented semantics (same-type comparisons only, explicit `contains`/`any`, explicit `missing` vs `null`, explicit date type), evaluate directly on the client, **compile to a Mongo query** server-side. With R3 option 1, ship *one* evaluator (Rust→Wasm) to both sides. Also: the `fm.**` wildcard index serves one predicate path at a time and cooperates badly with `$or`, `$ne`, `$exists:false`, and filter+sort combos — expect COLLSCANs.

### P5. Capped collection for `document_updates` makes the expensive fallback fire unpredictably
Capped collections evict **globally, oldest-first across all documents** — one busy document's churn evicts everyone else's recent updates, triggering full-state fallback constantly and inexplicably. They also restrict deletes/updates.

**Instead:** a normal collection with **per-doc trimming** (last K updates or N bytes per `_id`, or TTL). Or drop the log for v1 — `encode_state_as_update(&state_vector)` against the compacted blob already serves the sync path; the log is a write-amplification optimization, frame it as such.

### P6. Tombstone purge + long-offline client resurrects deleted documents
A client offline past the purge window holds the `Y.Doc` locally; on reconnect the server has no deletion record, so the doc looks like an offline creation and is re-uploaded.

**Instead:** never purge tombstones in v1 (~50 bytes each; a million deletions is 50 MB), and the client rule: a doc present locally but tombstoned server-side is dropped locally, not re-uploaded.

### P7. Four mis-cut seams in the base distribution
- **`commands`/`keybindings` split creates a cycle** (palette must show bindings; keybindings arbitrate command defaults) and §6.1 rejects cycles. **Merge them.**
- **`viewer` owns `document.mode` while being a peer of `editor`** — replace `viewer` and you delete the registry `editor` contributes to. Move `document.mode` to `shell-ui`/`router` or a thin `document-surface` plugin; `viewer` and `editor` become pure contributions. (M3's acceptance test should also check `viewer` is replaceable.)
- **`themes` owns token values** — with `themes` uninstalled nothing has a value and everything renders unstyled; it's kernel with extra indirection. Ship default token values in the kernel; `themes` overrides.
- **`search`'s "default provider is server full-text" contradicts §4** ("the PWA does not depend on server query endpoints"). Local index is the default; server provider is fallback/integration.

Also: **no base plugin owns a frontmatter editing UI**, yet `fm` is the substrate for filtering, `folders`, `calendar`, agenda. Hand-typed YAML with no schema/autocomplete/validation is a usability cliff in front of the flagship feature; promote the properties panel to the base set.

### P8. Flutter is the least-justified choice in the spec
Needed: a WebView, local asset serving, an OTA updater, a bridge with two capabilities. Flutter adds a Dart runtime and rendering engine that are never used, a fourth language/toolchain in CI, and provides the WebView via a third-party package. **Capacitor** *is* this product (native shell + WebView + typed bridge, `@capacitor/filesystem` and `@capacitor/local-notifications` prebuilt, a configured server origin that **solves R6's cookie problem**, live-update tooling, iOS nearly free). **Tauri v2** covers mobile with a **Rust** bridge — the shared parser/evaluator crate could run in server and shell. The only argument for Flutter is future native UI, which §7 explicitly disclaims. Also note: apps loading remote ES modules + Wasm into a WebView draw scrutiny under Play's Device-and-Network-Abuse policy and Apple's dynamic-code rules — relevant to plugin distribution, not just the shell.

### P9. No CSS isolation and no error-boundary contract for third-party UI
Plugin A's `<style>` restyles plugin B's panel; one throwing contribution white-screens the app. **Mandate:** per-plugin class/custom-property prefix or shadow-DOM-per-mount; kernel wraps every `contribute()`d component in an error boundary + Suspense with defined degraded rendering; add a `deactivate`/dispose contract (currently "uninstall reverses the process" is false on the client, and plugins leak listeners).

### P10. Microkernel purity is already violated, so it can't adjudicate — and it kills notifications
The server already knows: markdown (materializes, text-indexes), YAML frontmatter, the `attachment://` scheme (orphan scanner parses document text), ULIDs, the filter DSL. A rule already broken can't decide future cases, and it will be used to block useful things. **Reframe:** "the kernel knows exactly one domain model — a document is text + frontmatter + namespaced plugin data — and nothing above it." Move the attachment orphan scanner into a plugin hook. **Concrete casualty: notifications.** WebView-local notifications only fire while the app runs — useless for "remind me about `fm.due`". Real reminders need server push, which needs per-user device-token registration — fits neither of §2's two purposes. Either add device registration as a kernel concern now, or drop `notifications` from v1 capabilities.

### P11. M1 builds a model it discards; M4 is ordered ahead of its value
- **M1 "no CRDT yet"** writes the REST semantics twice, and the second version silently changes behavior (`PUT`/`PATCH` become CRDT transactions). yrs for "one doc, apply, materialize" is a day or two. **Put the CRDT in from the first commit; skip the WebSocket in M1 instead.**
- **M3's** real acceptance test: **a plugin authored outside the monorepo, against published typings, adding a directive + a `document.mode` + a sidebar panel + a command, with zero kernel changes.** M3 also silently depends on P3's shared-library resolution work.
- **M4 before M5** spends most effort on least user-visible value, and its proof plugin doesn't need the backend (P2). Reorder: PWA → shell (or stay PWA-only for v1) → Wasm host, with **calendar/ICS import** as the backend proof plugin (cron + outbound HTTP is the genuinely backend-only niche).
- **No milestone validates R1/R2.** Add an explicit gate: *5,000 documents, 3 concurrent editors, cold boot and steady-state memory measured in an Android WebView on mid-range hardware* — the single most valuable line that could be in §9.

### P12. `http` as a boolean capability, and an install path with no approval
- The **directory-watch path has no approval step** — §11's "surfaced in the directory watch log" is retroactive logging. Require explicit admin confirmation for a newly-seen plugin's capability set, or state that volume access = full trust.
- **`http` as a flat boolean = unrestricted egress** + `query_documents` (whole workspace) = one-line exfiltration and SSRF. Minimum: **parameterized capabilities** — `"http": {"hosts": [...]}` — with RFC1918/link-local/metadata blocking by default. Flat string capabilities cannot be widened later without breaking every manifest.
- `call_plugin` is an unversioned RPC surface; runtime A→B→A **deadlocks** under per-plugin mutexes. Specify: callees must be declared dependencies, no reentrancy, hard depth limit.
- `emit_client` broadcasts to **all** clients — a plugin cannot notify one user (the primary notification use case). Add an optional user target now.

### P13. yrs/Yjs compatibility details to pin in the spec
- **Offset kind:** yrs's default `OffsetKind` is not UTF-16; Yjs is UTF-16 throughout. Index-based operations corrupt documents containing emoji/CJK if these disagree. Set yrs to UTF-16 explicitly, in the spec.
- **Update encoding v1 vs v2** must match on both sides, in the stored blob, the log, and the REST representation.
- **Awareness:** yrs core doesn't implement it — name a crate, or decide "the server relays awareness frames opaquely without parsing them" (the right microkernel answer, costs nothing).
- GC settings must match between client and server.

### P14. Per-user `settings` has no home
§6.4 promises per-plugin per-user KV; §3.3's collections have only `plugin_kv` (per-plugin). It needs offline sync too. Options: (a) settings **are documents** (one per user per plugin) → sync/offline/history free, but visible to everyone in the shared pool (say so); (b) a `user_settings` collection + new per-user sync channel. (a) is nearly free.

### P15. Attachments: lazy fetch contradicts the offline claim; orphan scan misses plugin refs
"Cached so referenced files work offline" + "fetched lazily on first render" can't both be true — a doc first opened offline shows broken images. Opt-in background prefetch with a size budget; define degraded behavior (placeholder chip). And orphan detection scans only materialized `content` — an attachment referenced only from `plugins.*` is falsely flagged. Scan `plugins` too or add a "pin attachment" host function.

---

## TIER S — precision

- **Frontmatter fence under-defined:** `---` as thematic break on line one, body starting with `---` right after the block, `...` terminator, CRLF, BOM, must-be-first-byte. Client and server must agree byte-for-byte.
- **ISO date strings sort lexicographically only if same shape** — `2026-01-01` vs `…T10:00Z` vs `…+02:00` don't sort correctly against each other. Normalize on materialization or type dates in the DSL.
- **`state_vector` is a cache** derivable from `crdt` — mark it as such, require same-write consistency.
- **ULID "time-ordered"** = device-clock-ordered for client-minted ids; skewed phones sort into last year; ids leak creation time.
- **`updated_by` is ill-defined under merge** — "last applier" is not authorship; affects the snapshot `user` field presented as attribution.
- **Snapshot cadence tied to compaction** makes history density an accident of edit volume. Decouple: snapshot on time/change policy (first edit after quiescence + daily cap).
- **Restore replaces whole text** — same hazard as R4 under concurrency; unspecified whether restore includes `fm`/`plugins`.
- **`Accept: application/octet-stream` content negotiation** — harder to cache/proxy/curl than `?format=crdt` or a sub-path.
- **RFC 7386 can't set null** (null = delete) and can't address array elements — every tag edit rewrites the whole array.
- **MiniSearch is in-memory only** — whole-workspace rebuild on cold start is seconds of main-thread work; needs persistence + incremental update or a Worker.
- **WebSocket auth at upgrade only** — long-lived sockets outlive session expiry; specify re-validation.
- **Delete "there are no remaining open questions — the spec is fully decided."** Demonstrably false (per-user settings, CSS isolation, shared-library resolution, awareness, offset kind, multi-replica, capability parameterization), and it discourages exactly the flagging the project needs. Replace with a **Known Risks** section naming R1–R6.

---

## The three things to change before writing more code

1. **Split the client's index from the client's CRDTs** (R1): lightweight projection replicated over one workspace change feed; full `Y.Doc`s hydrated lazily, LRU-bounded; per-doc subscription with a server-filtered feed from day one. The one decision that, left as written, invalidates the shell milestone and the ACL roadmap simultaneously.
2. **One frontmatter parser and one filter evaluator, written once in Rust and shipped to the client as Wasm** (R3, P4). Converts the two highest-variance parity bets into non-issues; less total work than two implementations plus a parity suite.
3. **Stop treating `fm` as a machine-writable field** (R4): human-owned text in, machine data into `plugins.*`, materialization debounced-but-atomic (R2). Removes the data-loss path, the CRDT-corruption path, and the write-amplification wall in one move.
