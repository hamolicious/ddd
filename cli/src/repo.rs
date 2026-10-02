use anyhow::{Context, Result, anyhow};
use serde_json::Value;

pub const VITE_PLUGIN_CONFIG: &str =
    include_str!("../../plugins/base/_shared/vite.plugin-config.mjs");
pub const TAILWIND_PRESET: &str = include_str!("../../plugins/base/_shared/tailwind-preset.mjs");

const MANIFEST_SCHEMA: &str = include_str!("../../schema/manifest.schema.json");
const WEB_PACKAGE: &str = include_str!("../../web/package.json");

pub fn kernel_range() -> Result<String> {
    let schema: Value = serde_json::from_str(MANIFEST_SCHEMA)?;
    let version = schema["x-kernel-version"]
        .as_str()
        .ok_or_else(|| anyhow!("manifest.schema.json has no x-kernel-version"))?;
    let mut parts = version.split('.');
    match (parts.next(), parts.next()) {
        (Some(major), Some(minor)) => Ok(format!("^{major}.{minor}")),
        _ => Err(anyhow!("x-kernel-version {version:?} is not semver")),
    }
}

pub fn web_dependency(name: &str) -> Result<String> {
    let package: Value = serde_json::from_str(WEB_PACKAGE)?;
    ["dependencies", "devDependencies"]
        .iter()
        .find_map(|section| package[section][name].as_str())
        .map(str::to_owned)
        .with_context(|| format!("web/package.json does not list {name}"))
}

pub const SDK_GIT: &str = match option_env!("DDD_SDK_GIT") {
    Some(url) => url,
    None => "https://git.example.com/ddd/ddd.git",
};

pub const SDK_REV: Option<&str> = option_env!("DDD_SDK_REV");
