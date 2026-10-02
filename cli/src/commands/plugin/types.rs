use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::Args;
use serde_json::Value;

use crate::server::Server;

#[derive(Args)]
pub struct TypesArgs {
    #[arg(long, default_value = ".")]
    pub dir: PathBuf,
    #[arg(long, env = "DDD_SERVER")]
    pub server: Option<String>,
}

pub fn run(args: TypesArgs) -> Result<()> {
    let Some(server) = args.server else {
        bail!(
            "which server? pass --server <url> or set DDD_SERVER (npm run types -- --server <url>)"
        );
    };
    fetch(&args.dir, &Server::new(&server))
}

pub fn fetch(dir: &Path, server: &Server) -> Result<()> {
    let manifest_path = dir.join("manifest.json");
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .with_context(|| format!("reading {}", manifest_path.display()))?,
    )
    .with_context(|| format!("{} is not JSON", manifest_path.display()))?;

    let types = dir.join("types");
    fs::create_dir_all(types.join("plugins"))?;

    fs::write(types.join("kernel.d.ts"), server.get("/kernel.d.ts")?)?;
    println!("+ types/kernel.d.ts");

    let dependencies: Vec<String> = ["dependencies", "optionalDependencies"]
        .iter()
        .filter_map(|section| manifest[section].as_object())
        .flat_map(|deps| deps.keys().cloned())
        .collect();
    if dependencies.is_empty() {
        return Ok(());
    }

    let installed = server.plugin_versions()?;
    for id in dependencies {
        let Some(version) = installed.get(&id) else {
            eprintln!("! {id} is not installed on {}", server.url());
            continue;
        };
        match server.get(&format!("/plugins/{id}/{version}/frontend/index.d.ts")) {
            Ok(dts) => {
                fs::write(types.join("plugins").join(format!("{id}.d.ts")), dts)?;
                println!("+ types/plugins/{id}.d.ts ({id}@{version})");
            }
            Err(error) => eprintln!("! {id}@{version} has no index.d.ts: {error:#}"),
        }
    }
    Ok(())
}
