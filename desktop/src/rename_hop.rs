//! RENAME-HOP: one-release migration from the old "life-manager" name to "ddd".
//!
//! The whole module goes in the cleanup release (grep `RENAME-HOP`). It moves what the
//! old build left on disk to where this build looks for it, before anything reads the
//! config or Tauri resolves its paths:
//!
//! * `<config>/life-manager` → `<config>/ddd` (`desktop.toml`, `config.rs`);
//! * `<base>/app.life-manager.desktop` → `<base>/app.ddd.desktop` for every base Tauri 2
//!   puts the identifier under on Linux: `app_config_dir` (`<config>`), `app_data_dir` and
//!   `app_local_data_dir` (both `<data>`; the latter is the webview's data *and* cache
//!   directory, holding cookies, IndexedDB and the service worker, and `app_log_dir` is
//!   inside it), and `app_cache_dir` (`<cache>`);
//! * `<folder>/.life-manager` → `<folder>/.ddd` in the notes folder ([`migrate_state_dir`]).
//!
//! Only ever a `rename`: the old webview data runs to hundreds of MB, and when it lives on
//! another filesystem than the new place (EXDEV) nothing is copied. The app then starts
//! with fresh webview data, which the server fills again, and this says so loudly.

use std::path::{Path, PathBuf};

/// RENAME-HOP: the old Tauri identifier.
const OLD_IDENTIFIER: &str = "app.life-manager.desktop";
/// RENAME-HOP: the new Tauri identifier (`tauri.conf.json`).
const NEW_IDENTIFIER: &str = "app.ddd.desktop";
/// RENAME-HOP: the old config directory name (`config.rs` now uses `ddd`).
const OLD_CONFIG_DIR: &str = "life-manager";
const NEW_CONFIG_DIR: &str = "ddd";
/// RENAME-HOP: the old build's state directory inside the notes folder.
pub const OLD_STATE_DIR: &str = ".life-manager";

/// RENAME-HOP: an XDG base directory, as `config.rs` and the `dirs` crate derive it.
fn xdg(var: &str, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(fallback)))
}

/// RENAME-HOP: the base directories the old build wrote under.
pub struct Bases {
    pub config: Option<PathBuf>,
    pub data: Option<PathBuf>,
    pub cache: Option<PathBuf>,
}

impl Bases {
    pub fn from_env() -> Self {
        Self {
            config: xdg("XDG_CONFIG_HOME", ".config"),
            data: xdg("XDG_DATA_HOME", ".local/share"),
            cache: xdg("XDG_CACHE_HOME", ".cache"),
        }
    }

    /// Every (old, new) pair to move. Duplicate bases (say `XDG_CACHE_HOME` pointing at
    /// the data directory) are harmless: the second rename finds nothing left to move.
    fn pairs(&self) -> Vec<(PathBuf, PathBuf)> {
        let mut pairs = Vec::new();
        if let Some(config) = &self.config {
            pairs.push((config.join(OLD_CONFIG_DIR), config.join(NEW_CONFIG_DIR)));
        }
        for base in [&self.config, &self.data, &self.cache]
            .into_iter()
            .flatten()
        {
            pairs.push((base.join(OLD_IDENTIFIER), base.join(NEW_IDENTIFIER)));
        }
        pairs
    }
}

/// RENAME-HOP: what happened to one pair.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing old to move, or the new one already exists (it wins; the old is left).
    Skipped,
    Moved,
    /// The rename failed; the old one is left where it was.
    Failed(String),
}

