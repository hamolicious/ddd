//! Talking to a running Life Manager server: the unauthenticated routes (`/kernel.d.ts`,
//! `/importmap.json`, plugin assets), and JSON calls with a bearer token (`lm query`).

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use serde_json::Value;

pub struct Server {
    base: String,
}

impl Server {
    pub fn new(url: &str) -> Self {
        Self {
            base: url.trim_end_matches('/').to_owned(),
        }
    }

    pub fn url(&self) -> &str {
        &self.base
    }

    pub fn get(&self, path: &str) -> Result<String> {
        let url = format!("{}{path}", self.base);
        ureq::get(&url)
            .call()
            .and_then(|mut response| response.body_mut().read_to_string())
            .with_context(|| format!("GET {url}"))
    }

    /// POST a JSON body, with a bearer token when given; the JSON answer. A refusal is an
    /// error carrying the server's message.
    pub fn post_json(&self, path: &str, body: &Value, token: Option<&str>) -> Result<Value> {
        let url = format!("{}{path}", self.base);
        let mut request = ureq::post(&url)
            .config()
            .http_status_as_error(false)
            .build();
        if let Some(token) = token {
            request = request.header("Authorization", &format!("Bearer {token}"));
        }
        let mut response = request
            .send_json(body)
            .with_context(|| format!("POST {url}"))?;
        let status = response.status();
        let text = response
            .body_mut()
            .read_to_string()
            .with_context(|| format!("POST {url}"))?;
        let answer: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        if !status.is_success() {
            let message = answer["error"]["message"].as_str().unwrap_or("no message");
            anyhow::bail!("POST {url}: {status}: {message}");
        }
        Ok(answer)
    }

    /// Installed plugin id → the version the server loads, from the import map's
    /// `plugin:<id>` entries (`/plugins/<id>/<version>/frontend/index.mjs?v=…`).
    pub fn plugin_versions(&self) -> Result<BTreeMap<String, String>> {
        let map: Value = serde_json::from_str(&self.get("/importmap.json")?)
            .context("/importmap.json is not JSON")?;
        let imports = map["imports"].as_object().cloned().unwrap_or_default();
        Ok(imports
            .iter()
            .filter_map(|(specifier, url)| {
                let id = specifier.strip_prefix("plugin:")?;
                let rest = url.as_str()?.strip_prefix(&format!("/plugins/{id}/"))?;
                let version = rest.split('/').next()?;
                Some((id.to_owned(), version.to_owned()))
            })
            .collect())
    }
}
