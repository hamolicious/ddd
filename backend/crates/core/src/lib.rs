pub mod date;
pub mod diagnostics;
pub mod document;
pub mod error;
pub mod filter;
pub mod frontmatter;
pub mod limits;
pub mod query;
pub mod sections;
pub mod shape;
pub mod splice;
pub mod title;
pub mod value;

#[cfg(feature = "wasm")]
pub mod wasm;

mod yaml;

pub use date::{Date, DateError, DatePrecision};
pub use diagnostics::{Diagnostic, DiagnosticKind};
pub use document::{ParsedDocument, Span, normalize_input, parse_document};
pub use error::CoreError;
pub use filter::{CompareOp, Filter, Literal, Row};
pub use frontmatter::Frontmatter;
pub use sections::{MachineSection, Sections};
pub use value::{Map, Value};

pub const CORE_SEMANTICS_VERSION: u32 = 3;
