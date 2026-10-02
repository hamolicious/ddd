#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod call;
pub mod config;
pub mod cron;
pub mod documents;
pub mod error;
pub mod events;
pub mod hooks;
pub mod http;
pub mod kv;
pub mod limits;
pub mod log;
pub mod names;

pub use error::{ErrorCode, HostError};

pub const ABI_VERSION: u32 = 1;

pub type JsonMap = BTreeMap<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(bound(serialize = "T: Serialize", deserialize = "T: Deserialize<'de>"))]
pub struct Envelope<T> {
    pub ok: bool,
    #[serde(default = "Option::default", skip_serializing_if = "Option::is_none")]
    pub value: Option<T>,
    #[serde(default = "Option::default", skip_serializing_if = "Option::is_none")]
    pub error: Option<HostError>,
}

impl<T> Envelope<T> {
    pub fn ok(value: T) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    pub fn empty() -> Self {
        Self {
            ok: true,
            value: None,
            error: None,
        }
    }

    pub fn err(error: HostError) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(error),
        }
    }

    pub fn into_result(self) -> Result<Option<T>, HostError> {
        if self.ok {
            Ok(self.value)
        } else {
            Err(self.error.unwrap_or_else(|| {
                HostError::new(ErrorCode::Internal, "host returned a refusal with no error")
            }))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Origin {
    User { id: String },
    Plugin { id: String },
    System,
}

impl Origin {
    pub fn is_plugin(&self, plugin_id: &str) -> bool {
        matches!(self, Origin::Plugin { id } if id == plugin_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitPayload {
    pub plugin_id: String,
    pub version: String,
    pub abi_version: u32,
    pub capabilities: Capabilities,
    pub config_keys: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    #[serde(default)]
    pub documents: Vec<String>,
    #[serde(default)]
    pub http_hosts: Vec<String>,
    #[serde(default)]
    pub public_routes: Vec<String>,
    #[serde(default)]
    pub notifications: bool,
}

impl Capabilities {
    pub fn can_read_documents(&self) -> bool {
        self.documents.iter().any(|c| c == "read")
    }

    pub fn can_write_documents(&self) -> bool {
        self.documents.iter().any(|c| c == "write")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_envelope_discriminates_on_ok() {
        let ok: Envelope<u32> = Envelope::ok(7);
        assert_eq!(
            serde_json::to_string(&ok).unwrap(),
            r#"{"ok":true,"value":7}"#
        );
        assert_eq!(
            serde_json::to_string(&Envelope::<u32>::empty()).unwrap(),
            r#"{"ok":true}"#
        );

        let err: Envelope<u32> = Envelope::err(HostError::new(
            ErrorCode::CapabilityDenied,
            "documents:read is not approved",
        ));
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""ok":false"#));
        assert!(json.contains(r#""code":"capability_denied""#));

        let round: Envelope<u32> = serde_json::from_str(&json).unwrap();
        assert!(round.into_result().is_err());
    }

    #[test]
    fn an_origin_identifies_the_plugin_that_must_not_be_notified() {
        let origin = Origin::Plugin {
            id: "calendar".to_string(),
        };
        assert!(origin.is_plugin("calendar"));
        assert!(!origin.is_plugin("agenda"));
        assert!(!Origin::System.is_plugin("calendar"));
        assert_eq!(
            serde_json::to_string(&origin).unwrap(),
            r#"{"kind":"plugin","id":"calendar"}"#
        );
    }
}
