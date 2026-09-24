//! `http_request` (outbound) and the inbound HTTP route contract.
//!
//! # Outbound
//!
//! The capability is `http: { hosts: [...] }` and it is **parameterized** (SPEC §6.2):
//! the declared hosts are the allowlist, matched exactly and case-insensitively — no
//! wildcards, no suffix matching, because `evil-calendar.google.com.attacker.test` is
//! what suffix matching buys.
//!
//! The host then does what a naive client does not:
//!
//! 1. **Resolves the name itself** and checks every returned address against the IP
//!    policy (loopback, RFC1918, link-local, unique-local, CGNAT, multicast and the
//!    cloud metadata addresses are refused by default; an admin may allow specific
//!    CIDRs).
//! 2. **Pins the address it dialled**, so a name that passed the check cannot be
//!    re-resolved to `169.254.169.254` between the check and the connection.
//! 3. **Re-checks every redirect hop** against both the declared hosts and the IP policy.
//!
//! Bodies are base64 in both directions. One wire format, no "is this field text or
//! bytes" ambiguity, and an ICS feed is bytes until the plugin decides otherwise. The
//! response cap is enforced on the **raw** body and exceeding it is an error, never a
//! silent truncation: half an ICS feed would produce confidently wrong documents.
//!
//! # Inbound
//!
//! `/api/plugins/<id>/<path>` reaches the plugin's `lm_http` export. Session-authenticated
//! by default; paths listed in `capabilities.public-routes` are reachable without a
//! session and are shown to the admin as the capability they are (SPEC §5.1, §6.2).

use serde::{Deserialize, Serialize};

use crate::JsonMap;

/// Request headers/response headers, lowercased keys, single value each.
///
/// Multi-value headers are deliberately not representable: they exist mainly for
/// `Set-Cookie`, which this ABI strips in both directions (a plugin does not run a cookie
/// jar, and a plugin route does not mint cookies for this app's origin).
pub type Headers = JsonMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequestInput {
    /// `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`.
    pub method: String,
    /// Absolute `http`/`https` URL. Its host must be in the approved
    /// `capabilities.http.hosts`.
    pub url: String,
    #[serde(default, skip_serializing_if = "JsonMap::is_empty")]
    pub headers: Headers,
    /// Request body, base64 (standard, padded). ≤
    /// [`crate::limits::MAX_HTTP_REQUEST_BODY_BYTES`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    /// May only *lower* [`crate::limits::HTTP_TIMEOUT_MS`], and is additionally capped by
    /// the invocation's remaining deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Follow up to [`crate::limits::MAX_HTTP_REDIRECTS`] hops, each re-checked. Default
    /// `true`.
    #[serde(default = "crate::documents::default_true")]
    pub follow_redirects: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponseOutput {
    pub status: u16,
    #[serde(default)]
    pub headers: Headers,
    /// Response body, base64. Absent for an empty body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    /// Raw body length in bytes, before encoding.
    pub body_bytes: u64,
    /// The URL of the last hop, after redirects.
    pub final_url: String,
}

// ---------------------------------------------------------------------------
// Inbound: what `lm_http` receives and returns
// ---------------------------------------------------------------------------

/// The authenticated caller of a plugin route, when there is one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestUser {
    pub id: String,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRouteRequest {
    pub method: String,
    /// The path **inside** the plugin's namespace: `/api/plugins/calendar/webhook`
    /// arrives as `/webhook`. Always starts with `/`, never contains `..`.
    pub path: String,
    #[serde(default)]
    pub query: JsonMap,
    /// Inbound headers, filtered: `cookie`, `authorization` and the hop-by-hop set are
    /// removed. A plugin route never sees this app's session credential — it is not the
    /// plugin's to forward, and a plugin that wants the caller's identity gets
    /// [`HttpRouteRequest::user`].
    #[serde(default)]
    pub headers: Headers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    /// `true` when the route was declared public and the request carried no session.
    pub public: bool,
    /// `None` on a public route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<RequestUser>,
    /// The server's request id, so a plugin's log line and the server's join up.
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRouteResponse {
    /// 200–599. Anything else, or a malformed response, becomes a 502 with
    /// `plugin_response_invalid` and counts as a plugin failure.
    pub status: u16,
    #[serde(default, skip_serializing_if = "JsonMap::is_empty")]
    pub headers: Headers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
}

impl HttpRouteResponse {
    /// `200 application/json` with `body` serialized.
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

    /// A body-less response (204, 202 for a webhook).
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: JsonMap::new(),
            body_base64: None,
        }
    }
}

/// Standard base64 with padding — the one encoding this ABI uses, implemented here so
/// the ABI crate stays dependency-free for plugins that link it into Wasm.
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

/// Decode standard base64 (padding optional, whitespace rejected).
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
