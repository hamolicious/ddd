//! Pins generated backend crates to the plugin SDK of the commit `ddd` is built from.
//!
//! `DDD_SDK_REV` set in the build environment wins (a CI job building from an archive has
//! no `.git`); otherwise it is this checkout's `HEAD`. With neither, generated crates
//! track the repository's default branch.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=DDD_SDK_REV");
    println!("cargo:rerun-if-env-changed=DDD_SDK_GIT");
    println!("cargo:rerun-if-changed=../.git/HEAD");

    let rev = std::env::var("DDD_SDK_REV").ok().or_else(|| {
        let out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    });
    if let Some(rev) = rev.filter(|rev| !rev.is_empty()) {
        println!("cargo:rustc-env=DDD_SDK_REV={rev}");
    }
}
