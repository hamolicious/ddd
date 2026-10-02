use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ddd_plugin_abi as abi;
use hkdf::Hkdf;
use rand::Rng as _;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tracing::warn;

use crate::config::Config;
use crate::db;
use crate::domain::{Actor, AuditEntry, Timestamp};
use crate::plugins::ConfigField;
use crate::state::AppState;

use super::InstallError;

pub const KEY_INFO: &[u8] = b"ddd/plugin-config/v1";
pub const CONFIG_KEY_VAR: &str = "CONFIG_KEY";
pub const SECRET_PLACEHOLDER: &str = "••••••••";

const SEAL_VERSION: u8 = 1;
const AAD_SEPARATOR: u8 = 0x1f;
pub const MAX_CONFIG_VALUE_BYTES: usize = 8 * 1024;
pub const MAX_CONFIG_KEYS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SealedValue {
    pub v: u8,
    pub nonce: String,
    pub ct: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StoredValue {
    Sealed { secret: SealedValue },
    Plain(serde_json::Value),
}

#[derive(Clone)]
pub struct ConfigCipher {
    key: [u8; 32],
}

impl std::fmt::Debug for ConfigCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ConfigCipher(<redacted>)")
    }
}

impl ConfigCipher {
    pub fn from_config(config: &Config) -> Result<Self, InstallError> {
        let mut key = [0u8; 32];
        match config.plugin_config_key.as_ref() {
            Some(explicit) if explicit.as_bytes().len() == 32 => {
                key.copy_from_slice(explicit.as_bytes());
            }
            Some(other) => derive(other.as_bytes(), &mut key)?,
            None => derive(config.session_secret.as_bytes(), &mut key)?,
        }
        Ok(ConfigCipher { key })
    }

    pub fn seal(
        &self,
        plugin_id: &str,
        key: &str,
        plaintext: &str,
    ) -> Result<SealedValue, InstallError> {
        let cipher = XChaCha20Poly1305::new_from_slice(&self.key)
            .map_err(|_| InstallError::Internal(anyhow::anyhow!("config key is not 32 bytes")))?;
        let mut nonce = [0u8; 24];
        rand::rng().fill_bytes(&mut nonce);
        let aad = aad(plugin_id, key);
        let ciphertext = cipher
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(|_| {
                InstallError::Internal(anyhow::anyhow!("sealing a config value failed"))
            })?;
        Ok(SealedValue {
            v: SEAL_VERSION,
            nonce: B64.encode(nonce),
            ct: B64.encode(ciphertext),
        })
    }

    pub fn open(
        &self,
        plugin_id: &str,
        key: &str,
        sealed: &SealedValue,
    ) -> Result<String, InstallError> {
        if sealed.v != SEAL_VERSION {
            return Err(InstallError::Config(format!(
                "stored secret uses format version {}, this server writes {SEAL_VERSION}",
                sealed.v
            )));
        }
        let cipher = XChaCha20Poly1305::new_from_slice(&self.key)
            .map_err(|_| InstallError::Internal(anyhow::anyhow!("config key is not 32 bytes")))?;
        let nonce = B64
            .decode(&sealed.nonce)
            .map_err(|_| InstallError::Config("stored secret has a malformed nonce".into()))?;
        let Ok(nonce) = <&XNonce>::try_from(nonce.as_slice()) else {
            return Err(InstallError::Config(
                "stored secret has a malformed nonce".into(),
            ));
        };
        let ciphertext = B64
            .decode(&sealed.ct)
            .map_err(|_| InstallError::Config("stored secret is malformed".into()))?;
        let aad = aad(plugin_id, key);
        let plaintext = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                InstallError::Config(
                    "stored secret could not be decrypted with the current key".into(),
                )
            })?;
        String::from_utf8(plaintext)
            .map_err(|_| InstallError::Config("stored secret is not UTF-8".into()))
    }
}

fn derive(ikm: &[u8], out: &mut [u8; 32]) -> Result<(), InstallError> {
    Hkdf::<Sha256>::new(None, ikm)
        .expand(KEY_INFO, out)
        .map_err(|_| InstallError::Internal(anyhow::anyhow!("deriving the config key failed")))
}

fn aad(plugin_id: &str, key: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(plugin_id.len() + key.len() + 3);
    aad.extend_from_slice(plugin_id.as_bytes());
    aad.push(AAD_SEPARATOR);
    aad.extend_from_slice(key.as_bytes());
    aad.push(AAD_SEPARATOR);
    aad.push(SEAL_VERSION);
    aad
}

pub fn cipher(config: &Config) -> Result<ConfigCipher, InstallError> {
    ConfigCipher::from_config(config)
}

