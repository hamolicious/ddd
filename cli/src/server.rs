//! Reading from a running Life Manager server. Only unauthenticated routes: `/kernel.d.ts`,
//! `/importmap.json` and plugin assets.

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
