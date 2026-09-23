# M1 build contracts

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
    MalformedUpdate, Contended, SnapshotNotFound, Db, Bson, Other }

#[async_trait]
pub trait DocStore: Send + Sync + 'static {
    async fn create(&self, id: Option<Id>, text: &str, actor: &Actor) -> Result<WriteOutcome, DocStoreError>;
    async fn replace_text(&self, id: &str, text: &str, actor: &Actor) -> Result<WriteOutcome, DocStoreError>;
    async fn apply_edits(&self, id: &str, edits: &[core::splice::TextEdit], actor: &Actor) -> Result<WriteOutcome, DocStoreError>;
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
  413, **MIME sniffed** from bytes, `X-Content-Type-Options: nosniff` on every
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
  start without it. `MONGO_URI` required. `MAX_ATTACHMENT_BYTES` default 25 MiB.
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
    pub plugins: CheckResult, pub schema_version: i32, pub uptime_secs: u64, pub version: &'static str }
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