pub async fn for_plugin(
    state: &AppState,
    plugin_id: &str,
    schema: &BTreeMap<String, ConfigField>,
    key: Option<&str>,
) -> Result<abi::config::ConfigGetOutput, InstallError> {
    let stored = load(state, plugin_id).await?;
    let cipher = cipher(&state.config)?;

    let mut values = abi::JsonMap::new();
    let mut missing = Vec::new();

    for (name, field) in schema {
        if let Some(wanted) = key
            && wanted != name
        {
            continue;
        }
        match stored.get(name) {
            Some(StoredValue::Sealed { secret }) => match cipher.open(plugin_id, name, secret) {
                Ok(plaintext) => {
                    values.insert(name.clone(), serde_json::Value::String(plaintext));
                }
                Err(err) => {
                    warn!(
                        plugin = %plugin_id, key = %name, error = %err,
                        "a stored plugin secret could not be decrypted; reporting it as unset"
                    );
                    missing.push(name.clone());
                }
            },
            Some(StoredValue::Plain(value)) if !value.is_null() => {
                values.insert(name.clone(), value.clone());
            }
            _ => match field.default.as_ref().filter(|_| !field.secret) {
                Some(default) => {
                    values.insert(name.clone(), default.clone());
                }
                None => missing.push(name.clone()),
            },
        }
    }

    Ok(abi::config::ConfigGetOutput { values, missing })
}

pub async fn for_admin(
    state: &AppState,
    plugin_id: &str,
    schema: &BTreeMap<String, ConfigField>,
) -> Result<serde_json::Value, InstallError> {
    let stored = load(state, plugin_id).await?;
    let meta = load_meta(state, plugin_id).await?;

    let mut values = serde_json::Map::new();
    let mut set = serde_json::Map::new();
    let mut missing = Vec::new();

    for (name, field) in schema {
        let plain = match stored.get(name) {
            Some(StoredValue::Sealed { .. }) => None,
            Some(StoredValue::Plain(value)) if !value.is_null() => Some(value.clone()),
            _ => {
                set.insert(name.clone(), serde_json::Value::Bool(false));
                missing.push(name.clone());
                continue;
            }
        };
        set.insert(name.clone(), serde_json::Value::Bool(true));
        let shown = match plain {
            Some(value) if !field.secret => value,
            _ => serde_json::Value::String(SECRET_PLACEHOLDER.to_string()),
        };
        values.insert(name.clone(), shown);
    }

    Ok(serde_json::json!({
        "plugin": plugin_id,
        "schema": schema,
        "values": values,
        "set": set,
        "missing": missing,
        "updatedAt": meta.0,
        "updatedBy": meta.1,
    }))
}

pub async fn set(
    state: &AppState,
    plugin_id: &str,
    schema: &BTreeMap<String, ConfigField>,
    values: serde_json::Map<String, serde_json::Value>,
    actor: &Actor,
) -> Result<(), InstallError> {
    if values.len() > MAX_CONFIG_KEYS {
        return Err(InstallError::Config(format!(
            "a plugin's configuration may hold at most {MAX_CONFIG_KEYS} keys"
        )));
    }

    let stored = load(state, plugin_id).await?;
    let cipher = cipher(&state.config)?;
    let mut document = bson::Document::new();
    let mut changed: Vec<String> = Vec::new();
    let mut cleared: Vec<String> = Vec::new();

    for (name, value) in &stored {
        if schema.contains_key(name) {
            document.insert(name.clone(), to_bson(value)?);
        }
    }

    for (name, value) in &values {
        let Some(field) = schema.get(name) else {
            return Err(InstallError::Config(format!(
                "`{name}` is not a configuration key this plugin declares"
            )));
        };

        if value.is_null() {
            document.remove(name);
            cleared.push(name.clone());
            continue;
        }

        if field.secret {
            let Some(text) = value.as_str() else {
                return Err(InstallError::Config(format!(
                    "`{name}` is a secret and must be submitted as a string"
                )));
            };
            if text == SECRET_PLACEHOLDER {
                continue;
            }
            if text.is_empty() {
                document.remove(name);
                cleared.push(name.clone());
                continue;
            }
            if text.len() > MAX_CONFIG_VALUE_BYTES {
                return Err(InstallError::Config(format!(
                    "`{name}` is longer than {MAX_CONFIG_VALUE_BYTES} bytes"
                )));
            }
            let sealed = cipher.seal(plugin_id, name, text)?;
            document.insert(
                name.clone(),
                bson::to_bson(&StoredValue::Sealed { secret: sealed })
                    .map_err(|err| InstallError::Internal(err.into()))?,
            );
            changed.push(name.clone());
            continue;
        }

        validate_value(field, value).map_err(InstallError::Config)?;
        document.insert(name.clone(), to_bson(&StoredValue::Plain(value.clone()))?);
        changed.push(name.clone());
    }

    for (name, field) in schema {
        if field.required && !document.contains_key(name) && field.default.is_none() {
            return Err(InstallError::Config(format!(
                "`{name}` is required and has no value"
            )));
        }
    }

    state
        .collections
        .raw(db::PLUGIN_CONFIG)
        .update_one(
            bson::doc! { "_id": plugin_id },
            bson::doc! { "$set": {
                "values": &document,
                "updated_at": Timestamp::now().to_bson(),
                "updated_by": actor.as_stored(),
            } },
        )
        .upsert(true)
        .await?;

    state
        .audit(
            AuditEntry::new(
                "plugin.config.set",
                Some(actor),
                "plugin",
                Some(plugin_id.to_string()),
            )
            .with_detail(bson::doc! { "keys": &changed, "cleared": &cleared }),
        )
        .await;
    Ok(())
}

