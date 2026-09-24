//! One-line YAML scalars, written the way the shared core reads them.
//!
//! **Why a plugin hand-rolls this.** The core's `Value::to_yaml_inline` is the authority
//! on the strict YAML subset (SPEC §3.4) and the host uses it for `splice_section` — but
//! this crate is a plain, dependency-free crate compiled to wasm32 beside the plugin, and
//! pulling `life-manager-core` in for one function would drag `bson`-gated code and a
//! second copy of the date arithmetic into every plugin that renders a document. So the
//! rule is mirrored here, and mirrored **conservatively**:
//!
//! > Over-quoting is harmless — `"2026"` and `2026` read back as different *types*, but
//! > `"work/ops"` and `work/ops` read back as the same string. Under-quoting is a
//! > corrupted document. Every uncertain case is therefore quoted.
//!
//! The one deliberate exception is a canonical timestamp: `2026-09-24T09:00:00Z` contains
//! a `:` and the core would quote it, but an unquoted date is what SPEC §3.3's example
//! shows, what a human editing the frontmatter expects, and what Obsidian's date pickers
//! read. It is provably safe — a stamp from [`crate::normalize_datetime`] is digits and
//! `-`, `T`, `:`, `Z`, starts with a digit, and contains no `#`, quote or bracket — so the
//! exception is a whitelist of exactly that shape rather than a loosened rule.

/// One frontmatter or section value, as a single-line YAML scalar.
pub(crate) fn scalar(value: &str) -> String {
    if needs_quoting(value) {
        quote(value)
    } else {
        value.to_string()
    }
}

/// `key: value` line, ready to join into a block.
pub(crate) fn line(key: &str, value: &str) -> String {
    format!("{key}: {}", scalar(value))
}

/// `key: true` / `key: false` — a bool is never quoted; that is the point of it.
pub(crate) fn bool_line(key: &str, value: bool) -> String {
    format!("{key}: {value}")
}

/// `key: 3` — an integer, unquoted so the core materializes it as an int.
pub(crate) fn int_line(key: &str, value: i64) -> String {
    format!("{key}: {value}")
}

fn needs_quoting(s: &str) -> bool {
    if s.is_empty() || s != s.trim() {
        return true;
    }
    if is_canonical_stamp(s) {
        return false;
    }
    if looks_typed(s) {
        return true;
    }
    // `#` and the flow indicators change how the core's per-line parser reads the value;
    // `:` would too in a nested position, and a control character has no plain form.
    if s.bytes().any(|byte| {
        matches!(
            byte,
            b'\n' | b'\r' | b'\t' | b'#' | b',' | b'[' | b']' | b'{' | b'}' | b':' | b'"' | b'\''
        ) || byte < 0x20
    }) {
        return true;
    }
    // A leading indicator makes the value a YAML construct instead of a string.
    matches!(
        s.as_bytes()[0],
        b'-' | b'?' | b'&' | b'*' | b'!' | b'|' | b'>' | b'%' | b'@' | b'`'
    )
}

/// Would this text read back as something other than a string?
fn looks_typed(s: &str) -> bool {
    matches!(
        s,
        "null" | "Null" | "NULL" | "~" | "true" | "True" | "TRUE" | "false" | "False" | "FALSE"
    ) || s.parse::<i64>().is_ok()
        || s.parse::<f64>().is_ok()
}

/// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS` with an optional `Z` — the two shapes
/// [`crate::normalize_datetime`] emits, and nothing else.
fn is_canonical_stamp(s: &str) -> bool {
    let bytes = s.as_bytes();
    let date = |b: &[u8]| {
        b.len() == 10
            && b[..4].iter().all(u8::is_ascii_digit)
            && b[4] == b'-'
            && b[5..7].iter().all(u8::is_ascii_digit)
            && b[7] == b'-'
            && b[8..10].iter().all(u8::is_ascii_digit)
    };
    match bytes.len() {
        10 => date(bytes),
        19 | 20 => {
            let stamp = if bytes.len() == 20 {
                if bytes[19] != b'Z' {
                    return false;
                }
                &bytes[..19]
            } else {
                bytes
            };
            date(&stamp[..10])
                && stamp[10] == b'T'
                && stamp[11..13].iter().all(u8::is_ascii_digit)
                && stamp[13] == b':'
                && stamp[14..16].iter().all(u8::is_ascii_digit)
                && stamp[16] == b':'
                && stamp[17..19].iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

/// Double-quoted, with the core's escape set (`\"`, `\\`, `\n`, `\r`, `\t`, `\uXXXX`).
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_values_stay_plain() {
        for plain in [
            "Standup",
            "calendar/work",
            "work",
            "a b c",
            "Café",
            "2026-09-24",
        ] {
            assert_eq!(scalar(plain), plain, "{plain} should not be quoted");
        }
    }

    #[test]
    fn canonical_stamps_are_the_one_colon_exception() {
        assert_eq!(scalar("2026-09-24T09:00:00Z"), "2026-09-24T09:00:00Z");
        assert_eq!(scalar("2026-09-24T09:00:00"), "2026-09-24T09:00:00");
        // Anything that only *resembles* one is quoted, because the safety argument
        // (digits and separators, no `#`, no quote) no longer holds.
        assert_eq!(scalar("2026-09-24T09:00"), "\"2026-09-24T09:00\"");
        assert_eq!(scalar("09:00"), "\"09:00\"");
        assert_eq!(
            scalar("2026-09-24T09:00:00+02:00"),
            "\"2026-09-24T09:00:00+02:00\""
        );
    }

    #[test]
    fn everything_the_core_would_reread_as_another_type_is_quoted() {
        for typed in ["42", "-1", "3.5", "true", "FALSE", "null", "~", "1e9"] {
            assert_eq!(scalar(typed), format!("\"{typed}\""), "{typed}");
        }
    }

    #[test]
    fn structural_characters_force_quotes() {
        assert_eq!(scalar("Standup: daily"), "\"Standup: daily\"");
        assert_eq!(scalar("budget #3"), "\"budget #3\"");
        assert_eq!(scalar("[draft]"), "\"[draft]\"");
        assert_eq!(scalar("- bullet"), "\"- bullet\"");
        assert_eq!(scalar("  padded  "), "\"  padded  \"");
        assert_eq!(scalar(""), "\"\"");
    }

    #[test]
    fn quoting_escapes_the_way_the_core_unescapes() {
        assert_eq!(scalar("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(scalar("two\nlines"), "\"two\\nlines\"");
        assert_eq!(scalar("bell\u{7}"), "\"bell\\u0007\"");
        // A backslash is not a YAML indicator in a *plain* scalar and the core does not
        // unescape one there, so `C:\x` stays plain — but once anything else forces quotes,
        // the backslash has to be escaped or the closing quote moves.
        assert_eq!(scalar("a\\b"), "a\\b");
        assert_eq!(scalar("a\\b: c"), "\"a\\\\b: c\"");
    }

    #[test]
    fn typed_lines_are_unquoted_so_the_core_materializes_the_type() {
        assert_eq!(bool_line("all-day", true), "all-day: true");
        assert_eq!(int_line("sequence", 3), "sequence: 3");
        assert_eq!(line("feed", "work"), "feed: work");
        assert_eq!(line("feed", "3"), "feed: \"3\"");
    }
}
