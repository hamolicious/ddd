//! `~/.config/ddd/desktop.toml`: the server, and the notes folder.

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Deserialize, Default)]
pub struct Config {
    pub server_url: Option<String>,
    /// The notes folder chosen in the app (`folder.rs`). Written by the app itself.
    pub folder: Option<String>,
}

pub fn path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("ddd").join("desktop.toml"))
}

pub fn read() -> Option<Config> {
    let text = std::fs::read_to_string(path()?).ok()?;
    toml::from_str(&text).ok()
}

/// Set or clear `folder`, keeping every other key (and the user's `server_url`) as it was.
pub fn set_folder(folder: Option<&Path>) -> Result<(), String> {
    let text = folder
        .map(|f| f.to_str().ok_or("the folder's path is not valid UTF-8"))
        .transpose()?;
    set("folder", text)
}

/// Set or clear `server_url`, keeping every other key as it was.
pub fn set_server_url(url: &str) -> Result<(), String> {
    set("server_url", Some(url))
}

/// Set or clear one string key in the config file, keeping every other key as it was.
fn set(key: &str, value: Option<&str>) -> Result<(), String> {
    let path = path().ok_or("no home directory to keep the setting in")?;
    let mut table = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok())
        .unwrap_or_default();
    match value {
        Some(value) => {
            table.insert(key.into(), toml::Value::String(value.into()));
        }
        None => {
            table.remove(key);
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = toml::to_string(&table).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}
