pub const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
pub const MAX_FRONTMATTER_KEYS: usize = 200;
pub const MAX_NESTING_DEPTH: usize = 5;
pub const MAX_ARRAY_ITEMS: usize = 1000;
pub const MAX_STRING_VALUE_BYTES: usize = 8 * 1024;
pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
pub const TITLE_FALLBACK_MAX_CHARS: usize = 120;
pub const MAX_MACHINE_SECTIONS: usize = 64;
pub const MAX_SECTION_BYTES: usize = 64 * 1024;
pub const MAX_SECTION_KEYS: usize = 200;
pub const UNTITLED: &str = "Untitled";

pub const MAX_KEY_LEN: usize = 64;

pub fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
