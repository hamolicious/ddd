use super::plan::PlanError;
use super::project::SqlValue;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn encode_cursor(values: &[SqlValue]) -> String {
    let json = serde_json::to_string(values).unwrap_or_else(|_| "[]".into());
    let bytes = json.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let symbols = chunk.len() + 1;
        for index in 0..symbols {
            out.push(ALPHABET[((n >> (18 - 6 * index)) & 63) as usize] as char);
        }
    }
    out
}

pub fn decode_cursor(cursor: &str) -> Result<Vec<SqlValue>, PlanError> {
    let bad = || PlanError::BadValue("the cursor is not valid".into());
    let mut bytes = Vec::with_capacity(cursor.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for c in cursor.bytes() {
        let value = ALPHABET.iter().position(|a| *a == c).ok_or_else(bad)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    let values: Vec<serde_json::Value> = serde_json::from_slice(&bytes).map_err(|_| bad())?;
    values
        .into_iter()
        .map(|value| match value {
            serde_json::Value::Null => Ok(SqlValue::Null),
            serde_json::Value::String(text) => Ok(SqlValue::Text(text)),
            serde_json::Value::Number(n) => match n.as_i64() {
                Some(i) => Ok(SqlValue::Int(i)),
                None => n.as_f64().map(SqlValue::Real).ok_or_else(bad),
            },
            serde_json::Value::Bool(b) => Ok(SqlValue::Int(i64::from(b))),
            _ => Err(bad()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip() {
        let values = [
            SqlValue::Text("ünï \"q\"".into()),
            SqlValue::Int(-3),
            SqlValue::Real(1.5),
            SqlValue::Null,
        ];
        for take in 0..=values.len() {
            assert_eq!(
                decode_cursor(&encode_cursor(&values[..take])).unwrap(),
                values[..take]
            );
        }
    }

    #[test]
    fn garbage_is_a_plan_error() {
        assert!(decode_cursor("***").is_err());
        assert!(decode_cursor(&encode_cursor(&[])[..1]).is_err());
    }
}
