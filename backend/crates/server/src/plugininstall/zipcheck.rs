use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use ddd_plugin_abi as abi;
use sha2::{Digest as _, Sha256};

use crate::plugins::PluginManifest;

pub const MAX_ARCHIVE_BYTES: u64 = abi::limits::MAX_PACKAGE_BYTES;
pub const MAX_UNCOMPRESSED_BYTES: u64 = abi::limits::MAX_PACKAGE_UNCOMPRESSED_BYTES;
pub const MAX_ENTRIES: usize = abi::limits::MAX_PACKAGE_ENTRIES;
pub const MAX_ENTRY_BYTES: u64 = abi::limits::MAX_PACKAGE_ENTRY_BYTES;
pub const MAX_MANIFEST_BYTES: u64 = abi::limits::MAX_MANIFEST_BYTES;
pub const MAX_WASM_BYTES: u64 = abi::limits::MAX_BACKEND_WASM_BYTES;

pub const MANIFEST_ENTRY: &str = "manifest.json";
pub const FRONTEND_PREFIX: &str = "frontend/";

const STABLE_POLL: Duration = Duration::from_millis(250);

const WASM_PREAMBLE: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

#[derive(Debug, thiserror::Error)]
pub enum ZipError {
    #[error("not a readable zip archive: {0}")]
    NotZip(String),
    #[error("the archive is {len} bytes, over the {limit} byte limit")]
    ArchiveTooLarge { len: u64, limit: u64 },
    #[error("the archive expands to more than {limit} bytes")]
    Bomb { limit: u64 },
    #[error("the archive has more than {limit} entries")]
    TooManyEntries { limit: usize },
    #[error("`{name}` is {len} bytes, over the {limit} byte per-entry limit")]
    EntryTooLarge { name: String, len: u64, limit: u64 },
    #[error("`{0}` is an absolute path")]
    AbsolutePath(String),
    #[error("`{0}` escapes the package")]
    Traversal(String),
    #[error("`{0}` is a symlink")]
    Symlink(String),
    #[error("`{0}` is outside `frontend/` and is not the declared backend module")]
    OutsideFrontend(String),
    #[error("the archive has no manifest.json at its root")]
    MissingManifest,
    #[error("manifest.json is not valid: {0}")]
    BadManifest(String),
    #[error("the manifest declares `{0}` but the archive does not contain it")]
    MissingDeclared(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug)]
pub struct ExtractedPackage {
    pub dir: PathBuf,
    pub manifest: PluginManifest,
    pub backend_wasm: Option<PathBuf>,
    pub backend_sha256: Option<String>,
    pub entries: usize,
    pub uncompressed_bytes: u64,
}

pub fn read_manifest(archive: &Path) -> Result<PluginManifest, ZipError> {
    let len = fs::metadata(archive)?.len();
    if len > MAX_ARCHIVE_BYTES {
        return Err(ZipError::ArchiveTooLarge {
            len,
            limit: MAX_ARCHIVE_BYTES,
        });
    }

    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(io::BufReader::new(file))
        .map_err(|err| ZipError::NotZip(err.to_string()))?;

    if zip.len() > MAX_ENTRIES {
        return Err(ZipError::TooManyEntries { limit: MAX_ENTRIES });
    }

    let mut entry = match zip.by_name(MANIFEST_ENTRY) {
        Ok(entry) => entry,
        Err(_) => return Err(ZipError::MissingManifest),
    };
    if entry.is_dir() || entry.is_symlink() {
        return Err(ZipError::MissingManifest);
    }
    if entry.size() > MAX_MANIFEST_BYTES {
        return Err(ZipError::EntryTooLarge {
            name: MANIFEST_ENTRY.to_string(),
            len: entry.size(),
            limit: MAX_MANIFEST_BYTES,
        });
    }

    let mut raw = Vec::new();
    entry
        .by_ref()
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut raw)?;
    if raw.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(ZipError::EntryTooLarge {
            name: MANIFEST_ENTRY.to_string(),
            len: raw.len() as u64,
            limit: MAX_MANIFEST_BYTES,
        });
    }

    let value: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|err| ZipError::BadManifest(err.to_string()))?;
    let problems = crate::manifest_schema::validate_manifest(&value);
    if !problems.is_empty() {
        return Err(ZipError::BadManifest(crate::manifest_schema::describe(
            &problems,
        )));
    }
    serde_json::from_value(value).map_err(|err| ZipError::BadManifest(err.to_string()))
}