/// RENAME-HOP: rename `old` to `new` when only `old` exists.
pub fn migrate(old: &Path, new: &Path) -> Outcome {
    // `symlink_metadata`: a dangling link at `new` still counts as "there".
    if std::fs::symlink_metadata(new).is_ok() || std::fs::symlink_metadata(old).is_err() {
        return Outcome::Skipped;
    }
    if let Some(parent) = new.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        return Outcome::Failed(e.to_string());
    }
    match std::fs::rename(old, new) {
        Ok(()) => Outcome::Moved,
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// RENAME-HOP: move every legacy directory under `bases`, logging each move and failure.
pub fn migrate_all(bases: &Bases) -> Vec<(PathBuf, Outcome)> {
    bases
        .pairs()
        .into_iter()
        .map(|(old, new)| {
            let outcome = migrate(&old, &new);
            log(&old, &new, &outcome);
            (old, outcome)
        })
        .collect()
}

/// RENAME-HOP: `<root>/.life-manager` → `<root>/.ddd` in the notes folder.
pub fn migrate_state_dir(root: &Path, state_dir: &str) -> Outcome {
    let (old, new) = (root.join(OLD_STATE_DIR), root.join(state_dir));
    let outcome = migrate(&old, &new);
    log(&old, &new, &outcome);
    outcome
}

/// RENAME-HOP
fn log(old: &Path, new: &Path, outcome: &Outcome) {
    match outcome {
        Outcome::Skipped => {}
        Outcome::Moved => eprintln!(
            "ddd-desktop: moved {} to {} (rename to ddd)",
            old.display(),
            new.display()
        ),
        Outcome::Failed(e) => eprintln!(
            "ddd-desktop: WARNING: could not move {} to {}: {e}. It is left where it was and \
             the app starts without it; move it by hand while the app is closed, or delete it.",
            old.display(),
            new.display()
        ),
    }
}

/// RENAME-HOP
#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ddd-rename-hop-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bases(root: &Path) -> Bases {
        Bases {
            config: Some(root.join("config")),
            data: Some(root.join("data")),
            cache: Some(root.join("cache")),
        }
    }

    #[test]
    fn moves_every_legacy_directory() {
        let root = temp("all");
        let config_file = root.join("config/life-manager/desktop.toml");
        std::fs::create_dir_all(config_file.parent().unwrap()).unwrap();
        std::fs::write(&config_file, "server_url = \"https://example.test\"\n").unwrap();
        for base in ["config", "data", "cache"] {
            let dir = root.join(base).join(OLD_IDENTIFIER);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("marker"), base).unwrap();
        }

        let outcomes = migrate_all(&bases(&root));
        assert_eq!(outcomes.len(), 4);
        assert!(outcomes.iter().all(|(_, o)| *o == Outcome::Moved));
        assert!(root.join("config/ddd/desktop.toml").is_file());
        assert!(!root.join("config/life-manager").exists());
        for base in ["config", "data", "cache"] {
            let moved = root.join(base).join(NEW_IDENTIFIER).join("marker");
            assert_eq!(std::fs::read_to_string(moved).unwrap(), base);
            assert!(!root.join(base).join(OLD_IDENTIFIER).exists());
        }
        // Run again: nothing left to do.
        assert!(
            migrate_all(&bases(&root))
                .iter()
                .all(|(_, o)| *o == Outcome::Skipped)
        );
    }

    #[test]
    fn creates_a_missing_parent() {
        let root = temp("parent");
        std::fs::create_dir_all(root.join("old")).unwrap();
        let new = root.join("missing/new");
        assert_eq!(migrate(&root.join("old"), &new), Outcome::Moved);
        assert!(new.is_dir());
    }

    #[test]
    fn leaves_the_old_when_the_new_exists() {
        let root = temp("both");
        std::fs::create_dir_all(root.join("data").join(OLD_IDENTIFIER)).unwrap();
        std::fs::create_dir_all(root.join("data").join(NEW_IDENTIFIER)).unwrap();
        assert_eq!(
            migrate(
                &root.join("data").join(OLD_IDENTIFIER),
                &root.join("data").join(NEW_IDENTIFIER)
            ),
            Outcome::Skipped
        );
        assert!(root.join("data").join(OLD_IDENTIFIER).is_dir());
    }

    #[test]
    fn skips_when_there_is_nothing_old() {
        let root = temp("none");
        assert!(
            migrate_all(&bases(&root))
                .iter()
                .all(|(_, o)| *o == Outcome::Skipped)
        );
        assert!(!root.join("config/ddd").exists());
    }

    #[test]
    fn a_failed_rename_leaves_the_old_in_place() {
        let root = temp("fail");
        std::fs::create_dir_all(root.join("old/inner")).unwrap();
        // A directory cannot be renamed into itself: rename fails, like EXDEV would.
        let outcome = migrate(&root.join("old"), &root.join("old/inner/new"));
        assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
        assert!(root.join("old/inner").is_dir());
    }

    #[test]
    fn moves_the_notes_folder_state() {
        let root = temp("state");
        std::fs::create_dir_all(root.join(OLD_STATE_DIR)).unwrap();
        std::fs::write(root.join(OLD_STATE_DIR).join("sync.json"), "{}").unwrap();
        assert_eq!(migrate_state_dir(&root, ".ddd"), Outcome::Moved);
        assert!(root.join(".ddd/sync.json").is_file());
        assert_eq!(migrate_state_dir(&root, ".ddd"), Outcome::Skipped);
    }
}