pub async fn clear(
    state: &AppState,
    plugin_id: &str,
    key: &str,
    actor: &Actor,
) -> Result<(), InstallError> {
    state
        .collections
        .raw(db::PLUGIN_CONFIG)
        .update_one(
            bson::doc! { "_id": plugin_id },
            bson::doc! {
                "$unset": { format!("values.{key}"): "" },
                "$set": {
                    "updated_at": Timestamp::now().to_bson(),
                    "updated_by": actor.as_stored(),
                },
            },
        )
        .await?;
    state
        .audit(
            AuditEntry::new(
                "plugin.config.clear",
                Some(actor),
                "plugin",
                Some(plugin_id.to_string()),
            )
            .with_detail(bson::doc! { "key": key }),
        )
        .await;
    Ok(())
}

pub async fn purge(state: &AppState, plugin_id: &str) -> Result<u64, InstallError> {
    let deleted = state
        .collections
        .raw(db::PLUGIN_CONFIG)
        .delete_one(bson::doc! { "_id": plugin_id })
        .await?;
    Ok(deleted.deleted_count)
}

pub fn validate_value(field: &ConfigField, value: &serde_json::Value) -> Result<(), String> {
    let label = field.label.clone();
    let name = label.as_deref().unwrap_or("the value");
    match field.kind.as_str() {
        "string" => {
            let Some(text) = value.as_str() else {
                return Err(format!("{name} must be a string"));
            };
            if text.len() > MAX_CONFIG_VALUE_BYTES {
                return Err(format!(
                    "{name} is longer than {MAX_CONFIG_VALUE_BYTES} bytes"
                ));
            }
            if field.required && text.trim().is_empty() {
                return Err(format!("{name} is required"));
            }
            Ok(())
        }
        "number" => {
            if value.is_number() {
                Ok(())
            } else {
                Err(format!("{name} must be a number"))
            }
        }
        "boolean" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(format!("{name} must be true or false"))
            }
        }
        "select" => {
            let Some(text) = value.as_str() else {
                return Err(format!("{name} must be one of the declared options"));
            };
            if field.options.iter().any(|option| option == text) {
                Ok(())
            } else {
                Err(format!(
                    "{name} must be one of: {}",
                    field.options.join(", ")
                ))
            }
        }
        other => Err(format!("`{other}` is not a configuration field type")),
    }
}

async fn load(
    state: &AppState,
    plugin_id: &str,
) -> Result<BTreeMap<String, StoredValue>, InstallError> {
    let Some(row) = state
        .collections
        .raw(db::PLUGIN_CONFIG)
        .find_one(bson::doc! { "_id": plugin_id })
        .await?
    else {
        return Ok(BTreeMap::new());
    };
    let Ok(values) = row.get_document("values") else {
        return Ok(BTreeMap::new());
    };

    let mut out = BTreeMap::new();
    for (name, value) in values {
        match bson::from_bson::<StoredValue>(value.clone()) {
            Ok(stored) => {
                out.insert(name.clone(), stored);
            }
            Err(err) => warn!(
                plugin = %plugin_id, key = %name, error = %err,
                "a stored plugin config value is unreadable"
            ),
        }
    }
    Ok(out)
}

