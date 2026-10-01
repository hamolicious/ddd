//! `ddd plugin new` — a plugin project that builds with the base distribution's tooling
//! and type-checks against the server it targets.
//!
//! ```text
//! <id>/
//! ├── manifest.json
//! ├── package.json          build / check / types scripts
//! ├── tsconfig.json
//! ├── vite.config.mjs
//! ├── src/index.tsx, src/style.css
//! ├── tools/                the repository's reference Vite config, copied
//! ├── types/                fetched from the server (`ddd plugin types`)
//! └── backend/              with --backend: the Rust half
//! ```

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::Args;
use serde_json::{Map, Value, json};

use super::is_valid_plugin_id;
use super::types;
use crate::repo;
use crate::scaffold::Scaffold;
use crate::server::Server;

const TSCONFIG: &str = include_str!("../../../templates/plugin/tsconfig.json");
const VITE_CONFIG: &str = include_str!("../../../templates/plugin/vite.config.mjs");
const INDEX: &str = include_str!("../../../templates/plugin/index.tsx");
const STYLE: &str = include_str!("../../../templates/plugin/style.css");
const GITIGNORE: &str = include_str!("../../../templates/plugin/gitignore");
const README: &str = include_str!("../../../templates/plugin/README.md");
const README_BACKEND: &str = include_str!("../../../templates/plugin/README.backend.md");
const BUILD_BACKEND: &str = include_str!("../../../templates/plugin/build-backend.mjs");
const BACKEND_CARGO: &str = include_str!("../../../templates/plugin/backend/Cargo.toml");
const BACKEND_CARGO_CONFIG: &str =
    include_str!("../../../templates/plugin/backend/cargo-config.toml");
const BACKEND_LIB: &str = include_str!("../../../templates/plugin/backend/src/lib.rs");

#[derive(Args)]
pub struct NewArgs {
    /// The plugin id: lowercase letters, digits and dashes.
    pub id: String,
    /// Where to create the project [default: ./<id>].
    #[arg(long)]
    pub dir: Option<PathBuf>,
    /// Display name [default: the id, title-cased].
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub description: Option<String>,
    #[arg(long)]
    pub author: Option<String>,
    /// A plugin this one imports from, as `<id>@<range>`, or as `<id>` with --server (the
    /// range is taken from the version that server has installed). Repeatable.
    #[arg(long = "dep", value_name = "ID[@RANGE]")]
    pub dependencies: Vec<String>,
    /// Compile style.css with the Tailwind preset, under the plugin's class prefix.
    #[arg(long)]
    pub tailwind: bool,
    /// Add a Rust backend half (cron, hooks, HTTP routes, outbound HTTP).
    #[arg(long)]
    pub backend: bool,
    /// Take the plugin SDK from a local directory (a checkout's `backend/crates/plugin-sdk`)
    /// instead of git.
    #[arg(long, value_name = "PATH", conflicts_with = "sdk_git")]
    pub sdk: Option<PathBuf>,
    /// The git repository to take the plugin SDK from [default: the one `ddd` was built
    /// from, at the commit it was built from].
    #[arg(long, value_name = "URL")]
    pub sdk_git: Option<String>,
    /// The ddd server the plugin targets, e.g. `https://notes.example.com`. With
    /// it, types/ is filled in now and bare `--dep <id>` ranges are resolved; without it,
    /// nothing is fetched.
    #[arg(long, env = "DDD_SERVER")]
    pub server: Option<String>,
}

pub fn run(args: NewArgs) -> Result<()> {
    if !is_valid_plugin_id(&args.id) {
        bail!(
            "{:?} is not a plugin id: lowercase letters, digits and dashes, starting with a letter or digit, at most 64",
            args.id
        );
    }
    let id = args.id.as_str();
    let root = args.dir.clone().unwrap_or_else(|| PathBuf::from(id));
    let server = args.server.as_deref().map(Server::new);
    let name = args.name.clone().unwrap_or_else(|| title_case(id));
    let crate_name = id.replace('-', "_");
    let vars = [
        ("id", id),
        ("name", name.as_str()),
        ("crate", crate_name.as_str()),
    ];

    let dependencies = resolve_dependencies(&args, server.as_ref())?;

    let mut scaffold = Scaffold::default();
    scaffold.file(
        "manifest.json",
        pretty(&manifest(&args, &name, dependencies)?),
    );
    scaffold.file("package.json", pretty(&package(&args)?));
    scaffold.file("tsconfig.json", TSCONFIG);
    scaffold.file("vite.config.mjs", VITE_CONFIG);
    scaffold.file("tools/vite.plugin-config.mjs", repo::VITE_PLUGIN_CONFIG);
    scaffold.file("tools/tailwind-preset.mjs", repo::TAILWIND_PRESET);
    scaffold.template("src/index.tsx", INDEX, &vars);
    scaffold.template("src/style.css", STYLE, &vars);
    scaffold.file(".gitignore", GITIGNORE);

    let mut readme = README.to_owned();
    if args.backend {
        let sdk = sdk_dependency(&args)?;
        let backend_vars = [vars.as_slice(), &[("sdk", sdk.as_str())]].concat();
        scaffold.template("backend/Cargo.toml", BACKEND_CARGO, &backend_vars);
        scaffold.file("backend/.cargo/config.toml", BACKEND_CARGO_CONFIG);
        scaffold.template("backend/src/lib.rs", BACKEND_LIB, &vars);
        scaffold.template("tools/build-backend.mjs", BUILD_BACKEND, &vars);
        readme.push_str(README_BACKEND);
    }
    scaffold.template("README.md", &readme, &vars);

    scaffold.write(&root)?;
    for path in scaffold.paths() {
        println!("+ {}", path.display());
    }

    let fetched = match &server {
        Some(server) => types::fetch(&root, server)
            .inspect_err(|error| eprintln!("! could not fetch types: {error:#}"))
            .is_ok(),
        None => false,
    };

    println!("\nCreated {id} in {}. Next:", root.display());
    println!("  cd {}", root.display());
    println!("  npm install");
    if !fetched {
        println!("  npm run types -- --server <your server's URL>");
    }
    println!("  npm run build");
    Ok(())
}

