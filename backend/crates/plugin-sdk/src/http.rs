//! Outbound HTTP — `http: { hosts: [...] }`.
//!
//! The host resolves the name, checks every address against the IP policy, pins the one
//! it dialled and re-checks each redirect (SPEC §6.2). A refusal is
//! [`Blocked`](crate::ErrorCode::Blocked) when the *destination* is not allowed and
//! [`CapabilityDenied`](crate::ErrorCode::CapabilityDenied) when the capability is not
//! approved — two different fixes, so two different codes.

use crate::abi::http::{HttpRequestInput, HttpResponseOutput, base64_decode};
use crate::abi::{ErrorCode, HostError, JsonMap};
use crate::host::{self, call_value};

/// A request with defaults filled in: no body, host timeout, redirects followed.
pub fn request(input: &HttpRequestInput) -> crate::Result<Response> {
    let output: HttpResponseOutput = call_value(host::http_request, input)?;
    Ok(Response(output))
}

/// `GET url`.
pub fn get(url: &str) -> crate::Result<Response> {
    request(&HttpRequestInput {
        method: "GET".to_string(),
        url: url.to_string(),
        headers: JsonMap::new(),
        body_base64: None,
        timeout_ms: None,
        follow_redirects: true,
    })
}

/// `GET url` with headers — an `Authorization` or an `If-None-Match` for a feed poll.
pub fn get_with_headers(url: &str, headers: JsonMap) -> crate::Result<Response> {
    request(&HttpRequestInput {
        method: "GET".to_string(),
        url: url.to_string(),
        headers,
        body_base64: None,
        timeout_ms: None,
        follow_redirects: true,
    })
}

/// `POST url` with a JSON body.
pub fn post_json(url: &str, body: &serde_json::Value) -> crate::Result<Response> {
    let mut headers = JsonMap::new();
    headers.insert(
        "content-type".to_string(),
        serde_json::Value::String("application/json".to_string()),
    );
    request(&HttpRequestInput {
        method: "POST".to_string(),
        url: url.to_string(),
        headers,
        body_base64: Some(crate::abi::http::base64_encode(body.to_string().as_bytes())),
        timeout_ms: None,
        follow_redirects: true,
    })
}

/// A response with the body decoding conveniences attached.
#[derive(Debug, Clone)]
pub struct Response(pub HttpResponseOutput);

impl Response {
    /// The HTTP status of the final hop.
    pub fn status(&self) -> u16 {
        self.0.status
    }

    /// `true` for 2xx.
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.0.status)
    }

    /// One response header, lowercased key.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.0
            .headers
            .get(&name.to_ascii_lowercase())
            .and_then(|value| value.as_str())
    }

    /// The raw body.
    pub fn bytes(&self) -> crate::Result<Vec<u8>> {
        match self.0.body_base64.as_deref() {
            None => Ok(Vec::new()),
            Some(encoded) => base64_decode(encoded).map_err(|err| {
                HostError::new(
                    ErrorCode::Internal,
                    format!("the host returned a body this SDK could not decode: {err}"),
                )
            }),
        }
    }

    /// The body as UTF-8 text. Invalid bytes are an error, not a lossy string: a feed
    /// parser that silently gets U+FFFD produces documents nobody can explain.
    pub fn text(&self) -> crate::Result<String> {
        String::from_utf8(self.bytes()?).map_err(|err| {
            HostError::new(
                ErrorCode::InvalidArgument,
                format!("the response body is not UTF-8: {err}"),
            )
        })
    }

    /// The body parsed as JSON.
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> crate::Result<T> {
        serde_json::from_slice(&self.bytes()?).map_err(|err| {
            HostError::new(
                ErrorCode::InvalidArgument,
                format!("the response body is not the expected JSON: {err}"),
            )
        })
    }

    /// `Err(ErrorCode::Unavailable)` for a non-2xx status, so `?` reads naturally in a
    /// sync job that has nothing useful to do with a 503.
    pub fn error_for_status(self) -> crate::Result<Self> {
        if self.is_success() {
            Ok(self)
        } else {
            Err(HostError::new(
                ErrorCode::Unavailable,
                format!("the upstream answered {}", self.0.status),
            ))
        }
    }
}