async fn load_meta(
    state: &AppState,
    plugin_id: &str,
) -> Result<(Option<String>, Option<String>), InstallError> {
    let Some(row) = state
        .collections
        .raw(db::PLUGIN_CONFIG)
        .find_one(bson::doc! { "_id": plugin_id })
        .await?
    else {
        return Ok((None, None));
    };
    let updated_at = row
        .get_datetime("updated_at")
        .ok()
        .map(|at| Timestamp::from_millis(at.timestamp_millis()).to_rfc3339());
    let updated_by = row.get_str("updated_by").ok().map(|by| by.to_string());
    Ok((updated_at, updated_by))
}

fn to_bson(value: &StoredValue) -> Result<bson::Bson, InstallError> {
    bson::to_bson(value).map_err(|err| InstallError::Internal(err.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher_for_tests() -> ConfigCipher {
        let mut key = [0u8; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = index as u8;
        }
        ConfigCipher { key }
    }

    fn field(kind: &str) -> ConfigField {
        ConfigField {
            kind: kind.to_string(),
            secret: false,
            label: None,
            description: None,
            default: None,
            required: false,
            options: Vec::new(),
        }
    }

    #[test]
    fn a_sealed_value_round_trips() {
        let cipher = cipher_for_tests();
        let sealed = cipher
            .seal("calendar", "auth_header", "Bearer hunter2")
            .expect("seals");
        assert_eq!(
            cipher
                .open("calendar", "auth_header", &sealed)
                .expect("opens"),
            "Bearer hunter2"
        );
    }

    #[test]
    fn the_aad_binds_a_secret_to_its_plugin_and_key() {
        let cipher = cipher_for_tests();
        let sealed = cipher
            .seal("calendar", "auth_header", "s3cret")
            .expect("seals");

        assert!(cipher.open("evil", "auth_header", &sealed).is_err());
        assert!(cipher.open("calendar", "feed_url", &sealed).is_err());
    }

    #[test]
    fn a_different_key_cannot_open_it() {
        let sealed = cipher_for_tests()
            .seal("calendar", "auth_header", "s3cret")
            .expect("seals");
        let other = ConfigCipher { key: [9u8; 32] };
        assert!(other.open("calendar", "auth_header", &sealed).is_err());
    }

    #[test]
    fn two_seals_of_one_plaintext_differ() {
        let cipher = cipher_for_tests();
        let first = cipher.seal("calendar", "k", "same").expect("seals");
        let second = cipher.seal("calendar", "k", "same").expect("seals");
        assert_ne!(first.nonce, second.nonce, "the nonce must be per-write");
        assert_ne!(first.ct, second.ct);
    }

    #[test]
    fn the_key_is_never_printed() {
        let rendered = format!("{:?}", cipher_for_tests());
        assert_eq!(rendered, "ConfigCipher(<redacted>)");
        assert!(!rendered.contains('0'));
    }

    #[test]
    fn the_session_secret_fallback_is_deterministic_and_distinct() {
        let mut from_secret = [0u8; 32];
        derive(b"a-session-secret-of-at-least-32-bytes", &mut from_secret).expect("derives");
        let mut again = [0u8; 32];
        derive(b"a-session-secret-of-at-least-32-bytes", &mut again).expect("derives");
        assert_eq!(from_secret, again, "derivation must be deterministic");

        let mut rotated = [0u8; 32];
        derive(b"a-different-session-secret-32-byte", &mut rotated).expect("derives");
        assert_ne!(
            from_secret, rotated,
            "rotating SESSION_SECRET must change the key — that is the documented caveat"
        );
    }

    #[test]
    fn values_are_type_checked_against_their_field() {
        assert!(validate_value(&field("string"), &serde_json::json!("x")).is_ok());
        assert!(validate_value(&field("string"), &serde_json::json!(1)).is_err());
        assert!(validate_value(&field("number"), &serde_json::json!(1.5)).is_ok());
        assert!(validate_value(&field("number"), &serde_json::json!("1.5")).is_err());
        assert!(validate_value(&field("boolean"), &serde_json::json!(true)).is_ok());
        assert!(validate_value(&field("boolean"), &serde_json::json!("true")).is_err());
        assert!(validate_value(&field("mystery"), &serde_json::json!("x")).is_err());

        let mut required = field("string");
        required.required = true;
        assert!(validate_value(&required, &serde_json::json!("  ")).is_err());

        let mut select = field("select");
        select.options = vec!["a".into(), "b".into()];
        assert!(validate_value(&select, &serde_json::json!("a")).is_ok());
        assert!(validate_value(&select, &serde_json::json!("c")).is_err());
    }

    #[test]
    fn an_oversized_string_is_refused() {
        let long = "x".repeat(MAX_CONFIG_VALUE_BYTES + 1);
        assert!(validate_value(&field("string"), &serde_json::json!(long)).is_err());
    }
}