pub fn extract(
    archive: &Path,
    staging: &Path,
    manifest: &PluginManifest,
) -> Result<ExtractedPackage, ZipError> {
    if staging
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(ZipError::Traversal(staging.display().to_string()));
    }
    fs::create_dir_all(staging)?;
    let root = staging.canonicalize()?;

    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(io::BufReader::new(file))
        .map_err(|err| ZipError::NotZip(err.to_string()))?;
    if zip.len() > MAX_ENTRIES {
        return Err(ZipError::TooManyEntries { limit: MAX_ENTRIES });
    }

    let mut total: u64 = 0;
    let mut written = 0usize;

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|err| ZipError::NotZip(err.to_string()))?;
        let name = entry.name().to_string();

        if entry.is_symlink() {
            return Err(ZipError::Symlink(name));
        }
        let is_dir = entry.is_dir();
        let lexical = name.trim_end_matches('/');
        check_entry_name(lexical)?;
        if is_dir {
            continue;
        }
        if !entry_allowed(&name, manifest) {
            return Err(ZipError::OutsideFrontend(name));
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(ZipError::EntryTooLarge {
                name,
                len: entry.size(),
                limit: MAX_ENTRY_BYTES,
            });
        }

        let target = root.join(lexical);
        if !inside_root(&root, &target) {
            return Err(ZipError::Traversal(name));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
            if !inside_root(&root, parent) {
                return Err(ZipError::Traversal(name));
            }
        }

        let mut out = match fs::File::options()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(out) => out,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                return Err(ZipError::Traversal(name));
            }
            Err(err) => return Err(err.into()),
        };

        let mut entry_bytes: u64 = 0;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            entry_bytes += read as u64;
            total += read as u64;
            if entry_bytes > MAX_ENTRY_BYTES {
                return Err(ZipError::EntryTooLarge {
                    name,
                    len: entry_bytes,
                    limit: MAX_ENTRY_BYTES,
                });
            }
            if total > MAX_UNCOMPRESSED_BYTES {
                return Err(ZipError::Bomb {
                    limit: MAX_UNCOMPRESSED_BYTES,
                });
            }
            out.write_all(&buffer[..read])?;
        }
        out.flush()?;
        written += 1;
    }

    if !root.join(MANIFEST_ENTRY).is_file() {
        return Err(ZipError::MissingManifest);
    }
    if let Some(frontend) = manifest.frontend.as_ref() {
        if !root.join(&frontend.module).is_file() {
            return Err(ZipError::MissingDeclared(frontend.module.clone()));
        }
        if let Some(style) = frontend.style.as_ref()
            && !root.join(style).is_file()
        {
            return Err(ZipError::MissingDeclared(style.clone()));
        }
    }

    let mut backend_wasm = None;
    let mut backend_sha256 = None;
    if let Some(backend) = manifest.backend.as_ref() {
        let path = root.join(&backend.module);
        if !path.is_file() {
            return Err(ZipError::MissingDeclared(backend.module.clone()));
        }
        let len = fs::metadata(&path)?.len();
        if len > MAX_WASM_BYTES {
            return Err(ZipError::EntryTooLarge {
                name: backend.module.clone(),
                len,
                limit: MAX_WASM_BYTES,
            });
        }
        backend_sha256 = Some(sha256_file(&path)?);
        backend_wasm = Some(path);
    }

    Ok(ExtractedPackage {
        dir: root,
        manifest: manifest.clone(),
        backend_wasm,
        backend_sha256,
        entries: written,
        uncompressed_bytes: total,
    })
}

