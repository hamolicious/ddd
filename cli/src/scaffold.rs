use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

#[derive(Default)]
pub struct Scaffold {
    files: Vec<(PathBuf, String)>,
}

impl Scaffold {
    pub fn file(&mut self, path: impl Into<PathBuf>, contents: impl Into<String>) {
        self.files.push((path.into(), contents.into()));
    }

    pub fn template(&mut self, path: impl Into<PathBuf>, template: &str, vars: &[(&str, &str)]) {
        self.file(path, render(template, vars));
    }

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
            fs::write(&target, contents)
                .with_context(|| format!("writing {}", target.display()))?;
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
