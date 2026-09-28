# Build contracts

**[M1 contracts](#m1-build-contracts) — [M2 contracts](#m2-build-contracts-sync)**

M1 is built and green. M2 adds the sync layer; its section is at the end of this
file and *amends* the rules below rather than replacing them.

## M1 build contracts

Five builder areas fill in this scaffold in parallel. The tree already compiles:
every function exists, every signature is final, every body is `todo!()`.

**The three rules**

1. **Never edit a file owned by another area.** If you need a change there, say so
   in your report — do not make it.
2. **Never change a signature in `domain.rs`, `state.rs`, `error.rs`, or the
   `DocStore` trait and its types in `docstore.rs`.** Those are frozen contracts;
   other areas are compiling against them right now. Adding an *optional* field
   to a `serde` struct in `domain.rs` is the one exception, and it still gets
   announced.
3. **Never edit `Cargo.toml`, `Cargo.lock`, or add a dependency.** Everything M1
   needs is already declared (see [Dependencies](#dependencies)). If something is
   genuinely missing, report it instead of adding it.

Supporting rules:

- Don't add modules to `crates/server/src/lib.rs` — a new module needs an owner.
- Don't create `mod.rs`-level re-exports of another area's items.
- `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`
  must stay clean: `mise run check` is the gate.
- SPEC.md is authoritative. Where a doc comment and the spec disagree, the spec
  wins and the doc comment is a bug — report it.
- M1 scope is SPEC §9 M1 only: **no WebSocket, no Extism plugin host, no
  frontend, no Flutter.** Places where M2+ will plug in are marked in comments;
  leave them as comments.

---

## Layout

```
backend/
├── Cargo.toml                  # workspace (frozen)
├── Cargo.lock                  # frozen
├── Dockerfile                  # multi-stage build           [ops]
├── CONTRACTS.md                # this file
└── crates/
    ├── core/                   # shared core, no server deps [core]
    │   ├── Cargo.toml          # frozen
    │   └── src/
    │       ├── lib.rs          # module list + re-exports
    │       ├── limits.rs       # hardening caps (constants)
    │       ├── diagnostics.rs  # per-line parse diagnostics
    │       ├── value.rs        # Value / Map / ValueType, bson + json bridges
    │       ├── date.rs         # ISO-8601 Date, canonical form
    │       ├── error.rs        # CoreError
    │       ├── document.rs     # Span, ParsedDocument, parse_document
    │       ├── frontmatter.rs  # `---` block: fences, strict-subset parse, spans
    │       ├── sections.rs     # `%%%` machine sections
    │       ├── title.rs        # title resolution
    │       ├── splice.rs       # minimal text splices (TextEdit)
    │       └── filter/
    │           ├── mod.rs      # re-exports
    │           ├── ast.rs      # Filter AST + JSON wire form
    │           ├── evaluator.rs# evaluation over a projection Row
    │           └── mongo.rs    # compile to Mongo (feature `mongo`)
    └── server/
        ├── Cargo.toml          # frozen
        └── src/
            ├── main.rs         # wiring + CLI only          [ops]
            ├── lib.rs          # module list (frozen)
            ├── config.rs       # env config                 [ops]
            ├── telemetry.rs    # tracing, metrics, signals  [ops]
            ├── error.rs        # AppError -> IntoResponse    FROZEN
            ├── state.rs        # AppState                    FROZEN
            ├── domain.rs       # Mongo document shapes       FROZEN
            ├── docstore.rs     # yrs storage engine         [docstore] (trait FROZEN)
            ├── db/
            │   ├── mod.rs      # connect, Collections, names[ops]
            │   ├── migrations.rs                            [ops]
            │   └── indexes.rs  # the one index list         [ops]
            ├── auth/
            │   └── mod.rs      # extractors, sessions, argon2, rate limit [auth]
            ├── routes/
            │   ├── mod.rs      # router assembly            [http-routes]
            │   ├── health.rs                                [ops]
            │   ├── auth.rs                                  [http-routes]
            │   ├── documents.rs                             [http-routes]
            │   ├── attachments.rs                           [http-routes]
            │   └── admin.rs                                 [http-routes]
            └── seed.rs         # first-run welcome docs     [http-routes]
```

Root of the repo: `docker-compose.yaml`, `mise.toml`, `.env.example` — **[ops]**.

---

## Area: core

**Owns:** everything under `backend/crates/core/` except `Cargo.toml`, plus
`backend/crates/core/tests/**` and a conformance corpus under
`backend/crates/core/corpus/**` (SPEC §9 M1: "shared-core crate + conformance
corpus").

**Must not touch:** anything under `crates/server/`.

Hard requirements from the spec:

- Strict YAML subset only (SPEC §3.4): block mappings, flow sequences, scalars
  typed string/int/float/bool/null. No anchors, aliases, merge keys, tags,
  multi-doc, block scalars. Duplicate keys: **last wins**.
- **Per-line tolerant and stateless:** a malformed line is dropped and recorded
  in `diagnostics`; the remaining keys parse. Every function must be total and
  deterministic — the same input yields the same output on client and server.
- Caps in `limits.rs` are enforced at parse. Keys must match
  `^[A-Za-z0-9_-]{1,64}$`; non-conforming keys are dropped from `fm` (text
  untouched) and `fm_parse_error` is set.
- Fence rules byte-exact: frontmatter opens only if `---` is the literal first
  line and closes at the next `---` line; CRLF normalized; BOM stripped only.
  `%%%` sections are the **last contiguous run** of fences at end of document.
- Title: `fm.title` → first ATX heading → first non-empty body line (120 chars)
  → `"Untitled"`.
- Filter DSL is **ours, not Mongo's** (SPEC §4.2): same-type comparisons only,
  explicit `contains`/`any`, explicit `missing` vs `null`, explicit date type.
  `filter::mongo::compile` must produce queries whose results match
  `filter::evaluator::evaluate` exactly — that equality is the contract, and the
  conformance corpus must cover it.
- `mongo` is a **feature**: `bson` may only be used inside
  `#[cfg(feature = "mongo")]` code. `mise run wasm-check`
  (`cargo check -p life-manager-core --no-default-features`) must stay green —
  that build is what becomes Wasm in M2.

**Public API (implement exactly these):**

```rust
// limits.rs — constants; do not change the values
MAX_FRONTMATTER_BYTES: usize = 64 * 1024;  MAX_FRONTMATTER_KEYS: usize = 200;
MAX_NESTING_DEPTH: usize = 5;              MAX_ARRAY_ITEMS: usize = 1000;
MAX_STRING_VALUE_BYTES: usize = 8 * 1024;  MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
TITLE_FALLBACK_MAX_CHARS: usize = 120;     MAX_MACHINE_SECTIONS: usize = 64;
MAX_SECTION_BYTES: usize = 64 * 1024;      MAX_SECTION_KEYS: usize = 200;
UNTITLED: &str = "Untitled";               MAX_KEY_LEN: usize = 64;
pub fn is_valid_key(key: &str) -> bool;

// value.rs
pub type Map = BTreeMap<String, Value>;
pub enum Value { Null, Bool(bool), Int(i64), Float(f64), Str(String), List(Vec<Value>), Map(Map) }
pub enum ValueType { Null, Bool, Int, Float, Str, Date, List, Map }
impl Value {
    pub fn value_type(&self) -> ValueType;
    pub fn as_str(&self) -> Option<&str>;      pub fn as_bool(&self) -> Option<bool>;
    pub fn as_int(&self) -> Option<i64>;       pub fn as_float(&self) -> Option<f64>;
    pub fn as_list(&self) -> Option<&[Value]>; pub fn as_map(&self) -> Option<&Map>;
    pub fn is_null(&self) -> bool;
    pub fn parse_scalar(raw: &str) -> Value;
    pub fn to_yaml_inline(&self) -> String;
    pub fn to_json(&self) -> serde_json::Value;
    pub fn from_json(value: &serde_json::Value) -> Value;
}
#[cfg(feature = "mongo")] pub fn map_to_bson(map: &Map) -> bson::Document;
#[cfg(feature = "mongo")] pub fn value_to_bson(value: &Value) -> bson::Bson;
#[cfg(feature = "mongo")] pub fn map_from_bson(doc: &bson::Document) -> Map;

// date.rs
pub enum DatePrecision { Date, DateTime }
pub struct Date { /* private: canonical, precision, epoch_millis */ }
pub enum DateError { Malformed, OutOfRange }
impl Date {
    pub fn parse(input: &str) -> Result<Date, DateError>;
    pub fn from_epoch_millis(millis: i64) -> Result<Date, DateError>;
    pub fn canonical(&self) -> &str;
    pub fn precision(&self) -> DatePrecision;
    pub fn epoch_millis(&self) -> i64;
    pub fn looks_like_date(input: &str) -> bool;
    pub fn normalize_str(input: &str) -> String;
}

// diagnostics.rs
pub enum DiagnosticKind { MalformedLine, InvalidKey, DuplicateKey, UnsupportedFeature,
                          LimitExceeded, InvalidValue, UnterminatedFence }
pub struct Diagnostic { pub kind: DiagnosticKind, pub line: u32,
                        pub key: Option<String>, pub message: String }
impl Diagnostic { pub fn new(kind, line: u32, key: Option<String>, message: impl Into<String>) -> Self }

// document.rs
pub struct Span { pub start: usize, pub end: usize }           // UTF-8 byte offsets
impl Span { pub fn new(start, end) -> Self; pub fn len(&self) -> usize;
            pub fn is_empty(&self) -> bool; pub fn slice<'t>(&self, text: &'t str) -> &'t str }
pub struct ParsedDocument {
    pub frontmatter_span: Option<Span>, pub body_span: Span,
    pub fm: Map, pub fm_parse_error: bool,
    pub sections: Vec<MachineSection>, pub plugins: Map,
    pub title: String, pub diagnostics: Vec<Diagnostic>,
}
pub fn parse_document(text: &str) -> ParsedDocument;
pub fn normalize_input(text: &str) -> Cow<'_, str>;
pub fn content_fingerprint(text: &str) -> String;
pub fn edit_affects_metadata(parsed: &ParsedDocument, edited: Span) -> bool;

// frontmatter.rs
pub struct Frontmatter { pub map: Map, pub had_error: bool, pub diagnostics: Vec<Diagnostic> }
pub fn find_block(text: &str) -> Option<(Span, Span)>;         // (outer, inner)
pub fn parse_block(inner: &str, first_line: u32) -> Frontmatter;
pub fn parse(text: &str) -> (Option<(Span, Span)>, Frontmatter);
pub fn value_span(text: &str, key: &str) -> Option<Span>;
pub fn line_span(text: &str, key: &str) -> Option<Span>;

// sections.rs
pub struct MachineSection { pub plugin_id: String, pub span: Span, pub body_span: Span,
                            pub map: Map, pub diagnostics: Vec<Diagnostic> }
pub struct Sections { pub sections: Vec<MachineSection>, pub run_span: Option<Span>,
                      pub diagnostics: Vec<Diagnostic> }
impl Sections { pub fn get(&self, plugin_id: &str) -> Option<&MachineSection>;
                pub fn to_plugins_map(&self) -> Map }
pub fn parse(text: &str) -> Sections;
pub fn key_line_span(text: &str, section: &MachineSection, key: &str) -> Option<Span>;
pub fn insert_point(section: &MachineSection) -> usize;

// title.rs
pub fn resolve(fm: &Map, body: &str) -> String;
pub fn first_heading(body: &str) -> Option<&str>;
pub fn first_non_empty_line(body: &str) -> Option<&str>;
pub fn truncate_chars(input: &str, max_chars: usize) -> &str;

// splice.rs  — edits only; applying them is the caller's job
pub struct TextEdit { pub range: Span, pub text: String }
pub struct SectionLineEdit { pub key: String, pub value: Option<Value> }
pub fn set_frontmatter_value(text: &str, key: &str, value: &Value) -> Result<Vec<TextEdit>, CoreError>;
pub fn remove_frontmatter_key(text: &str, key: &str) -> Result<Vec<TextEdit>, CoreError>;
pub fn splice_section(text: &str, plugin_id: &str, edits: &[SectionLineEdit]) -> Result<Vec<TextEdit>, CoreError>;
pub fn remove_section(text: &str, plugin_id: &str) -> Result<Vec<TextEdit>, CoreError>;
pub fn apply(text: &str, edits: &[TextEdit]) -> String;

// filter/ast.rs
pub struct FieldPath(/* private Vec<String> */);
impl FieldPath { pub fn parse(input: &str) -> Result<FieldPath, FilterParseError>;
                 pub fn segments(&self) -> &[String]; pub fn as_dotted(&self) -> String }
pub enum CompareOp { Eq, Ne, Lt, Lte, Gt, Gte }
pub enum TextMatch { Contains, StartsWith, EndsWith }
pub enum Literal { Bool(bool), Int(i64), Float(f64), Str(String), Date(Date), Null }
pub enum Filter { All, None, And(Vec<Filter>), Or(Vec<Filter>), Not(Box<Filter>),
                  Cmp{field,op,value}, In{field,values}, Contains{field,value},
                  Any{field,op,value}, Every{field,op,value},
                  Missing{field}, IsNull{field}, Exists{field}, Text{field,mode,value} }
pub enum FilterParseError { Json, UnknownField, InvalidFieldPath, InvalidDate,
                            MixedInTypes, TooDeep{limit}, TooManyClauses{limit} }
impl Filter { const MAX_DEPTH: usize = 16; const MAX_NODES: usize = 256;
    pub fn from_json_str(input: &str) -> Result<Filter, FilterParseError>;
    pub fn from_json(value: &serde_json::Value) -> Result<Filter, FilterParseError>;
    pub fn to_json(&self) -> serde_json::Value;
    pub fn validate(&self) -> Result<(), FilterParseError> }
pub enum SortOrder { Asc, Desc }
pub struct SortKey { pub field: FieldPath, pub order: SortOrder }
impl SortKey { pub fn parse(input: &str) -> Result<SortKey, FilterParseError> }  // "f" / "-f" / "f:desc"

// filter/evaluator.rs
pub struct Row<'a> { pub id: &'a str, pub title: &'a str, pub content: &'a str,
                     pub fm: &'a Map, pub plugins: &'a Map,
                     pub created_at: Option<&'a Date>, pub updated_at: Option<&'a Date>,
                     pub deleted_at: Option<&'a Date>,   // added in M5 polish: Trash sorts by it
                     pub deleted: bool }
pub enum FieldRef<'a> { Missing, Present(&'a Value), Str(&'a str), Bool(bool), Date(&'a Date) }
pub enum EvalError { TypeMismatch{field,found,expected}, NotApplicable{field}, UnknownField }
pub fn evaluate(filter: &Filter, row: &Row<'_>) -> Result<bool, EvalError>;
pub fn resolve_field<'a>(row: &Row<'a>, field: &FieldPath) -> FieldRef<'a>;
pub fn compare(field_name: &str, found: FieldRef<'_>, op: CompareOp, literal: &Literal) -> Result<bool, EvalError>;
pub fn compare_rows(a: &Row<'_>, b: &Row<'_>, sort: &[SortKey]) -> std::cmp::Ordering;

// filter/mongo.rs  (feature `mongo`)
pub enum CompileError { UnknownField, Unsupported, NotSortable }
pub fn compile(filter: &Filter) -> Result<bson::Document, CompileError>;
pub fn compile_sort(sort: &[SortKey]) -> Result<bson::Document, CompileError>;
pub fn stored_path(field: &FieldPath) -> Result<String, CompileError>;

// error.rs
pub enum CoreError { DocumentTooLarge{len,limit}, FilterParse, FilterEval, FilterCompile,
                     Date, SpliceTargetMissing(String) }
```

---

## Area: docstore

**Owns:** `crates/server/src/docstore.rs`.

**Frozen inside that file** — implement behind them, never change them: the
`DocStore` trait and every type crossing it (`Materialized`, `WriteOutcome`,
`CrdtState`, `DocStoreStats`, `ListQuery`, `TrashFilter`, `Page`,
`DocStoreError`), plus the pinned constants.

**Must not touch:** `domain.rs`, `db/**` (ask ops for an index), `routes/**`.
You may *read* everything.

Hard requirements (SPEC §3.2, §3.5, §4.3):

- `OFFSET_KIND = OffsetKind::Utf16`, `SKIP_GC = false`, update encoding **v1**
  everywhere, one root `Y.Text` named `TEXT_ROOT = "content"`. Every `Doc` comes
  from `new_doc()` / `doc_options()`.
- Synchronous path per applied update: apply to the hot doc **and** append to the
  update log (durability + the M2 broadcast), then return.
- Materialization is **debounced (~500 ms) but atomic-with-itself**:
  `content`/`title`/`fm`/`plugins`/`materialized_version`/`fm_parse_error` are
  rewritten together and are never inconsistent with each other; they may trail
  the newest CRDT state. Forced flush on idle, subscriber-drop and shutdown.
  `get`/`text` force a flush (read-your-writes); `get_stale` does not.
- Skip re-parsing fm/`%%%` when the post-apply delta doesn't intersect those
  regions or their fences (`core::document::edit_affects_metadata`).
- Writes serialize per document (per-document actor) with optimistic concurrency
  on the Mongo write → `DocStoreError::Contended` on a lost race.
- `document_updates` is a **normal** collection, trimmed per document
  (`UPDATE_LOG_KEEP_BYTES` / `_COUNT`); correctness must never depend on
  retention — fall back to a state-vector sync against `crdt`.
- Snapshots: last 20 + one per day for 30 days, per document, taken on a
  time/change policy, decoupled from compaction.
- Delete is a tombstone (Trash, 30 days); purge removes the row and writes the id
  to `deleted_ids` **forever**. `create` consults the graveyard → `Graveyarded`.
- `crdt` compaction above `CRDT_COMPACT_THRESHOLD_BYTES`, alert above
  `CRDT_ALERT_THRESHOLD_BYTES`; text over `MAX_DOCUMENT_BYTES` → `TooLarge`.
- Emit the metrics named in `telemetry::names` (updates applied, materialize
  latency/failures, rooms, dirty rooms, oversized docs) — ops owns their
  registration, you own the call sites in this file.

**Frozen signatures:**

```rust
pub const TEXT_ROOT: &str = "content";
pub const OFFSET_KIND: OffsetKind = OffsetKind::Utf16;
pub const SKIP_GC: bool = false;
pub fn doc_options() -> yrs::Options;
pub fn new_doc() -> yrs::Doc;

pub struct Materialized { pub content: String, pub title: String,
    pub fm: bson::Document, pub plugins: bson::Document,
    pub fm_parse_error: bool, pub materialized_version: String }
pub fn materialize(text: &str, materialized_version: String) -> Materialized;
pub fn materialize_parsed(parsed: &ParsedDocument, text: &str, materialized_version: String) -> Materialized;
pub fn version_hash(state_vector: &[u8]) -> String;

pub struct WriteOutcome { pub id: Id, pub content: String, pub title: String,
    pub materialized_version: String, pub update: Vec<u8>, pub seq: i64 }
pub struct CrdtState { pub id: Id, pub state: Vec<u8>, pub state_vector: Vec<u8> }
pub struct DocStoreStats { pub rooms: usize, pub dirty_rooms: usize, pub oversized_docs: usize }
pub struct ListQuery { pub filter: Option<bson::Document>, pub sort: Option<bson::Document>,
    pub search: Option<String>, pub cursor: Option<String>, pub limit: u32, pub trash: TrashFilter }
pub enum TrashFilter { Live, Trashed, All }
pub struct Page { pub documents: Vec<Document>, pub next_cursor: Option<String> }
pub enum DocStoreError { NotFound, AlreadyExists, Graveyarded, TooLarge{len,limit}, InvalidId,
    MalformedUpdate, Contended, SnapshotNotFound, SpliceRefused(String), Db, Bson, Other }

/// Computes splice edits from a document's text. Called **once, with the room lock held**.
pub type SpliceFn<'a> =
    &'a (dyn Fn(&str) -> Result<Vec<core::splice::TextEdit>, String> + Send + Sync);

#[async_trait]
pub trait DocStore: Send + Sync + 'static {
    async fn create(&self, id: Option<Id>, text: &str, actor: &Actor) -> Result<WriteOutcome, DocStoreError>;
    async fn replace_text(&self, id: &str, text: &str, actor: &Actor) -> Result<WriteOutcome, DocStoreError>;
    // M4 replaces `apply_edits(id, edits, actor)`. A `TextEdit` is a byte-offset span, and a
    // byte offset only means something against the string it was computed from; the old
    // signature made the caller read the text in one critical section and hand back offsets
    // applied in another, so a concurrent CRDT write in between silently shifted them onto
    // somebody else's text. The closure is called inside the lock, against the text the write
    // lands on. There is deliberately no variant that accepts a precomputed edit list.
    async fn splice(&self, id: &str, compute: SpliceFn<'_>, actor: &Actor) -> Result<WriteOutcome, DocStoreError>;
    async fn apply_update(&self, id: &str, update: &[u8], actor: &Actor) -> Result<WriteOutcome, DocStoreError>;
    async fn text(&self, id: &str) -> Result<String, DocStoreError>;
    async fn get(&self, id: &str) -> Result<Document, DocStoreError>;
    async fn get_stale(&self, id: &str) -> Result<Document, DocStoreError>;
    async fn crdt_state(&self, id: &str) -> Result<CrdtState, DocStoreError>;
    async fn diff(&self, id: &str, since: &[u8]) -> Result<Vec<u8>, DocStoreError>;
    async fn list(&self, query: &ListQuery) -> Result<Page, DocStoreError>;
    async fn count(&self, query: &ListQuery) -> Result<u64, DocStoreError>;
    async fn tombstone(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;
    async fn untombstone(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;
    async fn purge(&self, id: &str, actor: &Actor) -> Result<(), DocStoreError>;
    async fn is_graveyarded(&self, id: &str) -> Result<bool, DocStoreError>;
    async fn snapshot(&self, id: &str, reason: &str, actor: &Actor) -> Result<Id, DocStoreError>;
    async fn snapshots(&self, id: &str) -> Result<Vec<DocumentSnapshot>, DocStoreError>;
    async fn restore_snapshot(&self, id: &str, snapshot_id: &str, actor: &Actor) -> Result<WriteOutcome, DocStoreError>;
    async fn flush(&self, id: &str) -> Result<(), DocStoreError>;
    async fn flush_all(&self) -> Result<(), DocStoreError>;
    async fn evict_idle(&self) -> Result<usize, DocStoreError>;
    fn stats(&self) -> DocStoreStats;
}

// SUPERSEDED IN M2 — `new` now takes `DocStoreTuning` and the `ChangeFeed`, and
// `Page` carries `DocumentRow`s. See "Area: docstore (M2 additions)" below; the
// M1 shape is kept here only so the history of the contract is readable.
pub struct MongoDocStore { /* private */ }
impl MongoDocStore {
    pub fn new(db: mongodb::Database, max_document_bytes: usize) -> Self;
    pub fn spawn_workers(&self) -> DocStoreWorkers;
}
pub struct DocStoreWorkers { /* private */ }
impl DocStoreWorkers { pub async fn shutdown(self); }
```

---

## Area: auth

**Owns:** `crates/server/src/auth/mod.rs`. (If you want to split it into
`auth/session.rs`, `auth/password.rs`, `auth/rate_limit.rs`, that is allowed —
you own the whole `auth/` directory — but `lib.rs` keeps declaring only
`pub mod auth;` and the public paths above must keep working.)

**Must not touch:** `routes/auth.rs` (http-routes calls your functions),
`domain.rs`, `state.rs`, `db/**`.

Hard requirements (SPEC §5.2, §5.3):

- argon2id with **m=19456 KiB, t=2, p=1**.
- Per-IP **and** per-account backoff on failed logins; every attempt written to
  `login_attempts`.
- Browser: HTTP-only, `Secure` (per `COOKIE_SECURE`), `SameSite=Lax`; rolling
  sessions, **30-day idle / 180-day absolute**.
- Shell: **bearer tokens**, supported from M1, sent as `Authorization: Bearer …`.
  Both carriers work on every authenticated route.
- Raw tokens are never stored: the `_id` is the SHA-256 hex of the token.
- A 401 must never imply "clear local data" — it is just a status. (Client-side
  rule, but do not invent a "session invalid, purge" response shape.)
- Extracting `AuthUser` refreshes the session's idle expiry and re-checks
  revocation and `is_active`.

**Public API:**

```rust
pub const TOKEN_BYTES: usize = 32;
pub const BEARER_PREFIX: &str = "Bearer ";
pub enum AuthVia { Cookie, Bearer }

pub struct AuthUser { pub user: User, pub session: Session, pub via: AuthVia }
impl AuthUser { pub fn id(&self) -> &str; pub fn is_admin(&self) -> bool; pub fn actor(&self) -> Actor }
pub struct AdminUser(pub AuthUser);
impl AdminUser { pub fn actor(&self) -> Actor }
pub struct MaybeAuthUser(pub Option<AuthUser>);
// all three: impl FromRequestParts<AppState> with Rejection = AppError
//   AuthUser: 401 when absent/invalid
//   AdminUser: 401 when absent, 403 when not admin
//   MaybeAuthUser: never rejects on absence

pub fn credential_from_parts(parts: &Parts, cookie_name: &str) -> Option<(String, AuthVia)>;
pub fn client_ip(parts: &Parts) -> Option<String>;

pub struct IssuedToken { pub token: String, pub hash: String }
pub fn mint_token() -> IssuedToken;
pub fn hash_token(token: &str) -> String;

pub async fn create_session(state: &AppState, user: &User, kind: SessionKind,
    user_agent: Option<String>, ip: Option<String>) -> Result<(Session, String), AppError>;
pub async fn load_session(state: &AppState, token: &str) -> Result<Option<Session>, AppError>;
pub async fn revoke_session(state: &AppState, session_id: &str) -> Result<(), AppError>;
pub async fn revoke_user_sessions(state: &AppState, user_id: &str) -> Result<u64, AppError>;
pub fn build_session_cookie(state: &AppState, token: &str) -> Cookie<'static>;
pub fn clear_session_cookie(state: &AppState) -> Cookie<'static>;

pub mod password {
    pub const MEMORY_KIB: u32 = 19_456; pub const TIME_COST: u32 = 2;
    pub const PARALLELISM: u32 = 1;     pub const MIN_LENGTH: usize = 10;
    pub fn hash(password: &str) -> Result<String, PasswordError>;
    pub fn verify(password: &str, phc: &str) -> Result<bool, PasswordError>;
    pub fn validate(password: &str) -> Result<(), PasswordError>;
}
pub enum PasswordError { TooShort{min}, Hashing, MalformedHash }   // From<PasswordError> for AppError exists

pub enum RateKey { Account(String), Ip(String), Named{bucket: &'static str, key: String} }
pub struct RateLimiter;
impl RateLimiter {
    pub fn new(max_attempts: u32, window: Duration) -> Self;
    pub fn check(&self, key: &RateKey) -> Result<(), RateLimited>;
    pub fn record_failure(&self, key: &RateKey);
    pub fn record_success(&self, key: &RateKey);
    pub fn sweep(&self);
}
pub struct RateLimited { pub retry_after_secs: u64 }               // From<RateLimited> for AppError exists
```

---

## Area: http-routes

**Owns:** `crates/server/src/routes/mod.rs`, `routes/auth.rs`,
`routes/documents.rs`, `routes/attachments.rs`, `routes/admin.rs`, and
`crates/server/src/seed.rs`. Also `crates/server/tests/**` (integration tests
driving the router).

**Must not touch:** `routes/health.rs` (ops), `auth/**`, `docstore.rs`,
`domain.rs`, `state.rs`, `error.rs`, `db/**`.

You may add request/response structs and private helpers to files you own, and
you may add routes to your own `router()` — but the paths and methods in SPEC
§5.1 are the contract; don't rename them.

Hard requirements:

- Every write that a user can undo or that destroys something writes an
  `AuditEntry` through `state.audit(...)` (SPEC §5.4).
- `POST /api/documents`: existing live `_id` → **409**; graveyarded `_id` → **410**.
  Server stamps timestamps; the client mints the id.
- `PATCH /api/documents/:id` is **body-text-level only** — `{"content": …}`.
  Never accept `fm` or `plugins` patches (SPEC §5.1, §3.3).
- `GET /api/documents/:id` may force a materialization flush;
  `?format=crdt` returns the encoded CRDT state (update encoding v1).
- List queries take the **DSL** (`core::filter`), compile it with
  `core::filter::mongo::compile`, and reject invalid filters with 400. Never pass
  client JSON to Mongo.
- Attachments: streamed to GridFS without buffering, `MAX_ATTACHMENT_BYTES` →
  413 (`0` is no limit; read it through `Config::attachment_limit`), **MIME sniffed** from bytes, `X-Content-Type-Options: nosniff` on every
  response, `Content-Disposition: attachment` except `INLINE_SAFE_TYPES` —
  `image/svg+xml` is never inline. Replace requires `If-Match: <revision>`;
  mismatch → 409; identical `sha256` auto-resolves. Deletion is explicit; orphans
  are only flagged.
- Standalone upload with `wrapper=true` creates a **wrapper document** (SPEC
  §3.6): `fm.title` from the filename, `fm.path` when given, body embedding
  `attachment://<ulid>`.
- Admin: invites 7-day / single-use / non-admin only; last admin cannot be
  demoted or deleted; deleting a user revokes sessions and keeps attribution;
  `GET /api/admin/export` streams a zip of every document as plain markdown.
- Seeding: a few **deletable** welcome documents on first run only, idempotent,
  skipped when the workspace is non-empty.

**Route table (frozen paths):** see the module doc comments in each file; they
mirror SPEC §5.1 exactly.

**Entry point used by ops' `main.rs`:**

```rust
pub fn routes::router(state: AppState, metrics: PrometheusHandle) -> Router;
pub async fn seed::seed_if_needed(state: &AppState, actor: &Actor) -> AppResult<usize>;
pub async fn seed::already_seeded(state: &AppState) -> AppResult<bool>;
```

---

## Area: ops

**Owns:** `crates/server/src/main.rs`, `config.rs`, `telemetry.rs`, `db/mod.rs`,
`db/migrations.rs`, `db/indexes.rs`, `routes/health.rs`, `backend/Dockerfile`,
`docker-compose.yaml`, `mise.toml`, `.env.example`.

**Must not touch:** `routes/{auth,documents,attachments,admin}.rs`, `auth/**`,
`docstore.rs` internals, `domain.rs`, `state.rs`, `error.rs`.

Hard requirements (SPEC §3.5, §5.2, §8):

- `SESSION_SECRET` is **required, ≥ 32 bytes, no default**; the server refuses to
  start without it. `MONGO_URI` required. `MAX_ATTACHMENT_BYTES` default 100 MiB, `0` for no limit.
- Migrations: ordered, idempotent, run at boot under an **advisory lock**; the
  server refuses to start if `meta.schema_version` is newer than the binary.
- **All indexes in one list** (`db::indexes::all`), created idempotently at boot.
  Nothing outside that file calls `create_index`.
- `/healthz` liveness (no Mongo), `/readyz` readiness **with details** (Mongo +
  migrations + plugin load), `/metrics` Prometheus text.
- Logs: `tracing`, **JSON**, request ids.
- Graceful shutdown: SIGTERM → stop accepting → flush dirty rooms → close →
  exit ≤ 30 s. `main.rs` already has the shape; fill in `shutdown_signal`.
- Compose: mongo with a named volume + server built from `backend/Dockerfile`.
  **Caddy is deliberately out of M1** (the server is TLS-unaware and there is no
  PWA to serve yet) — the commented block in `docker-compose.yaml` is the M3
  shape; don't enable it.

**Public API:**

```rust
// config.rs
pub struct Config { pub mongo_uri: String, pub bind_addr: SocketAddr,
    pub session_secret: SessionSecret, pub mongo_database: String,
    pub max_attachment_bytes: u64, pub max_document_bytes: usize,
    pub app_origins: Vec<String>, pub log_format: LogFormat, pub cookie_secure: bool,
    pub trash_retention_days: u32, pub invite_ttl_days: u32,
    pub session_idle_days: u32, pub session_absolute_days: u32,
    pub materialize_debounce: Duration, pub room_idle_timeout: Duration,
    pub update_log_keep_bytes: u64, pub update_log_keep_count: u32,
    pub crdt_compact_threshold_bytes: u64, pub crdt_alert_threshold_bytes: u64,
    pub login_max_attempts: u32, pub login_attempt_window: Duration,
    pub shutdown_grace: Duration, pub seed_welcome_docs: bool }
pub struct SessionSecret;  impl SessionSecret { pub fn new(Vec<u8>) -> Result<Self, ConfigError>;
                                               pub fn as_bytes(&self) -> &[u8] }
pub enum LogFormat { Pretty, Json }
pub enum ConfigError { Missing(&'static str), Invalid{var,reason}, SessionSecretTooShort{len} }
impl Config { pub fn from_env() -> Result<Config, ConfigError>;
              pub fn session_cookie_name(&self) -> &'static str;
              pub fn origin_allowed(&self, origin: &str) -> bool }

// db/mod.rs — collection-name constants, GRIDFS_BUCKET, META_SCHEMA_ID
pub async fn connect(config: &Config) -> anyhow::Result<(Client, Database)>;
pub async fn init_schema(db: &Database) -> anyhow::Result<()>;
pub struct Collections;  // typed accessors: documents(), users(), sessions(), … gridfs(), raw(name)

// db/migrations.rs
pub const SCHEMA_VERSION: i32 = 1;
pub struct Migration { pub version: i32, pub name: &'static str, pub run: fn(&Database) -> MigrationFuture<'_> }
pub fn migrations() -> Vec<Migration>;                 // APPEND ONLY
pub async fn current_version(db: &Database) -> anyhow::Result<i32>;
pub async fn run(db: &Database) -> anyhow::Result<MigrationReport>;
pub async fn with_advisory_lock<F>(db: &Database, holder: &str, body: F) -> anyhow::Result<()>;

// db/indexes.rs
pub struct IndexSpec { pub collection: &'static str, pub model: IndexModel }
pub fn all() -> Vec<IndexSpec>;
pub async fn ensure(db: &Database) -> anyhow::Result<usize>;

// telemetry.rs
pub mod names { /* metric name constants — emitters use these, never literals */ }
pub fn init_tracing(format: LogFormat) -> anyhow::Result<()>;
pub fn init_metrics(config: &Config) -> anyhow::Result<PrometheusHandle>;
pub async fn metrics_handler(State(handle): State<PrometheusHandle>) -> Response;
pub async fn sample_gauges(state: &AppState);
pub async fn shutdown_signal();

// routes/health.rs
pub fn router() -> Router<AppState>;
pub async fn healthz() -> impl IntoResponse;
pub struct ReadyReport { pub ready: bool, pub mongo: CheckResult, pub migrations: CheckResult,
    pub plugins: CheckResult, pub plugin_host: CheckResult,  // `plugin_host` added in M5 polish
    pub schema_version: i32, pub uptime_secs: u64, pub version: &'static str }
pub struct CheckResult { pub ok: bool, pub detail: Option<String>, pub latency_ms: Option<u64> }
pub async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<ReadyReport>);
```

---

## Frozen: `domain.rs`

Mongo document shapes (SPEC §3.5). `_id` is a ULID string; timestamps are
`bson::DateTime`; `*_by` is `Actor::as_stored()` — a user id, `plugin:<id>`, or
`system` — and means "last applier the server saw", not authorship.

```rust
pub type Id = String;
pub fn new_id() -> Id;                     pub fn is_valid_id(id: &str) -> bool;
pub enum Actor { User(Id), Plugin(String), System }
impl Actor { pub fn as_stored(&self) -> String; pub fn user_id(&self) -> Option<&str> }

pub struct Document {           // collection `documents`
    pub id: Id,                            // #[serde(rename = "_id")]
    pub crdt: Binary, pub state_vector: Binary,
    pub content: String, pub title: String,
    pub fm: BsonDocument, pub plugins: BsonDocument,
    pub materialized_version: String, pub fm_parse_error: bool,
    pub created_at: BsonDateTime, pub created_by: Option<String>,
    pub updated_at: BsonDateTime, pub updated_by: Option<String>,
    pub deleted_at: Option<BsonDateTime>, pub deleted_by: Option<String>,
}
pub struct DocumentView { /* Document minus crdt/state_vector */ }   // From<Document>
pub struct DocumentUpdate { pub id, pub document_id, pub seq: i64, pub update: Binary,
                            pub created_at, pub created_by }         // `document_updates`
pub struct DocumentSnapshot { pub id, pub document_id, pub crdt: Binary, pub content,
                              pub title, pub created_at, pub created_by, pub reason }
pub struct GraveyardEntry { pub id, pub deleted_at, pub deleted_by }  // `deleted_ids`

pub struct User { pub id, pub email, pub name, pub password_hash, pub is_admin: bool,
                  pub is_active: bool, pub created_at, pub updated_at,
                  pub last_login_at: Option<_>, pub invited_by: Option<Id> }
pub struct UserView { /* User minus password_hash */ }               // From<User>
pub struct Session { pub id /* sha256(token) */, pub user_id, pub kind: SessionKind,
                     pub created_at, pub last_seen_at, pub expires_at,
                     pub absolute_expires_at, pub user_agent, pub ip }
pub enum SessionKind { Cookie, Bearer }
pub struct Invite { pub id /* sha256(token) */, pub email: Option<String>, pub created_at,
                    pub created_by: Id, pub expires_at, pub used_at, pub used_by, pub revoked_at }
pub struct PasswordReset { pub id /* sha256(token) */, pub user_id, pub created_at,
                           pub created_by, pub expires_at, pub used_at }
pub struct LoginAttempt { pub id, pub email, pub ip, pub succeeded: bool, pub created_at }

pub struct Attachment { pub id, pub name, pub mime, pub size: u64, pub sha256, pub revision: u32,
                        pub gridfs_id: bson::Bson, pub created_at, pub created_by,
                        pub updated_at, pub updated_by, pub deleted_at, pub deleted_by }
pub struct AttachmentView { /* Attachment minus gridfs_id/deleted_* */ }  // From<Attachment>

pub struct AuditEntry { pub id, pub action: String, pub actor: Option<String>,
                        pub target_kind: String, pub target_id: Option<String>,
                        pub detail: BsonDocument, pub ip: Option<String>, pub created_at }
impl AuditEntry { pub fn new(action, actor: Option<&Actor>, target_kind, target_id) -> Self;
                  pub fn with_detail(self, BsonDocument) -> Self;
                  pub fn with_ip(self, Option<String>) -> Self }

pub struct SchemaMeta { pub id, pub schema_version: i32, pub updated_at,
                        pub migration_lock: Option<MigrationLock> }
pub struct MigrationLock { pub holder, pub acquired_at, pub expires_at }
```

## Frozen: `state.rs`

```rust
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub mongo: mongodb::Client,
    pub db: mongodb::Database,
    pub collections: Collections,
    pub docs: Arc<dyn DocStore>,
    pub login_limiter: Arc<RateLimiter>,
    pub readiness: Arc<Readiness>,
}
pub struct Readiness { pub migrations_complete: AtomicBool,
                       pub schema_version: AtomicI32, pub started_at: Instant }
impl AppState {
    pub async fn new(config: Config) -> anyhow::Result<AppState>;   // [ops] implements
    pub fn config(&self) -> &Config;
    pub async fn audit(&self, entry: AuditEntry);                   // [ops] implements
}
```

`AppState::new` and `AppState::audit` are implemented by **ops**; everyone else
only calls them.

## Frozen: `error.rs`

Every handler returns `AppResult<T>`; `AppError` is the only error type that
reaches axum, and its `IntoResponse` is the only place a status code is chosen.
5xx messages are never leaked to clients.

```rust
pub type AppResult<T> = Result<T, AppError>;
pub enum AppError {
    BadRequest(String),                     // 400
    Unauthorized,                           // 401
    Forbidden,                              // 403
    NotFound(&'static str),                 // 404
    Conflict(String),                       // 409
    Gone(String),                           // 410  (graveyard)
    PreconditionFailed{expected: u32, provided: u32},  // 412
    PreconditionRequired,                   // 428  (If-Match missing)
    PayloadTooLarge{len: u64, limit: u64},  // 413
    UnsupportedMediaType(String),           // 415
    Unprocessable(String),                  // 422  (domain rule)
    TooManyRequests{retry_after_secs: u64}, // 429  (+ Retry-After)
    Unavailable(String),                    // 503
    Core(CoreError), DocStore(DocStoreError), Db(mongodb::error::Error),
    Bson(bson::ser::Error), BsonDe(bson::de::Error), Internal(anyhow::Error),  // 500
}
pub enum ErrorCode { /* snake_case, stable, client-visible */ }
// wire shape: { "error": { "code": "...", "message": "...", "detail": { … } } }
impl AppError { pub fn status(&self) -> StatusCode; pub fn code(&self) -> ErrorCode;
                pub fn detail(&self) -> Option<serde_json::Value>; pub fn is_internal(&self) -> bool;
                pub fn bad_request(..) -> Self; pub fn conflict(..) -> Self; pub fn unprocessable(..) -> Self }
```

`status()`, `code()` and `detail()` are `todo!()` — **ops** fills them in (they
are pure mapping functions); nobody else edits this file.

---

## Dependencies

Already declared; do not add or bump.

`core`: `serde`, `serde_json`, `thiserror`, `time`, `bson` (optional, feature
`mongo`, default on — turn it **off** for the Wasm build).

`server`: `axum` (multipart, macros), `axum-extra` (cookie, typed-header),
`tokio` (full), `tower` (util, timeout, limit), `tower-http` (trace, cors, limit,
timeout, request-id, catch-panic), `mongodb`, `bson`, `futures`, `yrs`, `serde`,
`serde_json`, `thiserror`, `anyhow`, `argon2`, `rand`, `sha2`, `ulid`, `time`,
`tracing`, `tracing-subscriber` (env-filter, json), `metrics`,
`metrics-exporter-prometheus`, `async-trait`, `base64`, `hex`, `infer`, `bytes`,
`tokio-util` (io), `dotenvy`, `zip`, `clap` (derive, env), `life-manager-core`.

Pinned by the resolver: `bson 2.15` (mongodb 3.9's bson — **not** bson 3),
`yrs 0.28`, `axum 0.8`.

## Commands

```
mise run check        # fmt --check + cargo check --all-targets + clippy -D warnings
mise run test         # cargo test --workspace --all-targets
mise run wasm-check   # core without the mongo feature (the future Wasm build)
mise run dev          # compose mongo + cargo run
mise run up / down / logs
```

`mise run check` must pass before you report done. If your area cannot compile
without another area's file changing, stop and report it — that is a contract
problem, not a code problem.

---

# M2 build contracts (sync)

**Scope: SPEC §9 M2 only** — change feed + projection replication, per-document
CRDT sync over WebSocket, lazy hydration, the offline PWA skeleton (IndexedDB +
local query engine + Wasm core), the bootstrap endpoint, and the convergence
harness. **No microkernel or plugin loader (M3), no Extism (M4), no Flutter (M5),
no React anywhere.**

[`PROTOCOL.md`](PROTOCOL.md) is authoritative for everything on the wire. Server
and client implement it independently; where an implementation and that document
disagree, the document is the bug report, and where the document and
[`../SPEC.md`](../SPEC.md) disagree, the SPEC wins.

The three M1 rules still hold (don't edit another area's files; don't change a
frozen signature; report instead of improvising). One amendment: **dependencies
were added by the scaffold** — `axum` gained the `ws` feature and
`life-manager-core` gained an optional `wasm-bindgen` behind the new `wasm`
feature. Nothing else may be added.

## New and changed layout

```
backend/
├── PROTOCOL.md                     # the wire protocol                 FROZEN
└── crates/
    ├── core/src/wasm.rs            # wasm-bindgen ABI (feature `wasm`) [wasm]
    └── server/src/
        ├── feed.rs                 # change feed: seq + notices + queries [sync]
        └── routes/sync.rs          # /api/sync + /api/sync/bootstrap     [sync]

web/                                # see web/CONTRACTS.md for its areas
```

Root: `mise.toml` gained `wasm`, `web`, `web-check`, `harness` — **[ops]**.

## Area: sync (server)

**Owns:** `crates/server/src/feed.rs`, `crates/server/src/routes/sync.rs`.

**Must not touch:** `docstore.rs` (ask docstore), `db/**` (ask ops), `auth/**`,
`domain.rs`, `state.rs`, `error.rs`, other `routes/*`.

Hard requirements (SPEC §4.1, §4.3; PROTOCOL.md §§1–7):

- **Auth at upgrade only.** Cookie, `Authorization: Bearer`, or the
  `life-manager.bearer.<token>` subprotocol — the last of which
  `auth::credential_from_parts` already resolves. Origin is checked **before**
  authentication, and a cookie connection with no `Origin` is refused.
- Session revalidated every 5 min ± jitter → close **4401**. `4401` never implies
  "clear local data" (SPEC §5.3) — do not invent a response that says otherwise.
- **`safe_seq` comes from in-flight allocations**, never from `max(committed seq)`
  (`FeedSequencer::safe_seq`, and the reasoning is in the `feed.rs` module docs).
  Every feed message carries it; clients persist it.
- Bounded send queues; on overflow **drop and instruct a resync**
  (`feed.resync` / `doc.resync`). Never grow a buffer, never block the writer.
- Max frame 4 MiB both ways; inbound rate caps; ≤ 32 doc subscriptions and ≤ 8
  sockets per session.
- Awareness frames are **relayed opaquely** — never parsed, never persisted,
  never replayed to late joiners (SPEC §3.2).
- Fan-out reaches every subscriber **except** the originator. All writes go
  through `DocStore` so the per-document actor still serializes them.
- Bootstrap is **streamed** NDJSON, paged by `_id`, with `safe_seq` pinned on the
  first page and echoed on every page. Never buffer a page set in memory.

**Frozen signatures** (implement behind them):

```rust
// feed.rs
pub const FEED_SEQ_START: i64 = 1;
pub const NOTICE_CHANNEL_CAPACITY: usize = 1024;
pub const FEED_BATCH_MAX_ROWS: u32 = 1000;      pub const FEED_BATCH_DEFAULT_ROWS: u32 = 200;
pub const FEED_CATCHUP_MAX_ROWS: u64 = 500;
pub const BOOTSTRAP_DEFAULT_LIMIT: u32 = 200;   pub const BOOTSTRAP_MAX_LIMIT: u32 = 1000;

pub enum FeedChangeKind { Upsert, Tombstoned, Restored, Purged }
pub struct FeedNotice { pub seq: i64, pub id: Id, pub kind: FeedChangeKind }
pub struct FeedRow { /* PROTOCOL.md §2.1, RFC 3339 timestamps, `purged` flag */ }
impl FeedRow {
    pub fn from_row(row: DocumentRow, include_content: bool) -> Option<Self>; // None ⇒ no feed_seq
    pub fn purged(seq: i64, id: Id, deleted_at: Timestamp, deleted_by: Option<String>) -> Self;
}
pub struct FeedPage { pub rows: Vec<FeedRow>, pub safe_seq: i64, pub head_seq: i64, pub complete: bool }
pub struct BootstrapPage { pub rows: Vec<FeedRow>, pub next_cursor: Option<String>, pub complete: bool }
pub enum FeedError { Db(mongodb::error::Error), Bson(String), SeqAhead { since: i64, head: i64 } }

pub struct FeedAllocation;              // RAII: commit() publishes, Drop burns the number
impl FeedAllocation { pub fn seq(&self) -> i64; pub fn id(&self) -> &str;
                      pub fn commit(self, kind: FeedChangeKind); }

pub struct FeedSequencer;               // no database half; unit-tested
impl FeedSequencer {
    pub fn new() -> Arc<Self>;          pub fn set_head(&self, seq: i64);
    pub fn head_seq(&self) -> i64;      pub fn safe_seq(&self) -> i64;
    pub fn allocate(self: &Arc<Self>, id: Id) -> FeedAllocation;
    pub fn subscribe(&self) -> broadcast::Receiver<FeedNotice>;
    pub fn subscriber_count(&self) -> usize;
}

pub struct ChangeFeed;
impl ChangeFeed {
    pub fn new(collections: Collections) -> Arc<Self>;
    pub async fn initialize(&self) -> Result<i64, FeedError>;            // todo!()
    pub fn allocate(&self, id: Id) -> FeedAllocation;
    pub fn head_seq(&self) -> i64;   pub fn safe_seq(&self) -> i64;
    pub fn subscribe(&self) -> broadcast::Receiver<FeedNotice>;
    pub fn subscriber_count(&self) -> usize;
    pub fn sequencer(&self) -> &Arc<FeedSequencer>;
    pub async fn count_since(&self, since_seq: i64) -> Result<u64, FeedError>;       // todo!()
    pub async fn rows_since(&self, since_seq: i64, limit: u32,
                            include_content: bool) -> Result<FeedPage, FeedError>;  // todo!()
    pub async fn bootstrap_page(&self, cursor: Option<&str>, limit: u32, trash: TrashFilter,
                                include_content: bool) -> Result<BootstrapPage, FeedError>; // todo!()
    pub async fn bootstrap_total(&self, trash: TrashFilter) -> Result<u64, FeedError>;       // todo!()
    pub fn trash_filter(trash: TrashFilter) -> bson::Document;
    pub fn collections(&self) -> &Collections;
}
pub async fn collect_rows(cursor: mongodb::Cursor<DocumentRow>,
                          include_content: bool) -> Result<Vec<FeedRow>, FeedError>;

// routes/sync.rs
pub const PROTOCOL_VERSION: u32 = 1;
pub const SUBPROTOCOL: &str = "life-manager.v1";
pub const BEARER_SUBPROTOCOL_PREFIX: &str = "life-manager.bearer.";
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SUBSCRIPTIONS: usize = 32;      pub const MAX_SOCKETS_PER_SESSION: usize = 8;
pub const FEED_QUEUE_MESSAGES: usize = 64;    pub const DOC_QUEUE_FRAMES: usize = 256;
pub const INBOUND_FRAMES_PER_SEC: u32 = 200;  pub const INBOUND_BYTES_PER_SEC: u64 = 2 << 20;
pub const HEARTBEAT_SECS: u32 = 25;
pub const SESSION_REVALIDATE_SECS: u64 = 300; pub const SESSION_REVALIDATE_JITTER_SECS: u64 = 60;
pub const TAIL_COALESCE_MS: u64 = 50;
pub mod close { /* 4400 4401 4403 4408 4409 4413 4429 4503 */ }
pub mod frame { /* 0x01 STEP1, 0x02 STEP2, 0x03 UPDATE, 0x04 AWARENESS, 0x05 AWARENESS_QUERY,
                   0x10 RESERVED_FLOOR */ }
pub fn router() -> Router<AppState>;                        // /sync, /sync/bootstrap
pub async fn upgrade(State<AppState>, HeaderMap, AuthUser, WebSocketUpgrade) -> AppResult<Response>;
pub fn origin_allowed(&AppState, &HeaderMap, AuthVia) -> bool;
pub fn offers_subprotocol(&HeaderMap) -> bool;
pub struct BootstrapParams { cursor, limit, trash, include_content, probe }
pub struct BootstrapHeader { .. }   pub struct BootstrapFooter { .. }
pub async fn bootstrap(State<AppState>, AuthUser, Query<BootstrapParams>) -> AppResult<Response>; // todo!()
pub fn ndjson_headers() -> [(HeaderName, &'static str); 3];
pub fn map_feed_error(FeedError) -> AppError;
```

### Added by M2 integration (hardening pass)

Additive only — nothing above changed shape. The four hooks are what let other areas
reach the socket registry without `AppState` growing a field:

```rust
// routes/sync.rs — new ceilings (PROTOCOL.md §1.3, §6)
pub const MAX_SOCKETS_PER_USER: usize = 16;   pub const MAX_SOCKETS_TOTAL: usize = 512;

// routes/sync.rs — hooks other areas call
pub fn publish_update(&AppState, id: &str, update: &[u8]);      // REST/restore fan-out
pub fn document_subscribers(&AppState, id: &str) -> usize;      // the restore warning
pub fn close_session_sockets(&AppState, session_id: &str) -> usize;
pub fn close_user_sockets(&AppState, user_id: &str) -> usize;
pub fn close_user_sockets_except(&AppState, user_id: &str, keep_session_id: &str) -> usize;

// feed.rs — the streaming read the bootstrap route uses, and the catch-up byte bound
pub async fn bootstrap_cursor(&self, cursor: Option<&str>, limit: u32, trash: TrashFilter,
                              include_content: bool) -> Result<Cursor<DocumentRow>, FeedError>;
pub const FEED_PAGE_MAX_BYTES: usize = 2 << 20;   // `rows_since` stops reading here

// state.rs — migrations + index creation + re-seeding the feed counter, in one step
impl AppState { pub async fn init_schema(&self) -> anyhow::Result<()> }
```

`bootstrap_page` is unchanged and still frozen, but the **route no longer calls it**:
it buffered `limit + 1` rows (up to a gigabyte of client-chosen page) behind a
doc comment promising a stream. It stays for tests and scripts that want a page as a
value.

Cross-area edits this pass made, each one for a defect that could not be fixed
inside a single area:

| File | Area | Change |
|---|---|---|
| `state.rs`, `main.rs` | ops | `AppState::init_schema` re-seeds `ChangeFeed` **after** the migrations. `AppState::new` seeds it before them (the docstore needs the feed at construction), and `m002_backfill_feed_seq` is what writes the numbers — so an M1→M2 upgrade used to leave the allocator at `head = 0` over rows numbered `1..N`, handing out duplicate sequence numbers and reporting a watermark far below the rows. Every caller (`main`, `tests/common`, the `/readyz` test) now uses it; `crates/server/tests/feed_boot.rs` is the upgrade, pinned. |
| `routes/documents.rs` | http-routes | `PUT`, `PATCH` and snapshot restore publish their applied diff through `sync::publish_update`, and restore logs a warning when the document has live subscribers (SPEC §3.5 — the note that said there was no registry to consult is gone). |
| `auth/mod.rs` | auth | `revoke_session` / `revoke_user_sessions` / `revoke_user_sessions_except` close the affected sockets with `4401`. Revalidation polling stays as the backstop for revocations the server does not perform itself. |

## Area: docstore (M2 additions)

Still owns `docstore.rs`. New obligations:

1. **Publish to the feed on every projection change.** **Done.** `create`,
   `materialize_room` (`Upsert`), `tombstone` (`Tombstoned`), `untombstone`
   (`Restored`) and `purge_document` (`Purged`, writing `feed_seq` onto the
   `deleted_ids` row) all allocate **before** the Mongo write and `commit` **after**
   it succeeds, letting the guard burn the number on every failure path. A
   projection change that does not write `feed_seq` is invisible to every client —
   that is the single most important invariant in this milestone, and it was open
   long enough for two builders and the convergence harness to report it
   independently. Pinned by `crates/server/tests/sync_ws.rs::a_tombstone_and_a_purge_reach_the_feed_as_rows`, which walks edit → tombstone →
   restore → purge over a live socket, and by the harness's `assertFeedFreshness`.

   `untombstone` also records its `actor` as `updated_by` now (it used to
   `let _ = actor`), because a restore *is* an applied change and SPEC §3.5 defines
   `*_by` as the last applier the server saw.
2. **Stop flushing synchronously** on the write path: let the debounce worker
   (now `tuning.materialize_debounce`) own materialization, keeping the forced
   flush on `get`/`text`, subscriber-drop and shutdown (SPEC §3.5).
   **Still open, deliberately deferred** — see `PERF.md`. Measured cost is ~1.2 ms
   per materialization against a p50 update round trip of 21 ms, so it is an
   optimization, not a gate risk; and `WriteOutcome` hands the REST routes the
   materialized `content`/`title`/`materialized_version` they return to the caller,
   so deferring it is a read-your-writes change rather than a local one.
3. Room subscriber accounting for the sync layer: rooms evict 10 min after the
   **last subscriber** drops, post-flush (SPEC §4.3), not merely after idle time.
4. `DocStoreTuning` is now the constructor parameter; the `pub const`s are only
   defaults. No new reads of those constants.

**The M1 ctor is deliberately unfrozen** to make this possible: `MongoDocStore::new`
took `max_document_bytes` alone, so `MATERIALIZE_DEBOUNCE_MS`, `ROOM_IDLE_TIMEOUT_SECS`,
`UPDATE_LOG_KEEP_BYTES`/`_COUNT`, `CRDT_*_THRESHOLD_BYTES` and `TRASH_RETENTION_DAYS`
were validated in `Config` at boot and then ignored by the engine that was supposed
to obey them. `state.rs` (ops) passes `DocStoreTuning::from_config(&config)`;
`crates/server/tests/docstore_tuning.rs` pins the mapping field by field and proves
the store consults it.

Changed frozen signatures (already applied by the scaffold, callers compile):

```rust
pub struct DocStoreTuning { max_document_bytes, materialize_debounce, room_idle_timeout,
    update_log_keep_bytes, update_log_keep_count, crdt_compact_threshold_bytes,
    crdt_alert_threshold_bytes, trash_retention_days }
impl DocStoreTuning { pub fn from_config(&Config) -> Self }      // + Default = the constants
impl MongoDocStore { pub fn new(db: Database, tuning: DocStoreTuning,
                                feed: Arc<ChangeFeed>) -> Self;
                     pub fn tuning(&self) -> DocStoreTuning }
pub struct Page { pub documents: Vec<DocumentRow>, pub next_cursor: Option<String> }
```

## Area: ops (M2 additions)

1. **Indexes** (`db/indexes.rs`, the one list): **done** — `documents_feed_seq` and
   `deleted_ids_feed_seq`, both ascending and sparse (a row written before the feed
   existed has no `feed_seq` and is deliberately invisible to catch-up rather than
   wrongly seq-0). Bootstrap paging rides the default `_id` index.
2. **Migration** (append-only `migrations()`): **done** — `SCHEMA_VERSION = 2`,
   `m002_backfill_feed_seq`. Numbers are handed out in last-touched order
   (`updated_at`, then `deleted_at` for graveyard rows) so a backfilled feed reads
   like the history it stands in for, and the counter starts above the existing
   high-water mark so a half-finished run resumes without reusing a number.
   `FeedRow::from_row` returns `None` for a row with no `feed_seq`, so an
   un-backfilled M1 workspace was not *wrong* on the feed — it was invisible.
3. `/readyz` and `/metrics`: **done** — `FEED_HEAD_SEQ`, `FEED_SAFE_SEQ`,
   `FEED_SUBSCRIBERS` and `WS_BACKPRESSURE_DROPS` (labelled `queue="feed"|"doc"`)
   are in `telemetry::names`, sampled in `sample_gauges`, described for `/metrics`,
   and incremented at the sync area's two drop sites. Also fixed:
   `init_metrics` installed the recorder *before* setting its `OnceLock`, so two
   concurrent callers raced and the loser failed a valid `AppState::new` — fatal for
   parallel integration tests. It is one critical section now.
4. `.env.example` / `dev-docs/resolved/OPERATIONS.md`: **done in `.env.example`** — `APP_ORIGIN`
   now says it is both the CORS allowlist and the mandatory WebSocket origin check,
   and ships with the Vite dev origin, because the failure mode (403 before
   authentication, page loads, socket never connects) is otherwise opaque. The stale
   note claiming the tuning knobs are ignored is gone.
5. Graceful shutdown closes sockets with **4503** before flushing (SPEC §8):
   **done** — `main.rs` calls `routes::sync::close_all_sockets(&state)` between
   axum's drain and `flush_all`, and it returns the socket count for the log. The
   hub's own `SIGTERM` watcher stays as the backstop.
6. `docker-compose.yaml`: the `mongo` service runs with `ulimits.nofile = 64000`.
   WiredTiger opens a file per collection and index and **aborts the process** at
   Docker's default 1024, which under test load looks exactly like a sync bug.

## Area: http-routes (M2 additions)

1. **Router-level integration tests for sort/filter** (`crates/server/tests/**`):
   the DSL over the router, asserting that `filter`/`sort`/`cursor` results match
   `core::filter::evaluator` on the same corpus — the M1 gap. Cover: every
   `CompareOp`, `contains`/`any`/`every`, `missing` vs `null`, date comparisons,
   multi-key sort with `-`/`:desc`, `fm.*` and `plugins.*` paths, an invalid filter
   → 400, and a refused `sort=content` → 400.

   Done, as four binaries sharing `tests/common/mod.rs` (the harness: one
   throwaway database per test, a bearer session, request helpers, and the
   shared-core side of the comparison):

   | Binary | Covers |
   |---|---|
   | `documents_query.rs` | the filter corpus (answered by Mongo **and** by the evaluator), sort specs against `compare_rows`, cursor paging as a partition, `metadata_only`, refused queries, `$text` search |
   | `documents_rest.rs` | create/409/410, the configured document cap, `PATCH` content-only, `PUT`, the Trash partitions + restore + audit rows, `?format=crdt`, 401 on every route |
   | `wire_views.rs` | every view's wire shape with no database — RFC 3339 timestamps, plain-JSON `fm`/`plugins`, no extended JSON anywhere |
   | `docstore_tuning.rs` | the tuning knobs reach the engine (see area docstore, M2 item 4) |

   Mongo-backed cases are `#[ignore]`d and skip when `MONGO_URI` is unset, so a
   clean checkout stays green; `wire_views.rs` always runs.

   **One divergence those tests pinned rather than fixed.**
   `core::filter::evaluator::compare_rows` sorts a row whose sort key is *missing*
   last in **both** directions; Mongo sorts an absent field lowest, i.e. first
   ascending. So `?sort=fm.priority` can return the same rows in a different order
   than the client's local query engine over the same data.
   `documents_query.rs::missing_sort_keys_are_ordered_differently_by_the_two_engines`
   asserts the current behaviour of *both* sides, so closing it stays a decision
   instead of becoming a surprise, and the cases that must agree are restricted to
   keys present on every row they order. Closing it means either changing the core
   (treat `Missing` as below `Null`, which makes both directions match Mongo and is
   the smaller change) or teaching the compiler to emit an `$ifNull` sort
   projection — a `core` or `docstore` change, not an `http-routes` one, and it
   needs `web/kernel/src/query/filter.ts` (which mirrors `compare_rows` line by
   line, with its own pinning test) changed in the same commit.

   Related, and once open: `SORTABLE_FIELDS` could not offer `deleted_at` or
   `materialized_version`, because `resolve_field` returned `Missing` for both roots —
   so a client provably could not reproduce that ordering, and
   `?trash=trashed&sort=deleted_at` was a 400. **Half-closed (M5 polish).**
   `deleted_at` is a fixed root on both engines now and is the Trash sort key;
   `materialized_version` is still refused, and deliberately (a hash has no order worth
   exposing).

   And closing it inherited the divergence above, which is worth stating because
   `deleted_at` is the **first fixed root that can be absent**: a live document has no
   `deleted_at` (`Option` in `domain.rs` with `skip_serializing_if`; `untombstone`
   `$unset`s it), so `?trash=all&sort=deleted_at` is the same disagreement over live
   versus tombstoned documents — server first, client last — on a key the API advertises
   rather than on an `fm.*` path a caller chose. Pinned on both sides by
   `documents_query.rs::deleted_at_ascending_diverges_where_a_document_is_still_live` and
   by a corpus `sorts` case; `compare_rows`'s doc comment no longer claims the two
   orderings are identical. `-deleted_at`, which is what `doc-list` sends, agrees.
2. **Finish the RFC 3339 conversion. Done — no response type carries a
   `bson::DateTime` any more.** `DocumentView`, `UserView`, `AttachmentView` and
   `SnapshotView` were already converted; M2 integration finished the rest:
   - `routes/auth.rs` — `SessionResponse::expires_at` → `domain::Timestamp`. This
     one was on **every** register and login response as
     `{"$date": {"$numberLong": …}}`.
   - `routes/admin.rs` — `InviteView` (`created_at`, `expires_at`, `used_at`,
     `revoked_at`) and `PasswordResetResponse::expires_at`.
   - `routes/attachments.rs` — `OrphanView::flagged_at`.
   - `routes/admin.rs` audit listing — new `AuditView`: `Timestamp` plus `detail`
     through `domain::materialized_to_json`. It used to return the *stored*
     `AuditEntry`, so `detail` leaked `$oid`/`$binary` for whatever a caller had put
     in it, not just `$date`.

   `crates/server/tests/documents_rest.rs::responses_never_carry_extended_json`
   scans whole response bodies for `$date`/`$binary`/`$oid`/`$numberLong`, and now
   covers login, the invite listing, the issued reset, the audit listing and the
   orphan view alongside the document routes — so none of them can regress.
3. `GET /api/documents` now pages `DocumentRow`s; keep `metadata_only` blanking
   `content` at the projection, never after the read. **Done** — the route passes
   `ListQuery::metadata_only` down and no longer blanks `view.content` after the
   read (which had been reading every megabyte only to discard it).

## Area: wasm (shared ABI)

**Owns:** `backend/crates/core/src/wasm.rs` **and**
`web/kernel/src/wasm/**` — the two halves of one ABI, so they have one owner.

- Exports, frozen: `parse_document(text) -> JSON string`,
  `evaluate_filter(filter_json, doc_json) -> bool`,
  `core_semantics_version() -> u32`, `normalize_date(input) -> String`,
  `resolve_title(text) -> String`.
- **Compilation to Mongo stays server-side** (SPEC §4.2) — `bson` is not in the
  Wasm build and must not become so.
- Every export is **total**: malformed input yields a defined result, never a
  panic. A trap poisons the instance, and a poisoned kernel is a blank app.
- `mise run wasm` builds and smoke-tests the package; the smoke script
  (`web/scripts/wasm-smoke.mjs`) is part of this area.
- The generated `web/kernel/src/wasm/pkg/` is a build artifact and gitignored.

## Commands

```
mise run check        # fmt + check + clippy -D warnings (backend)
mise run test         # cargo test --workspace --all-targets
mise run wasm         # build the Wasm core + node smoke test
mise run web-check    # npm typecheck + vitest (web)
mise run web          # vite dev server, /api proxied to the Rust server
mise run harness      # convergence harness against a running server
```

---

# M3 build contracts (static serving + plugin distribution)

**Scope on this side: SPEC §9 M3 only** — serving the PWA bundle, the import map, the
installed-plugin list and the plugin modules. **Not in scope:** the Extism host, the zip
installer, the pending-install approval flow, plugin config/secrets, hooks and cron —
all M4, and all of them write the same directory this area reads.

The M1/M2 rules still hold. Amendments, made by the scaffold and announced here:

- **Two new modules**, both owned by the new `server-static` area: `crates/server/src/plugins.rs`
  and `crates/server/src/routes/statics.rs`.
- **`config.rs` gained four fields** (ops-owned file, scaffold edit): `web_dist_dir`,
  `plugins_dir`, `kernel_dts_path`, `disable_plugins`.
- **`routes/mod.rs` gained three lines** (http-routes-owned file, scaffold edit): the
  `/api/plugins` nest, the `statics::router()` merge, and `.fallback(statics::fallback)`.
- **No new dependencies.** Static serving is `tokio::fs` plus a canonicalization check
  rather than `tower-http`'s `fs` feature, so `Cargo.toml` and `Cargo.lock` are untouched.

## Area: server-static

**Owns:** `crates/server/src/plugins.rs`, `crates/server/src/routes/statics.rs`.

**Must not touch:** `docstore.rs`, `feed.rs`, `auth/**`, `domain.rs`, `state.rs`,
`error.rs`, the other `routes/*`. `config.rs` changes go through ops.

### Routes

| Route | Auth | Cache | Notes |
|---|---|---|---|
| `GET /` and any unmatched GET | none | `no-store` | `index.html` with the import map inlined + a fresh CSP nonce |
| `GET /assets/*`, `/runtime/*` | none | `immutable`, 1 y | content-hashed by the build |
| `GET /sw.js`, `/icon*.svg`, `/manifest.webmanifest` | none | `no-cache` | |
| `GET /importmap.json` | none | `no-cache` | the blessed runtime layer only |
| `GET /kernel.d.ts` | none | `no-cache` | the generated plugin contract (SPEC §6.4) |
| `GET /plugins/{id}/{version}/frontend/{*path}` | none | `immutable`, 1 y | must be in the registry; **only `frontend/**`** |
| `GET /api/plugins` | session | — | `{plugins, problems, disabled}` |

### Hard requirements

- **`index.html` is never served as a file.** Every spelling of it goes through the
  injection path; serving the raw file ships a page whose `<!--LM_IMPORT_MAP-->` marker is
  still a comment, and then *every* bare specifier fails to resolve. Pinned by the reason
  it is written down: that is exactly how the first version of this route broke.
- **The import map is inline and nonced** (SPEC §8: "external or nonced"). Browsers never
  shipped an external import map, so inline-with-nonce is the only form that works; the
  nonce is per response, which is why `index.html` is `no-store` and why the service worker
  must not precache it.
- **The CSP adds `'wasm-unsafe-eval'`** to the policy written in SPEC §8. Without it
  `WebAssembly.instantiateStreaming` is refused and the client silently loses the shared
  core — filters, titles and dates then come from nowhere. It is the narrow directive, not
  `'unsafe-eval'`, and it is supported across the SPEC §8 browser floor. **This is a
  documented deviation from the SPEC's literal CSP string.**
- **Path safety twice over**: lexical (no `..`, no absolute segments, no NUL) *and*
  canonicalized-and-re-checked against the root, so a symlink cannot leave the tree.
- **`nosniff` on every response**, and `Content-Disposition: attachment` for anything
  outside the inline allowlist. Neither `image/svg+xml` nor **`text/html`** is inline: a
  plugin package is third-party content served from the app's own origin, `serve_file`
  attaches no CSP, and an inline `.html` from a package would therefore be a scriptable
  same-origin document *outside* the policy every real document gets — no `default-src`, no
  `frame-ancestors`, no `base-uri` (the SPEC §3.6 rule, applied here). The app's own
  `index.html` never passes through `serve_file`.
- **Only `frontend/**` of a package is reachable.** That is the package layout SPEC §6.2
  fixes, and it keeps two non-browser files off a public URL: `manifest.json`, whose
  capability and `config` key lists are exactly what `/api/plugins` requires a session to
  see, and `backend.wasm`, which is server-side code. `plugins.rs` rejects a manifest whose
  `frontend.module`/`style` is outside that directory, so the rule is reported at scan time
  rather than 404-ing in a client. The route itself stays unauthenticated and that is
  *forced*: a plugin module is fetched by `import()`, which cannot carry a header, and the
  M5 shell authenticates with a bearer token from an origin where the cookie is not sent.
  Scoped asset URLs are the M4 conversation, when a privately installed plugin first has
  something to lose.
- **Only registered plugins are served.** A directory that is not in the registry 404s, so
  M4's *pending* installs cannot be fetched before an admin approves them.
- **One version per plugin**, the highest. Two versions in one page would give two copies
  of a plugin's API to different dependents.
- **A bad plugin directory is never fatal**: it becomes a `PluginProblem`, is logged at
  boot, and is returned by `/api/plugins` so the admin screen can show it.
- **`DISABLE_PLUGINS=1`** returns an empty list and 404s every plugin asset — the
  server-side half of safe mode (SPEC §6.1).
- **`/api/plugins` is camelCase on the wire** (`baseUrl`), unlike every other response.
  It is not a REST resource of its own: it is `InstalledPlugin` from
  `web/kernel-api/src/manifest.ts`, consumed directly by the loader, and the manifest it
  wraps is already camelCase because plugin authors write it by hand.

### The installed layout

```
<PLUGINS_DIR>/<id>/<version>/manifest.json
<PLUGINS_DIR>/<id>/<version>/frontend/index.mjs
<PLUGINS_DIR>/<id>/<version>/frontend/style.css
```

`mise run plugins` writes it for the base distribution; M4's installer extracts into the
same shape. `/plugins/<id>/<version>/…` maps onto it one-to-one, which is what makes plugin
URLs immutable (SPEC §8).

### Public API

```rust
// plugins.rs
pub const BASE_PLUGIN_IDS: &[&str];                  // the 23 plugins of SPEC §6.5
pub fn is_valid_plugin_id(id: &str) -> bool;         // ^[a-z0-9][a-z0-9-]{0,63}$
pub fn is_valid_version(version: &str) -> bool;      // x.y.z with an optional tail
pub fn safe_relative_path(path: &str) -> bool;
pub struct PluginFrontend { module, style }
pub struct PluginManifest { id, version, kernel, dependencies, peer_libraries,
                            frontend, name, description, author, license, extra }
pub struct InstalledPlugin { manifest, base_url, state, base }   // camelCase on the wire
pub struct PluginProblem { path, message }
pub struct Registry;                                 // plugins(), problems(), root(),
                                                     // get(), peer_ranges(), unsatisfied_peers()
pub fn scan(dir: &Path) -> Registry;
pub fn registry(config: &Config) -> Arc<Registry>;   // cached; empty when DISABLE_PLUGINS
pub fn reload(config: &Config) -> Arc<Registry>;     // boot, and M4's installer

// routes/statics.rs
pub const IMPORT_MAP_MARKER: &str = "<!--LM_IMPORT_MAP-->";
pub const RUNTIME_MANIFEST_FILE: &str = "runtime-manifest.json";
pub fn router() -> Router<AppState>;                 // importmap.json, kernel.d.ts, /plugins/*
pub fn api_router() -> Router<AppState>;             // /api/plugins
pub async fn fallback(State<AppState>, Uri) -> Response;   // static file, else index.html
pub fn runtime_imports(&AppState) -> BTreeMap<String, String>;
pub struct ImportMap { imports }
pub struct InstalledResponse { plugins, problems, disabled }
```

### Config (ops)

| Variable | Default | Meaning |
|---|---|---|
| `WEB_DIST_DIR` | unset | the built PWA; unset ⇒ API-only (Vite serves the app in dev) |
| `PLUGINS_DIR` | `plugins/base/dist` | the installed set |
| `KERNEL_DTS_PATH` | `web/kernel-api/dist/kernel.d.ts` | the generated contract |
| `DISABLE_PLUGINS` | `false` | server-side safe mode |

`APP_ORIGIN` must include the server's **own** origin once it serves the PWA, or the
WebSocket upgrade is refused with 403 before authentication (PROTOCOL.md §1.2) — the page
loads and never syncs.

### Tests

| Binary | Covers |
|---|---|
| unit tests in `routes/statics.rs` | path resolution (`..`, absolute, symlink-free cases, a directory is not a file), the content-type table, the inline allowlist excluding SVG, nonce uniqueness, marker replacement, and the **whole `script-src` directive** asserted as one string |
| unit tests in `plugins.rs` | id/version validation, manifest path safety, numeric version ordering, a missing directory as a problem rather than a panic |
| `crates/server/tests/statics.rs` | the assembled router: import-map content, `index.html` injection + the policy + `no-store` + COOP, a fresh nonce per response, `index.html` never served as a file *from any spelling*, the SPA fallback, `/api/**` 404s staying JSON, cache policy per URL class, traversal out of both roots (lexical, percent-encoded, and via symlink), only-the-registered-version, SVG disposition, `/api/plugins` auth + camelCase + reported refusals, `DISABLE_PLUGINS`, `/kernel.d.ts` |

`tests/statics.rs` builds its own fixture tree under `CARGO_TARGET_TMPDIR` and is
`#[ignore]`d like every other Mongo-backed suite (the router needs an `AppState`, and
`AppState::new` pings Mongo):

```text
MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server --test statics -- --ignored
```

### Deliberate deviations from the M3 brief

1. **No `rust-embed`.** The bundle is read from `WEB_DIST_DIR` in every profile, not
   embedded in the binary in release. Two reasons, and the first is the binding one:
   embedding needs a `rust-embed` dependency, and `Cargo.toml`/`Cargo.lock` are frozen by
   this file (rule 3) — this area added **no** dependencies at all. The second is that
   embedding couples `cargo build` to a Vite build having already run, which would break
   `mise run check` and the Rust-only CI in a checkout that has never run `npm`. The
   deployment property `rust-embed` was wanted for — one self-contained artifact — is met
   instead by the image: `backend/Dockerfile` builds the bundle in a Node stage and bakes
   it in at `/srv/web`, so the container has no external file dependency either way.
2. **The registry is the directory, not a `plugins` Mongo collection.** M3 has nothing
   mutable to record: the installed set *is* the directory, one version per plugin, read at
   first use and re-readable through `reload`. The `plugins` collection becomes the
   **approval record** in M4 (pending vs enabled, approved capabilities, the install queue)
   while the directory stays the artifact store — and M4 extends the same registry either
   way, because `reload` is the seam. Writing a mirror now would need a boot call in
   `main.rs` (an ops file) for a table nothing reads.

### Open on this side

1. **`/readyz`'s `plugins` check reports the registry** — done, and deliberately **counts
   only**: `N plugins loaded; M not loaded`. `/readyz` is unauthenticated and proxied
   straight through in the Compose deployment, so the absolute `PLUGINS_DIR` and the
   manifest-rejection strings it used to carry were world-readable reconnaissance. The paths
   and messages live where an operator is: the boot `WARN` and the admin plugin view.
2. **No `ETag`/`304` on static files.** Hashed assets are `immutable` so it does not
   matter for them; `sw.js` and the icons re-download on every revalidation. Cheap to add
   (`mtime` + length), deliberately not invented here.
3. **Peer-library *resolution* is not implemented, only checked.** One version of each
   blessed library ships in the runtime bundle, so there is nothing to resolve in M3;
   `Registry::unsatisfied_peers` reports what an installed plugin declared and the bundle
   does not provide, and `/importmap.json` logs it. Real resolution (SPEC §6.4: "the server
   resolves all installed plugins' ranges to single versions at install") lands with M4's
   installer, where installs are serialized and can fail.
4. **`plugins::reload` is never called at boot.** The registry is scanned lazily on the
   first request that needs it, so the log line naming the plugin count and the problems
   appears *after* the first request instead of during startup, and a bad plugin directory
   is not visible until someone loads the app. One line in `main.rs` next to
   `state.init_schema()` closes it — an ops file, hence a request rather than an edit.

### What the M3 hardening pass changed

Two defects and one structural fix, all inside this area's own files:

1. **`index.html` was still reachable as a raw file.** The guard compared the *raw* request
   path against the single spelling `index.html`, so `/./index.html` and `/index.html/`
   walked past it into the file branch and shipped a page whose `<!--LM_IMPORT_MAP-->` was
   still a comment — the exact failure the guard exists to prevent. The fallback now
   normalizes away empty and `.` segments *before* deciding which branch runs, and
   `tests/statics.rs::index_html_is_never_served_as_a_file_from_any_spelling` pins all
   three spellings.
2. **The registry cache was global, not per directory.** A single cached `Arc<Registry>`
   made the first `PLUGINS_DIR` any caller asked about the answer for every later one.
   Invisible in a server process (one config) and fatal in a test binary, where each case
   points at its own fixture. Keyed by `config.plugins_dir` now.
3. **`Cross-Origin-Opener-Policy: same-origin`** on the app document, and the CSP/marker
   rendering split into a pure `render_index` so the policy string is unit-testable without
   a filesystem or a database. (M5 polish split it once more: the marker replacement is
   `pub(super) render_index_body`, which `shell.rs` now calls instead of carrying its own
   copy. The *policies* stay separate — the shell's `connect-src` is not the browser's —
   but there is one renderer of `index.html`.) COOP is deliberately *not* paired with COEP
   (`require-corp`), which would force CORP headers onto every plugin asset for a
   cross-origin isolation this app does not use.

**Verified end to end against the real bundle**, not only in tests: the server was run with
`WEB_DIST_DIR=web/app/dist PLUGINS_DIR=plugins/base/dist` and the app driven in Chromium
through registration. All 14 base plugins fetched their module *and* their stylesheet under
`script-src 'self' 'nonce-…' 'wasm-unsafe-eval'`, all 17 runtime-layer specifiers resolved
through the injected map, and `life_manager_core_bg.wasm` compiled with **no CSP violation**
— which is the one thing worth re-checking by hand after any policy edit, because a server
built before `'wasm-unsafe-eval'` existed shows exactly this and nothing else:

```text
[wasm] core unavailable WebAssembly.instantiateStreaming(): Compiling or instantiating
WebAssembly module violates the following Content Security policy directive …
```

### Build and deployment integration (this area, with ops' files)

- **`backend/Dockerfile` is now four stages and the build context is the repository root**
  (`wasm-tools` → `rust-builder` → `web-builder` → `runtime`). The image contains the
  binary plus `/srv/web`, `/srv/plugins` and `/srv/kernel.d.ts`, and sets the three
  matching env vars, so `docker compose up --build` is a complete app with no separate
  frontend deploy. The Rust stage also compiles the shared core to Wasm, because the app
  bundle imports it — which is why the Node stage cannot come first.
- **`/.dockerignore` is new** and is what makes a root context affordable: no `.git`, no
  `node_modules`, no `target`, no `dist`, no `.env`, and not the Flutter tree.
- **`docker-compose.yaml`**: root build context, the four M3 env vars, and a `caddy`
  **profile** (opt-in, `deploy/Caddyfile` is new) for the automatic-HTTPS self-host path
  SPEC §8 describes. `DOMAIN` defaults to `localhost` rather than being required, because
  Compose interpolates every service before it filters by profile.
- **`mise.toml`**: `web-build` now `depends = ["wasm"]` (the app bundle aliases a
  gitignored Wasm artifact, so a fresh checkout could not build and a stale one silently
  bundled an old core), and `dev` passes `WEB_DIST_DIR`/`PLUGINS_DIR`/`KERNEL_DTS_PATH`
  explicitly. That last one is not cosmetic: the task runs in `backend/`, and the relative
  defaults in `config.rs` would otherwise resolve to `backend/plugins/…` and find nothing,
  which reads as "the plugins failed to load".

---

# M4 build contracts (backend plugins)

**Scope: SPEC §9 M4 only** — the Extism host with its limits and circuit breaker, the
manifest/dependency/capability enforcement, the pending-install approval flow, plugin
config and secrets, hooks, cron and the event bridge; **proof:** the `calendar` plugin
(backend half crons an ICS feed into machine-owned documents, frontend half renders a month
view from `fm.date`) with `agenda` alongside it as a pure frontend plugin.
**Not in scope:** the Flutter shell (M5). Nothing here needs Dart, and nothing here needs a
new frontend kernel API.

> **Post-M4 (2026-09-24): `calendar` and `agenda` were removed from the tree** at the
> owner's direction ("rip out the calendar stuff — let's polish the basics"). This section
> is kept verbatim as the record of what M4 was built against; the **`calendar` and
> `agenda-admin` builder areas no longer have plugin sources to own** (agenda-admin's admin
> surface — `plugins/base/admin/**` and the admin half of `routes/plugin_api.rs` — is
> untouched and still shipping). Everything else here still describes the tree. The
> capability, hook, cron, route and install-lifecycle suites never drove the calendar: their
> fixture is and always was `plugins/examples/hello-backend`.

[`HOST-ABI.md`](HOST-ABI.md) is authoritative for everything crossing the Wasm boundary.
Server and plugins implement it independently; where an implementation and that document
disagree, the document is the bug report, and where the document and
[`../SPEC.md`](../SPEC.md) disagree, the SPEC wins.

The M1–M3 rules still hold: **don't edit another area's files, don't change a frozen
signature, report instead of improvising.** Amendments the M4 scaffold made, all announced
here:

1. **Two new crates.** `crates/plugin-abi` (a workspace member — the ABI as serde types) and
   `crates/plugin-sdk` (**excluded** from the workspace: it links Extism's host imports, so a
   host-target `cargo test --workspace --all-targets` would fail to link it).
2. **A new Cargo workspace outside `backend/`:** `plugins/` holds the backend halves
   (`base/calendar/backend`, `base/calendar/ics`, `examples/hello-backend` — since the
   calendar's removal, `examples/hello-backend` alone). Both it and
   `crates/plugin-sdk` pin `wasm32-unknown-unknown` in their own `.cargo/config.toml`, so no
   command needs `--target`.
3. **Dependencies were added** to `crates/server`: `extism`, `reqwest` (rustls only),
   `hickory-resolver`, `ipnet`, `chacha20poly1305`, `hkdf`, and `life-manager-plugin-abi`.
   Nothing else may be added. (`zip`, `hmac`, `sha2` were already there.)
4. **`config.rs` gained twelve fields** (ops-owned file, scaffold edit) — the `PLUGIN_*`
   block and `CONFIG_KEY`; `.env.example` documents every one.
5. **`routes/mod.rs` gained two nests** (http-routes-owned file, scaffold edit):
   `/api/admin/plugins` and the merge of `plugin_api::router()` into the existing
   `/api/plugins` nest.
6. **`routes/sync.rs` gained one function** (sync-owned file, scaffold edit):
   `publish_plugin_event`, because `ConnEntry` — the only place a user id meets an outbox —
   is private to that module.
7. **`db/indexes.rs` gained two indexes** and **`telemetry.rs` gained twelve metric names**
   (ops-owned files, scaffold edits). **No migration and no `SCHEMA_VERSION` bump:** the
   three plugin collections are created lazily by Mongo and need no backfill.
8. **`main.rs` gained the boot and shutdown wiring** (ops-owned file, scaffold edit).

## New and changed layout

```
backend/
├── HOST-ABI.md                          the Wasm boundary                    FROZEN
└── crates/
    ├── plugin-abi/                      the ABI as types      [wasm-host]     FROZEN
    │   └── src/{lib,error,documents,kv,config,events,call,http,hooks,cron,log,limits,names}.rs
    ├── plugin-sdk/                      the plugin author's crate  [wasm-host]
    │   └── src/{lib,host,runtime,documents,kv,config,events,plugins,http,log}.rs
    └── server/src/
        ├── pluginhost/
        │   ├── mod.rs        host, activation, invocation      [wasm-host]
        │   ├── host_fns.rs   the 13 host functions             [wasm-host]
        │   ├── limits.rs     deadlines, write ledger           [wasm-host]
        │   ├── breaker.rs    the circuit breaker               [wasm-host]
        │   ├── pool.rs       compiled modules + instances      [wasm-host]
        │   ├── hooks.rs      feed → debounce → invoke          [hooks-cron]
        │   └── cron.rs       the parser + the scheduler        [hooks-cron]
        ├── plugininstall/
        │   ├── mod.rs        the pipeline, approve, uninstall  [install-flow]
        │   ├── zipcheck.rs   hostile-zip handling              [install-flow]
        │   ├── queue.rs      the Mongo install lock            [install-flow]
        │   ├── watcher.rs    the directory-drop path           [install-flow]
        │   └── config.rs     plugin_config + secrets           [install-flow]
        ├── plugins.rs        + manifest types, states, record, resolution [install-flow, with server-static]
        └── routes/plugin_api.rs  dispatch [wasm-host] + admin surface [agenda-admin]

plugins/
├── Cargo.toml                           the wasm plugin workspace
├── base/calendar/{manifest.json,README.md,backend/,ics/,src/}   [calendar]     (removed)
├── base/agenda/{manifest.json,src/}                             [agenda-admin] (removed)
└── examples/hello-backend/                                      [wasm-host]

web/scripts/build-wasm-plugins.mjs       backend halves → the installed layout  [wasm-host]
```

Root: `mise.toml` gained `wasm-plugins`, `plugin-check`, `plugin-test`, `plugin-smoke`;
`.env.example` and `.gitignore` gained their M4 blocks — **[ops]**. (`plugin-test` was
removed with the calendar: it ran `calendar-ics`'s host-target suite, and nothing left in
`plugins/` can be built for the host target.)

## The five builder areas

| Area | Owns | Must not touch |
|---|---|---|
| **wasm-host** | `crates/plugin-abi/**`, `crates/plugin-sdk/**`, `pluginhost/{mod,host_fns,limits,breaker,pool}.rs`, the dispatch half of `routes/plugin_api.rs`, `plugins/examples/**`, `web/scripts/build-wasm-plugins.mjs`, `crates/server/tests/pluginhost_*.rs` | `plugininstall/**`, `plugins.rs`, `pluginhost/{hooks,cron}.rs`, `feed.rs`, `docstore.rs`, `domain.rs`, `state.rs`, `error.rs` |
| **install-flow** | `plugininstall/**`, `plugins.rs` (the M4 half), `crates/server/tests/plugininstall_*.rs` | `pluginhost/**` internals, `routes/**` (ask), `docstore.rs`, `domain.rs` |
| **hooks-cron** | `pluginhost/hooks.rs`, `pluginhost/cron.rs`, `routes::sync::publish_plugin_event`, the `emit`/`emit_client` bodies in `host_fns.rs` | everything else in `pluginhost/**`, `plugininstall/**`, the rest of `sync.rs` |
| **calendar** *(area retired — its sources were removed 2026-09-24)* | `plugins/base/calendar/**` | anything under `backend/` (report ABI gaps instead), `plugins/base/agenda/**` |
| **agenda-admin** *(the `agenda` half was removed 2026-09-24; the admin half is live)* | `plugins/base/agenda/**`, `plugins/base/admin/src/Plugins.tsx` and its siblings, the admin half of `routes/plugin_api.rs` | `pluginhost/**`, `plugininstall/**` (call them) |

Three areas share one file each, and the split is marked inside the file:
`routes/plugin_api.rs` (wasm-host dispatch / agenda-admin admin), `host_fns.rs`
(hooks-cron owns two function bodies), `plugins.rs` (server-static's M3 registry /
install-flow's M4 types).

## Frozen contracts

### `crates/plugin-abi` — FROZEN

Every type in it is the wire format. Adding an **optional** field is allowed and announced;
renaming one, retyping one, or changing an `ErrorCode` spelling is an ABI-major change and
bumps `ABI_VERSION`. `HOST-ABI.md` is the prose half and changes in the same commit.

One correction, not a change (2026-09-25): `SectionEdit.value` carries
`deserialize_with = "deserialize_present"`. No byte on the wire moved — serde simply folds
a JSON `null` onto `Option<T>` as `None`, which is what an *absent* field also produces, so
`{"key":"k","value":null}` — the form this type's own doc comment and `HOST-ABI.md` specify
for "write the YAML `null`" — arrived at the host as "no value" and was refused as
`invalid_argument`. A backend plugin could not write a null into its own section at all,
while the test beside the type passed because it only ever serialized. Round trips are now
asserted in both directions there and end to end in `pluginhost_runtime.rs`.

```rust
pub const ABI_VERSION: u32 = 1;
pub type JsonMap = BTreeMap<String, serde_json::Value>;
pub struct Envelope<T> { pub ok: bool, pub value: Option<T>, pub error: Option<HostError> }
pub enum Origin { User{id}, Plugin{id}, System }
pub struct Capabilities { documents, http_hosts, public_routes, notifications }
pub struct InitPayload { plugin_id, version, abi_version, capabilities, config_keys }
pub enum ErrorCode { CapabilityDenied, Forbidden, NotFound, Gone, AlreadyExists,
    InvalidArgument, TooLarge, LimitExceeded, Reentrancy, Timeout, Blocked, Unavailable,
    Internal }                      // append-only; `is_plugin_fault` splits breaker input
pub struct HostError { code, message, detail }
// documents: DocumentValue, TrashScope, GetDocument{Input,Output},
//   QueryDocuments{Input,Output}, CreateDocumentInput, WriteDocumentOutput,
//   SectionEdit, SpliceSection{Input,Output}, RewriteDocumentInput
// kv / config / events / call / http / hooks / cron / log: one module each
// limits::*  — every cap, readable from both sides
// names::*   — every host-function and export name; HOST_FUNCTIONS, EXPORTS
```

### `pluginhost` — the invocation contract

```rust
pub const HOST_NAMESPACE: &str = "extism:host/user";
pub struct ActivePlugin { id, version, capabilities, dependencies, hooks, cron, routes,
    events, config_keys, wasm_path, module_sha256, abi_version, exports }
pub enum CallKind { Init, Hook(HookKind), Cron{index}, Route, Invoked{caller,function},
                    Event{emitter} }        // export_name(), timeout(), label()
pub struct Invocation { plugin_id, kind, payload, deadline, depth, stack, user_id }
    // top_level(), with_user(), nested() — depth ≤ 3, no reentrancy, shared deadline
pub struct CallOutcome { value, duration, writes, logs }
pub enum PluginHostError { NotActive, NoExport, Disabled, Timeout, Trap, BadResponse,
    AbiMismatch, PoolExhausted, Instantiate, ShuttingDown, Internal }  // counts_as_failure()
pub enum CallFailure { Refused(HostError), Host(PluginHostError) }
pub struct PluginHost;                      // get(), activate(), deactivate(), reload(),
                                            // active(), get_active(), call(), call_typed(),
                                            // reset_breaker(), stats(), shutdown()
pub fn spawn_workers(&AppState) -> PluginHostWorkers;
pub struct PluginLimits { … }               // from_config: configuration may only LOWER
pub struct Deadline;                        // inherited(), capped(), remaining_ms()
pub struct WriteLedger;  pub struct CallCounters;
pub enum BreakerState { Closed{failures}, Open{since,failures,reason} }
pub enum BreakerTransition { Counted, Opened, AlreadyOpen }
pub struct CircuitBreaker;  pub struct PluginPool;  pub struct InstanceGuard;
pub struct CronSchedule;  pub enum CronParseError { … }  pub struct CronState;
pub const HOOK_DEBOUNCE: Duration = 2s;  pub const HOOK_MAX_DELAY: Duration = 30s;
```

### `plugininstall` — the install contract

```rust
pub enum InstallSource { Upload{filename}, Directory{path}, Base }
pub struct InstallRequest { source, archive, actor, auto_approve }
pub struct InstallOutcome { id, version, state, capabilities, replaced, warnings }
// M5 polish: `AbiIncompatible` was removed — it was never constructible. The ABI
// *version value* is only knowable from a running instance, so it is checked by
// `PluginHost::activate` (`PluginHostError::AbiMismatch`); install checks statically
// that the module exports `lm_abi_version` at all, and reports that as `Manifest`.
pub enum InstallError { Package, Manifest, KernelIncompatible, Dependency,
    PeerLibrary, AlreadyInstalled, Locked, RolledBack, NotInstalled, Conflict, Config,
    Io, Db, Internal }
pub const ABSENT_DISABLED_REASON: &str;   // the `disabled_reason` boot writes for a
                                          // package that vanished; see decision 14
pub async fn install / approve / reject / disable / enable / uninstall / purge_sections
pub async fn records / record / adopt_installed_directory
pub fn staging_dir / pending_dir / installed_dir / validate_manifest
// zipcheck: ExtractedPackage, ZipError, read_manifest, extract, entry_allowed,
//           inside_root, wait_for_stable, sha256_file
// queue:    InstallLock, acquire, with_lock, holder   (a `meta` document + TTL)
// watcher:  spawn, scan_once                          (5 s poll + stable-size check)
// config:   SealedValue, StoredValue, ConfigCipher{seal,open}, cipher,
//           for_plugin, for_admin, set, clear, purge, validate_value
```

### `plugins.rs` — the M4 additions

```rust
// PluginManifest gained typed `capabilities`, `config`, `backend`
pub struct PluginCapabilities { documents, http, notifications, public_routes }
    // to_abi(), http_hosts(), approval_is_legal()
pub struct HttpCapability { hosts }
pub struct ConfigField { kind, secret, label, description, default, required, options }
pub struct PluginBackend { module, hooks, cron, routes, events }
pub struct RouteSpec { method, path, public }              // parse("POST /webhook")
pub enum PluginState { Pending, Enabled, Disabled, Failed } // wire: snake_case
pub struct PluginRecord { … }  pub struct PluginKvEntry { … }  pub struct PluginConfigEntry { … }
pub struct Resolution { order, peer_versions, warnings }
pub enum ResolveError { Missing, Unsatisfied, Cycle, PeerConflict }
pub fn resolve(&[PluginManifest]) -> Result<Resolution, ResolveError>;
pub fn satisfies(version, range) -> Result<bool, ResolveError>;
impl Registry { pub fn apply_states(&mut self, &[PluginRecord]) }
// InstalledPlugin::state changed from &'static str to PluginState — same wire strings
```

## Decisions this scaffold made, and why

1. **`created_by` is the machine-ownership record.** SPEC §3.3 wants a "creator-plugin
   check" for `rewrite_document`. `Actor::Plugin` already exists and `created_by` is already
   stored, so ownership is `created_by == "plugin:<caller>"` — no new column, no second
   source of truth, no `domain.rs` change. A human-created document is therefore nobody's to
   rewrite, which is the intended outcome.
2. **`splice_section` takes no `plugin_id`.** SPEC §6.3 spells the signature with one; the
   host supplies it. A plugin that could name the section could write another plugin's
   machine data.
3. **A pending package never sits in `PLUGINS_DIR`.** Extraction goes to
   `PLUGIN_STAGING_DIR/pending/<id>/<version>` and **approval is the rename** into the
   served root. That makes "pending installs cannot be fetched" structural rather than a
   check that could be forgotten — the static route serves the registry, and the registry is
   a scan of the served root.
4. **An approval may widen `http.hosts`, and nothing else.** A plugin whose destination is
   admin-configured cannot know its host at packaging time (a feed importer is exactly that),
   and the alternative is operators repackaging zips — which they would do by turning the
   check off. Every other field may only be narrowed.
5. **`emit_client` is a JSON `plugin.event` message, not a binary frame.** PROTOCOL.md §3.1
   reserves binary types `0x10`–`0x1F` for plugin channels, but §9 already says clients
   **ignore unknown `t` values** — so a JSON message is additive with no protocol version
   bump, and it is readable in a log. The reserved binary range stays reserved for a future
   high-rate channel.
6. **The cron parser is hand-rolled.** Every cron crate pulls `chrono`, and this workspace
   uses `time` deliberately (the shared core hand-rolls date arithmetic for parity by
   construction, SPEC §3.4). ~150 lines and fully testable beats a second date library
   forever. Non-standard syntax (`@daily`, seconds, `L`, `#`) is a parse error, so a manifest
   cannot mean two things on two servers.
7. **A `log` host function was added** (not in SPEC §6.3's list). A plugin with no way to
   log is a plugin you debug by making it fail, and anything it printed would miss the
   structured log's plugin id, request id and level.
8. **`PluginRecord` lives in `plugins.rs`, not `domain.rs`.** Every other Mongo shape is in
   `domain.rs`, and this one is the exception: that file is frozen and shared by every area,
   while this record is coupled to the manifest types in `plugins.rs`. Putting it there would
   mean a frozen file importing the plugin subsystem and a merge conflict for every builder.
9. **No `delete_document`, no `kv_list`.** `HOST-ABI.md` §8 argues both, and names what a v2
   would need.
10. **Host functions reach tokio through a stored `Handle`.** Extism calls are synchronous
    and run on `spawn_blocking` threads, so `handle.block_on(...)` inside a host function
    cannot starve the reactor. The rule that keeps it safe — never wait on a task that needs
    *this* thread — is written in `host_fns.rs` because it is the one place a deadlock is
    imaginable.
11. **The instance pool caches compiled modules and instances separately.** Compilation is
    expensive, instantiation is not; a trapped instance is **dropped, not reset**, because
    carrying one plugin bug into the next unrelated call is a failure nobody reproduces.
12. **The M3 carry-over is satisfied structurally, with no change to `statics.rs`.**
    `web/CONTRACTS.md` requires that `/plugins/:id/:version/*` — unauthenticated by necessity
    — keep `manifest.json` and `backend.wasm` unreachable. The M4 installer writes
    `backend.wasm` into the same version directory, and that route already refuses any path
    outside `frontend/` *before* resolving it (`statics::PLUGIN_ASSET_ROOT`). So the new file
    is unreachable by construction rather than by a check someone had to remember; the
    plugin-asset tests in `tests/statics.rs` should gain a case asserting exactly that
    (`/plugins/<id>/<version>/backend.wasm` → 404) when install-flow starts writing it.
13. **`calendar` and `agenda` are not in `BASE_PLUGIN_IDS`.** `?safe=1` boots the fourteen of
    SPEC §6.5; a recovery mode should not include the newest code. *(Moot since their
    removal: the base distribution and `BASE_PLUGIN_IDS` are the same fourteen again. The
    rule stands for the next plugin that ships in `plugins/base/` without being core.)*
14. **A record whose package is gone is retired at boot** (added 2026-09-24 with the
    calendar's removal). `adopt_installed_directory` reconciles both ways now: a directory
    with no record is adopted, and a record with no directory is switched off — otherwise
    dropping a plugin from the image leaves a row admin lists as `enabled`, a backend half
    the host tries to activate against a missing module, and a module URL every client 404s
    on. Three guards: nothing is touched when the scan found **no** plugins at all (an
    unmounted volume is not an uninstall), a record whose package sits in the staging tree
    is left alone (that is what `pending` is), and a record that is already `Disabled` is
    left exactly as it is, reason included — this pass runs on every boot, so anything it
    does unconditionally it does forever. **Retention is the uninstall's** — KV,
    `plugin_config` and `%%% <id>` sections survive, so putting the plugin back is lossless.

    **Disabled, not deleted** *(corrected 2026-09-25)*. The first cut deleted the record,
    and `adopt_installed_directory` then re-adopted a returning directory from scratch:
    `Enabled`, with the **manifest's full request** as the approved set, `disabled_reason`
    cleared and `cron_state` reset. So a boot-long absence — an image that drops a plugin
    and a rollback that restores it, an operator moving `<PLUGINS_DIR>/X` aside, a
    half-finished volume sync — silently undid an admin's capability narrowing *and* their
    disable, with no approval screen in between, and neither guard fired because other
    plugins were on disk and nothing was pending. The record is the only place those two
    decisions live, so it stays: `PluginState::is_active` is `Enabled` alone, which keeps
    the backend half down, and the registry is a scan of the directory, which keeps the
    frontend half unreachable — the ghost dies either way. `disabled_reason` is set to
    `plugininstall::ABSENT_DISABLED_REASON`, and **only** that marker is undone when the
    directory returns; an admin's own reason is never overwritten and never cleared.
    Adoption also stopped writing `capabilities_approved` for a record it already knows:
    the manifest's request is what an admin was *asked*, the record's set is what they
    *answered*, and a mismatch between the two is now a boot `WARN` instead of a silent
    widening. The one record still deleted is a `Pending` one with no package in either
    root — nothing was ever approved, so there is nothing to keep.
    `plugininstall_flow.rs::an_absence_does_not_undo_a_narrowing_or_an_admin_disable` is
    the regression net.

## What is deliberately still open

Items 1, 2, 4 and 5 of the M4 list are **closed** — `Registry::apply_states` is wired,
`plugins::resolve_import_map` is what `routes::statics::import_map` calls, the Dockerfile
has a `plugin-builder` stage, and the admin approval screen exists. What is left:

1. ~~**No `/readyz` plugin-host detail.**~~ **Closed (M5 polish).** `ReadyReport` gained a
   `plugin_host: CheckResult` alongside `plugins`, carrying the host's active /
   breaker-open / cron / instance / in-flight counts. Counts only and never gating, for
   the two reasons `routes::health::check_plugin_host` documents: the body is
   world-readable, and one plugin the breaker opened is not a reason to take a serving
   replica out of rotation. It reads through `PluginHost::existing`, which does not create
   a host — a probe must not make what it reports on true by asking.
2. **The convergence harness does not exercise plugin writes.** A plugin writing while three
   clients edit the same documents is the interesting M4 convergence case and the harness is
   the right place for it (SPEC §9 M2's gate, extended). The integration run did it by hand
   — two browsers open on a month view while the calendar's cron reconciled a changed feed —
   and that was a manual check, not a gate. With that plugin removed there is no longer any
   plugin in the tree that writes documents, so this gap is now **unreachable by the suite
   at all** rather than merely untested; closing it needs a document-writing fixture (extend
   `hello-backend`) as well as the harness work.
3. **A plugin's capability grant is immutable once approved.** `approve` refuses anything
   not in `Pending`, so widening `http.hosts` on a running plugin means uninstall (without
   purge, which is lossless) and reinstall. That is a real workflow an operator will hit
   the first time a feed moves host; `dev-docs/resolved/OPERATIONS.md` documents the workaround. A
   re-approval path on an enabled record is the fix.
4. **The upgrade pending window.** One record per plugin means installing 1.1.0 over an
   approved 1.0.0 sets the record to `pending` at 1.1.0 while 1.0.0 keeps serving.
   `capabilities_approved`, `approved_at/by` and `cron_state` are preserved across the
   window and a failed install rolls the record back verbatim, but a **restart inside that
   window does not re-activate the old backend half**. The fix is a separate "candidate"
   shape on `PluginRecord`, which the admin API is not written against.
5. ~~**`InstallError::AbiIncompatible` is unconstructed.**~~ **Closed (M5 polish):
   dropped.** Wiring it was not available — the ABI version is what the module's
   `lm_abi_version` export *returns*, which needs a compiled instance, so install cannot
   know it. The variant advertised a check that lives in `PluginHost::activate`
   (`PluginHostError::AbiMismatch`, surfaced on the record's `last_error`). What install
   can answer statically — "was this built with `lm::abi_version!()` at all" — it already
   answers, as a `Manifest` error.

## Commands

```
mise run check          # backend: fmt + check + clippy -D warnings (unchanged)
mise run test           # backend: cargo test --workspace --all-targets
mise run plugin-check   # the SDK + the plugin workspace, for wasm32
mise run wasm-plugins   # build backend halves into plugins/base/dist/<id>/<version>/
mise run plugin-smoke   # build hello-backend, load it in a minimal Extism host
mise run plugin-package # package a built plugin as the installable .zip of SPEC §6.2
mise run plugins        # frontend halves (unchanged)
```

`mise run check` deliberately does **not** cover `crates/plugin-sdk` or `plugins/**` — both
are wasm32-only. `plugin-check` is their gate, and both must pass before reporting done.

## Area: http-routes (PLUGIN-PROTOCOLS step 7: the wiring routes)

`routes/wiring.rs`, nested at `/api/wiring` by `routes/mod.rs`. Admin-only like
`/api/admin/*` (a non-admin gets 403, an anonymous caller 401), inside the `/api` body
limit. `LiveWiring` is `{ version, unplugged, bind, cut, add, order }` (flat), as
`wiring.json` is written.

| Route | Body | Response | Notes |
|---|---|---|---|
| `GET /api/wiring` | — | `{ live: LiveWiring, history: [{ version, action, actor?, subject?, at }…] }` | history newest first; `?limit=` default 50, max 200; `at` is RFC 3339 |
| `GET /api/wiring/versions/{v}` | — | `{ version, wiring, action, actor?, subject?, at }` | 404 when there is no such version |
| `POST /api/wiring/apply` | `{ base, wiring, action: "apply" \| "rollback" }` | `{ live: LiveWiring }` | writes `base + 1`; **409** when `base` is not the live version (nothing changes); any other `action` is 400 |

**Unplug is disable.** An apply whose `unplugged` lists an installed, switched-on plugin
moves that plugin's record to `disabled` (reason `admin`); one whose `unplugged` no longer
lists a `disabled` plugin moves it to `enabled`, breaker cleared, backend half activated.
These are `plugininstall::disable_record` / `enable_record` — the record halves of
`disable` / `enable`, without the wiring version those write, because the apply *is* the
version. The version is committed first, then the records; the audit entry
(`wiring.apply` / `wiring.rollback`) is the store's, and every socket hears
`wiring.applied` once.