pub fn entry_allowed(name: &str, manifest: &PluginManifest) -> bool {
    if check_entry_name(name.trim_end_matches('/')).is_err() {
        return false;
    }
    if name == MANIFEST_ENTRY {
        return true;
    }
    if let Some(rest) = name.strip_prefix(FRONTEND_PREFIX) {
        return !rest.is_empty();
    }
    manifest
        .backend
        .as_ref()
        .is_some_and(|backend| backend.module == name)
}

fn check_entry_name(name: &str) -> Result<(), ZipError> {
    if name.is_empty() {
        return Err(ZipError::Traversal(String::new()));
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(ZipError::AbsolutePath(name.to_string()));
    }
    if name.contains(':') || name.contains('\\') || name.contains('\0') {
        return Err(ZipError::Traversal(name.to_string()));
    }
    if name
        .split('/')
        .any(|segment| segment.is_empty() || segment == ".." || segment == ".")
    {
        return Err(ZipError::Traversal(name.to_string()));
    }
    Ok(())
}

pub fn inside_root(root: &Path, candidate: &Path) -> bool {
    let Ok(root) = std::path::absolute(root).and_then(|root| root.canonicalize()) else {
        return false;
    };
    let Ok(candidate) = std::path::absolute(candidate) else {
        return false;
    };

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return false;
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    if !normalized.starts_with(&root) {
        return false;
    }

    let mut probe = normalized.as_path();
    loop {
        if let Ok(real) = probe.canonicalize() {
            return real.starts_with(&root);
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return false,
        }
    }
}

pub fn wasm_exports(path: &Path, name: &str) -> io::Result<bool> {
    let bytes = fs::read(path)?;
    if bytes.len() < WASM_PREAMBLE.len() || bytes[..WASM_PREAMBLE.len()] != WASM_PREAMBLE {
        return Ok(false);
    }

    let mut cursor = WASM_PREAMBLE.len();
    while cursor < bytes.len() {
        let section_id = bytes[cursor];
        cursor += 1;
        let Some((size, used)) = read_leb128(&bytes[cursor..]) else {
            return Ok(false);
        };
        cursor += used;
        let Some(end) = cursor
            .checked_add(size as usize)
            .filter(|end| *end <= bytes.len())
        else {
            return Ok(false);
        };
        if section_id == 7 {
            return Ok(export_section_has(&bytes[cursor..end], name));
        }
        cursor = end;
    }
    Ok(false)
}

fn export_section_has(section: &[u8], wanted: &str) -> bool {
    let Some((count, mut cursor)) = read_leb128(section) else {
        return false;
    };
    for _ in 0..count {
        let Some((len, used)) = read_leb128(&section[cursor.min(section.len())..]) else {
            return false;
        };
        cursor += used;
        let end = cursor + len as usize;
        if end > section.len() {
            return false;
        }
        if section[cursor..end] == *wanted.as_bytes() {
            return true;
        }
        cursor = end + 1;
        let Some((_, used)) = read_leb128(&section[cursor.min(section.len())..]) else {
            return false;
        };
        cursor += used;
    }
    false
}

fn read_leb128(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut value: u64 = 0;
    for (index, byte) in bytes.iter().take(5).enumerate() {
        value |= u64::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
    }
    None
}

