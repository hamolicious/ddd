//! Hardening caps, enforced at parse time (SPEC §3.4, §3.5).
//!
//! These are constants, not configuration: both sides must agree exactly.

/// Frontmatter block (fences excluded) larger than this is not parsed; the text
/// is left untouched and `fm_parse_error` is set.
pub const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
/// Maximum number of keys materialized out of one frontmatter block.
pub const MAX_FRONTMATTER_KEYS: usize = 200;
/// Maximum nesting depth of maps/sequences inside frontmatter.
pub const MAX_NESTING_DEPTH: usize = 5;
/// Maximum items in a flow or frontmatter block sequence.
pub const MAX_ARRAY_ITEMS: usize = 1000;
/// Maximum byte length of a single string scalar.
pub const MAX_STRING_VALUE_BYTES: usize = 8 * 1024;
/// Hard cap on full document text (SPEC §3.5).
pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
/// Body-line fallback title is truncated to this many *characters* (SPEC §3.4).
pub const TITLE_FALLBACK_MAX_CHARS: usize = 120;
/// Maximum number of `%%%` machine sections in one document.
pub const MAX_MACHINE_SECTIONS: usize = 64;
/// Maximum byte length of one `%%%` section body.
pub const MAX_SECTION_BYTES: usize = 64 * 1024;
/// Maximum keys materialized out of one `%%%` section.
pub const MAX_SECTION_KEYS: usize = 200;
/// Title used when nothing else resolves.
pub const UNTITLED: &str = "Untitled";

/// Frontmatter / section keys must match `^[A-Za-z0-9_-]{1,64}$`.
/// Non-conforming keys are dropped from `fm` (text untouched) and recorded.
pub const MAX_KEY_LEN: usize = 64;

/// `true` iff `key` matches `^[A-Za-z0-9_-]{1,64}$` (no regex dependency).
pub fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
