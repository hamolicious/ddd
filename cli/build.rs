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
