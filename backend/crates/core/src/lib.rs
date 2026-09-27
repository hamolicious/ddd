//! Life Manager shared core.
//!
//! Everything in this crate is used *identically* by the Rust server and by the
//! client kernel (compiled to wasm32). Parity between offline and online
//! behaviour is by construction — SPEC §2, §3.4, §4.2.
//!
//! Rules for this crate:
//! - No server dependencies (no tokio, axum, mongodb). `bson` only behind the
//!   `mongo` feature, and only for [`filter::mongo`].
//! - Every function here must be deterministic and stateless: the same input
//!   text always yields the same output on both sides.
//! - Byte-exact fence handling; tolerant parsing (a malformed line or block-sequence
//!   item is dropped and recorded, never fatal).

pub mod date;
pub mod diagnostics;
pub mod document;
pub mod error;
pub mod filter;
pub mod frontmatter;
pub mod limits;
pub mod sections;
pub mod splice;
pub mod title;
pub mod value;

/// The wasm-bindgen ABI the client kernel imports (feature `wasm`; SPEC §2).
/// Built by `mise run wasm` into `web/kernel/src/wasm/pkg/`.
#[cfg(feature = "wasm")]
pub mod wasm;

/// The strict-subset YAML line machinery shared by `frontmatter` and `sections`.
/// Private: the public surface is the two parsers, never the line primitives.
mod yaml;

pub use date::{Date, DateError, DatePrecision};
pub use diagnostics::{Diagnostic, DiagnosticKind};
pub use document::{ParsedDocument, Span, normalize_input, parse_document};
pub use error::CoreError;
pub use filter::{CompareOp, Filter, Literal, Row};
pub use frontmatter::Frontmatter;
pub use sections::{MachineSection, Sections};
pub use value::{Map, Value};

/// Version of the shared-core semantics. Bumped when parsing or evaluation
/// output changes in a way that invalidates materialized data.
pub const CORE_SEMANTICS_VERSION: u32 = 2;
