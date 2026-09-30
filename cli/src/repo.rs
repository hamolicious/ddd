//! What the CLI knows about this repository, read at **compile time**.
//!
//! Everything a generated project copies from the repo — the reference Vite config, the
//! kernel contract version, the tool versions the base plugins build with — is embedded
//! from its source file rather than restated here, so rebuilding `lm` is all it takes to
//! pick up a change and nothing can drift.

use anyhow::{Context, Result, anyhow};
use serde_json::Value;

/// The reference Vite config every base plugin builds with (SPEC §6.4).
pub const VITE_PLUGIN_CONFIG: &str =
    include_str!("../../plugins/base/_shared/vite.plugin-config.mjs");
/// Imported by [`VITE_PLUGIN_CONFIG`].
pub const TAILWIND_PRESET: &str = include_str!("../../plugins/base/_shared/tailwind-preset.mjs");

const MANIFEST_SCHEMA: &str = include_str!("../../schema/manifest.schema.json");
const WEB_PACKAGE: &str = include_str!("../../web/package.json");

/// The `kernel` range a new manifest declares: `^<major>.<minor>` of the schema's
/// `x-kernel-version`.
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

/// The range `web/package.json` pins `name` to, so a plugin builds with the same tools as
/// the base distribution.
pub fn web_dependency(name: &str) -> Result<String> {
    let package: Value = serde_json::from_str(WEB_PACKAGE)?;
    ["dependencies", "devDependencies"]
        .iter()
        .find_map(|section| package[section][name].as_str())
        .map(str::to_owned)
        .with_context(|| format!("web/package.json does not list {name}"))
}

/// The repository generated backend crates fetch `life-manager-plugin-sdk` from. Set
/// `LM_SDK_GIT` when building `lm` to point it at a public mirror.
pub const SDK_GIT: &str = match option_env!("LM_SDK_GIT") {
    Some(url) => url,
    // Placeholder until the repository is public.
    None => "https://git.example.com/life-manager/life-manager.git",
};

/// The commit `lm` was built from (`build.rs`), so a generated crate gets the SDK that
/// matches the tool that generated it.
pub const SDK_REV: Option<&str> = option_env!("LM_SDK_REV");
