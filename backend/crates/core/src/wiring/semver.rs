//! The semver subset protocol ranges use: `*`, `^x[.y[.z]]`, `~x[.y[.z]]`, `=x.y.z`, an
//! exact `x.y.z` (to the precision written), and `>=`, `>`, `<=`, `<`.
//!
//! The same semantics as the server's `plugins::satisfies` and the web kernel's `satisfies`
//! for every form those accept: caret pins the left-most non-zero component, tilde pins the
//! minor when one is written, and a bare version is exact to the precision written.
//! Prerelease and build tails are ignored when comparing.

use std::cmp::Ordering;

/// `1`, `1.2` or `1.2.3` → the triple and how many components were written.
fn parse(input: &str) -> Option<([u64; 3], usize)> {
    let core = input.split(['-', '+']).next()?;
    if core.is_empty() {
        return None;
    }
    let mut out = [0u64; 3];
    let mut written = 0;
    for (index, part) in core.split('.').enumerate() {
        if index == 3 || part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        out[index] = part.parse().ok()?;
        written = index + 1;
    }
    Some((out, written))
}

/// Order two versions by their numeric triple; unparseable sorts lowest.
pub fn compare(a: &str, b: &str) -> Ordering {
    let triple = |v: &str| parse(v).map(|(t, _)| t).unwrap_or([0, 0, 0]);
    triple(a).cmp(&triple(b))
}

/// Does `version` satisfy `range`? An unparseable version or range is `false`.
pub fn satisfies(version: &str, range: &str) -> bool {
    let Some((actual, _)) = parse(version) else {
        return false;
    };
    let range = range.trim();
    if range == "*" || range.is_empty() {
        return true;
    }
    let (operator, bare) = ["^", "~", ">=", "<=", "=", ">", "<"]
        .iter()
        .find_map(|op| range.strip_prefix(op).map(|rest| (*op, rest)))
        .unwrap_or(("", range));
    let Some((floor, written)) = parse(bare) else {
        return false;
    };
    match operator {
        ">=" => actual >= floor,
        ">" => actual > floor,
        "<=" => actual <= floor,
        "<" => actual < floor,
        _ if actual < floor => false,
        "^" => {
            if floor[0] > 0 {
                actual[0] == floor[0]
            } else if floor[1] > 0 || written >= 2 {
                actual[0] == 0 && actual[1] == floor[1]
            } else {
                actual[0] == 0
            }
        }
        "~" => {
            if written >= 2 {
                actual[0] == floor[0] && actual[1] == floor[1]
            } else {
                actual[0] == floor[0]
            }
        }
        _ => match written {
            1 => actual[0] == floor[0],
            2 => actual[0] == floor[0] && actual[1] == floor[1],
            _ => actual == floor,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        let cases = [
            ("1.2.0", "^1.0", true),
            ("2.0.0", "^1.0", false),
            ("1.0.9", "^1.1", false),
            ("0.2.5", "^0.2.1", true),
            ("0.3.0", "^0.2.1", false),
            ("1.2.9", "~1.2.0", true),
            ("1.3.0", "~1.2.0", false),
            ("1.9.0", "~1", true),
            ("1.2.3", "1.2.3", true),
            ("1.2.4", "1.2.3", false),
            ("1.2.4", "1.2", true),
            ("3.0.0", ">=1.0.0", true),
            ("1.0.0", "<1.0.0", false),
            ("5.1.0", "*", true),
            ("1.0.0-beta.1", "^1.0", true),
            ("x", "^1.0", false),
            ("1.0.0", "^x", false),
        ];
        for (version, range, want) in cases {
            assert_eq!(satisfies(version, range), want, "{version} in {range}");
        }
        assert_eq!(compare("1.10.0", "1.9.9"), Ordering::Greater);
    }
}
