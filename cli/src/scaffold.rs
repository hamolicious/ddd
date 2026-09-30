//! A project skeleton: a list of files, rendered from templates and written in one go.
//!
//! Templates use `{{key}}` placeholders. Only the keys passed in are replaced, so JSX and
//! CSS braces in a template are left alone.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

#[derive(Default)]
pub struct Scaffold {
    files: Vec<(PathBuf, String)>,
}

impl Scaffold {
    /// Add a file whose contents are already final.
    pub fn file(&mut self, path: impl Into<PathBuf>, contents: impl Into<String>) {
        self.files.push((path.into(), contents.into()));
    }

    /// Add a file rendered from `template`.
    pub fn template(&mut self, path: impl Into<PathBuf>, template: &str, vars: &[(&str, &str)]) {
        self.file(path, render(template, vars));
    }

    /// Write every file under `root`, which must not exist or be empty: a scaffold never
    /// overwrites someone's work.
    pub fn write(&self, root: &Path) -> Result<()> {
        if root.exists() && fs::read_dir(root)?.next().is_some() {
            bail!("{} already exists and is not empty", root.display());
        }
        for (path, contents) in &self.files {
            let target = root.join(path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("creating {}", parent.display()))?;
            }
            fs::write(&target, contents).with_context(|| format!("writing {}", target.display()))?;
        }
        Ok(())
    }

    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        self.files.iter().map(|(path, _)| path.as_path())
    }
}

pub fn render(template: &str, vars: &[(&str, &str)]) -> String {
    vars.iter().fold(template.to_owned(), |out, (key, value)| {
        out.replace(&format!("{{{{{key}}}}}"), value)
    })
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn replaces_only_the_given_keys() {
        assert_eq!(
            render("{{id}}: {{other}} {x}", &[("id", "demo")]),
            "demo: {{other}} {x}"
        );
    }
}
