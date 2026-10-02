use serde::{Deserialize, Serialize};

use crate::JsonMap;

pub type Headers = JsonMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequestInput {
    pub method: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "JsonMap::is_empty")]
    pub headers: Headers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default = "crate::documents::default_true")]
    pub follow_redirects: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponseOutput {
    pub status: u16,
    #[serde(default)]
    pub headers: Headers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    pub body_bytes: u64,
    pub final_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestUser {
    pub id: String,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRouteRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: JsonMap,
    #[serde(default)]
    pub headers: Headers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    pub public: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<RequestUser>,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRouteResponse {
    pub status: u16,
    #[serde(default, skip_serializing_if = "JsonMap::is_empty")]
    pub headers: Headers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
}

impl HttpRouteResponse {
    pub fn json(status: u16, body: &serde_json::Value) -> Self {
        let mut headers = JsonMap::new();
        headers.insert(
            "content-type".to_string(),
            serde_json::Value::String("application/json".to_string()),
        );
        Self {
            status,
            headers,
            body_base64: Some(base64_encode(body.to_string().as_bytes())),
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: JsonMap::new(),
            body_base64: None,
        }
    }
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return Err("not base64"),
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_including_the_padding_cases() {
        for case in [
            &b""[..],
            &b"f"[..],
            &b"fo"[..],
            &b"foo"[..],
            &b"foob"[..],
            &b"fooba"[..],
            &b"foobar"[..],
            &[0u8, 255, 128, 1][..],
        ] {
            let encoded = base64_encode(case);
            assert_eq!(base64_decode(&encoded).unwrap(), case, "{encoded}");
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert!(base64_decode("not base64!").is_err());
    }

    #[test]
    fn a_json_route_response_carries_its_content_type() {
        let response = HttpRouteResponse::json(200, &serde_json::json!({"ok": true}));
        assert_eq!(response.status, 200);
        assert_eq!(
            response
                .headers
                .get("content-type")
                .and_then(|v| v.as_str()),
            Some("application/json")
        );
        let body = base64_decode(response.body_base64.as_deref().unwrap()).unwrap();
        assert_eq!(String::from_utf8(body).unwrap(), r#"{"ok":true}"#);
    }
}