/// `--dep` values as manifest entries. A bare id takes `^<major>.0` of the version the
/// server has installed, which is what a new plugin almost always means.
fn resolve_dependencies(args: &NewArgs, server: Option<&Server>) -> Result<Map<String, Value>> {
    let mut installed = None;
    let mut out = Map::new();
    for dep in &args.dependencies {
        let (id, range) = match dep.split_once('@') {
            Some((id, range)) => (id, range.to_owned()),
            None => {
                let Some(server) = server else {
                    bail!(
                        "--dep {dep}: give a range (--dep {dep}@^1.0), or --server to take it from that server"
                    );
                };
                if installed.is_none() {
                    installed = Some(server.plugin_versions().with_context(|| {
                        format!("looking up {dep}'s version (or pass --dep {dep}@<range>)")
                    })?);
                }
                let version = installed
                    .as_ref()
                    .and_then(|versions| versions.get(dep))
                    .with_context(|| format!("{dep} is not installed on {}", server.url()))?;
                let major = version.split('.').next().unwrap_or(version);
                (dep.as_str(), format!("^{major}.0"))
            }
        };
        if !is_valid_plugin_id(id) {
            bail!("--dep {dep:?}: {id:?} is not a plugin id");
        }
        out.insert(id.to_owned(), Value::String(range));
    }
    Ok(out)
}

/// The `ddd-plugin-sdk` dependency, as a TOML inline table.
fn sdk_dependency(args: &NewArgs) -> Result<String> {
    let table = if let Some(dir) = &args.sdk {
        let dir = dir
            .canonicalize()
            .with_context(|| format!("--sdk {}: no such directory", dir.display()))?;
        json!({ "path": dir.to_string_lossy() })
    } else {
        let git = args.sdk_git.as_deref().unwrap_or(repo::SDK_GIT);
        match repo::SDK_REV {
            Some(rev) => json!({ "git": git, "rev": rev }),
            None => json!({ "git": git }),
        }
    };
    // JSON strings are valid TOML basic strings, so each value can be written as JSON.
    let fields: Vec<String> = table
        .as_object()
        .expect("an object literal")
        .iter()
        .map(|(key, value)| format!("{key} = {value}"))
        .collect();
    Ok(format!("{{ {} }}", fields.join(", ")))
}

fn manifest(args: &NewArgs, name: &str, dependencies: Map<String, Value>) -> Result<Value> {
    let mut manifest = json!({
        "id": args.id,
        "version": "0.1.0",
        "kernel": repo::kernel_range()?,
    });
    let fields = manifest.as_object_mut().expect("an object literal");
    if !dependencies.is_empty() {
        fields.insert("dependencies".into(), Value::Object(dependencies));
    }
    fields.insert("peerLibraries".into(), json!({ "react": "^18.0.0" }));
    fields.insert(
        "frontend".into(),
        json!({ "module": "frontend/index.mjs", "style": "frontend/style.css" }),
    );
    if args.tailwind {
        fields.insert("x-tailwind".into(), json!(true));
    }
    if args.backend {
        fields.insert("backend".into(), json!({ "module": "backend.wasm" }));
    }
    fields.insert("name".into(), json!(name));
    for (key, value) in [("description", &args.description), ("author", &args.author)] {
        if let Some(value) = value {
            fields.insert(key.into(), json!(value));
        }
    }
    Ok(manifest)
}

fn package(args: &NewArgs) -> Result<Value> {
    let mut build = "vite build".to_owned();
    let mut check = "tsc --noEmit".to_owned();
    if args.backend {
        build.push_str(" && node tools/build-backend.mjs");
        check.push_str(
            " && cargo clippy --manifest-path backend/Cargo.toml --target wasm32-unknown-unknown -- -D warnings",
        );
    }

    let mut tools = vec!["vite", "typescript", "@types/react", "yjs"];
    if args.tailwind {
        tools.extend(["tailwindcss", "@tailwindcss/postcss", "postcss"]);
    }
    let mut dev_dependencies = Map::new();
    for tool in tools {
        dev_dependencies.insert(tool.into(), Value::String(repo::web_dependency(tool)?));
    }

    Ok(json!({
        "name": args.id,
        "private": true,
        "type": "module",
        "scripts": {
            "build": build,
            "watch": "vite build --watch",
            "check": check,
            "types": "ddd plugin types",
        },
        "devDependencies": dev_dependencies,
    }))
}

fn pretty(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).expect("JSON values serialize")
    )
}

fn title_case(id: &str) -> String {
    id.split('-')
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::title_case;

    #[test]
    fn names_default_to_the_title_cased_id() {
        assert_eq!(title_case("reading-list"), "Reading List");
        assert_eq!(title_case("rss"), "Rss");
    }
}