pub fn wait_for_stable(
    path: &Path,
    stable_for: Duration,
    timeout: Duration,
) -> std::io::Result<u64> {
    let started = Instant::now();
    let mut last = fs::metadata(path)?.len();
    let mut unchanged_since = Instant::now();

    loop {
        if unchanged_since.elapsed() >= stable_for {
            return Ok(last);
        }
        if started.elapsed() >= timeout {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "{} is still changing after {}s",
                    path.display(),
                    timeout.as_secs()
                ),
            ));
        }
        std::thread::sleep(STABLE_POLL.min(stable_for));
        let len = fs::metadata(path)?.len();
        if len != last {
            last = len;
            unchanged_since = Instant::now();
        }
    }
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = io::BufReader::new(fs::File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(module: Option<&str>) -> PluginManifest {
        let backend = module.map(|module| serde_json::json!({ "module": module }));
        serde_json::from_value(serde_json::json!({
            "id": "demo",
            "version": "1.0.0",
            "kernel": "^2.0",
            "frontend": { "module": "frontend/index.mjs" },
            "backend": backend,
        }))
        .expect("a valid manifest")
    }

    #[test]
    fn only_the_manifest_the_frontend_and_the_declared_module_come_out() {
        let with_wasm = manifest(Some("backend.wasm"));
        assert!(entry_allowed("manifest.json", &with_wasm));
        assert!(entry_allowed("frontend/index.mjs", &with_wasm));
        assert!(entry_allowed("frontend/assets/deep/style.css", &with_wasm));
        assert!(entry_allowed("backend.wasm", &with_wasm));

        assert!(!entry_allowed("backend.wasm", &manifest(None)));
        assert!(!entry_allowed("README.md", &with_wasm));
        assert!(!entry_allowed("frontend", &with_wasm));
        assert!(!entry_allowed("Frontend/index.mjs", &with_wasm));
        assert!(!entry_allowed(".git/config", &with_wasm));
        assert!(!entry_allowed(
            "protocols/navbar.item/protocol.json",
            &with_wasm
        ));
        assert!(entry_allowed("frontend/index.d.ts", &with_wasm));
    }

    #[test]
    fn hostile_names_are_refused_lexically() {
        let manifest = manifest(Some("backend.wasm"));
        for name in [
            "../../etc/cron.d/x",
            "/etc/passwd",
            "frontend/../../../etc/passwd",
            "frontend/./index.mjs",
            "frontend//index.mjs",
            "c:/windows/system32",
            "frontend\\index.mjs",
            "",
        ] {
            assert!(
                !entry_allowed(name, &manifest),
                "`{name}` must not be extractable"
            );
        }
    }

    #[test]
    fn a_resolved_path_must_stay_under_the_root() {
        let root = std::env::temp_dir().join(format!("ddd-inside-root-{}", std::process::id()));
        fs::create_dir_all(root.join("frontend")).expect("a staging root");

        assert!(inside_root(&root, &root.join("frontend/index.mjs")));
        assert!(inside_root(&root, &root.join("manifest.json")));
        assert!(!inside_root(&root, &root.join("../escape")));
        assert!(!inside_root(&root, Path::new("/etc/passwd")));
        assert!(!inside_root(&root, &root.join("frontend/../../escape")));
        assert!(!inside_root(
            Path::new("/nonexistent/ddd/staging"),
            Path::new("/nonexistent/ddd/staging/x")
        ));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_module_without_the_abi_export_is_recognised_as_such() {
        let dir = std::env::temp_dir().join(format!("ddd-wasm-scan-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("a temp dir");

        let not_wasm = dir.join("not.wasm");
        fs::write(&not_wasm, b"#!/bin/sh\n").expect("write");
        assert!(!wasm_exports(&not_wasm, "ddd_abi_version").expect("readable"));

        let empty = dir.join("empty.wasm");
        fs::write(&empty, WASM_PREAMBLE).expect("write");
        assert!(!wasm_exports(&empty, "ddd_abi_version").expect("readable"));

        let mut module = WASM_PREAMBLE.to_vec();
        let name = b"ddd_abi_version";
        let mut section = vec![1u8];
        section.push(name.len() as u8);
        section.extend_from_slice(name);
        section.push(0x00);
        section.push(0x00);
        module.push(7);
        module.push(section.len() as u8);
        module.extend_from_slice(&section);
        let good = dir.join("good.wasm");
        fs::write(&good, &module).expect("write");
        assert!(wasm_exports(&good, "ddd_abi_version").expect("readable"));
        assert!(!wasm_exports(&good, "ddd_cron").expect("readable"));

        let _ = fs::remove_dir_all(&dir);
    }
}
