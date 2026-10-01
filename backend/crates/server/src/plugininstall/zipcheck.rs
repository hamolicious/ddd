//! Zip hardening (SPEC §6.2): "manifest validated first; reject absolute paths/`..`/
//! symlinks/entries outside `frontend/**` + declared wasm; caps on uncompressed size
//! (50 MB), entry count, per-entry size; extract to temp, atomic rename".
//!
//! Treat every package as hostile input, because an uploaded zip is exactly that. The
//! attacks this file exists to stop, and the check that stops each:
//!
//! | Attack | Check |
//! |---|---|
//! | `../../etc/cron.d/x` | every entry name is lexically validated *and* the resolved path is re-checked against the staging root |
//! | `/etc/passwd` | absolute names refused |
//! | a symlink to `/` | symlink entries refused outright (never followed, never created) |
//! | zip bomb (42 KB → 4.5 PB) | uncompressed total, per-entry size and entry count caps, enforced **while** streaming, not from the header |
//! | a manifest that lies about the wasm path | only `frontend/**` plus the manifest's declared `backend.module` may be in the archive at all |
//! | a package for a different server | the manifest is parsed and validated before a single byte is written |
//!
//! Two details that are easy to get subtly wrong and are therefore spelled out:
//!
//! - **The caps are enforced on the bytes as they are written, never on the header.** A
//!   zip's local header may claim any uncompressed size it likes; [`extract`] counts what
//!   it actually copies and stops at the cap mid-entry. The header value is checked too,
//!   but only as a cheap early refusal.
//! - **An entry outside the allowlist is a refusal, not an omission.** SPEC §6.2 says
//!   "reject … entries outside `frontend/**` + declared wasm", so a package carrying a
//!   `README.md` or a Finder `__MACOSX/` sidecar fails to install with that entry named,
//!   rather than being installed minus the file. It is the stricter reading, and the reason
//!   for it is that a plugin is a full-trust artifact (SPEC §6.1): "what is in the package I
//!   approved" must be answerable from the package.
//! - **Nothing from the archive reaches the filesystem's metadata.** Permissions are not
//!   copied (an `0o777` or setuid mode in a package is simply ignored), mtimes are not
//!   restored, and directory entries are never created from the archive: parents are
//!   created as files need them, so an empty directory in a package is silently dropped
//!   rather than being a path to police.
//!
//! **Owner:** the `install-flow` builder.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use ddd_plugin_abi as abi;
use sha2::{Digest as _, Sha256};

use crate::plugins::PluginManifest;

/// Total compressed size of an uploaded package.
pub const MAX_ARCHIVE_BYTES: u64 = abi::limits::MAX_PACKAGE_BYTES;
/// Total uncompressed size (SPEC §6.2: 50 MB).
pub const MAX_UNCOMPRESSED_BYTES: u64 = abi::limits::MAX_PACKAGE_UNCOMPRESSED_BYTES;
pub const MAX_ENTRIES: usize = abi::limits::MAX_PACKAGE_ENTRIES;
pub const MAX_ENTRY_BYTES: u64 = abi::limits::MAX_PACKAGE_ENTRY_BYTES;
pub const MAX_MANIFEST_BYTES: u64 = abi::limits::MAX_MANIFEST_BYTES;
pub const MAX_WASM_BYTES: u64 = abi::limits::MAX_BACKEND_WASM_BYTES;

/// The file the manifest must be at, at the archive root.
pub const MANIFEST_ENTRY: &str = "manifest.json";
/// The only directory of browser assets that is extracted — and the only one the static
/// route will ever serve (`web/CONTRACTS.md`, the M3 carry-over).
pub const FRONTEND_PREFIX: &str = "frontend/";

/// How often [`wait_for_stable`] samples a file's size.
const STABLE_POLL: Duration = Duration::from_millis(250);

/// The four bytes every WebAssembly module starts with, followed by version 1.
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

/// What a validated, extracted package looks like on disk.
#[derive(Debug)]
pub struct ExtractedPackage {
    /// The staging directory. Renamed into place by the caller, or removed on failure.
    pub dir: PathBuf,
    pub manifest: PluginManifest,
    /// `<dir>/backend.wasm`, when the manifest declares one.
    pub backend_wasm: Option<PathBuf>,
    /// Hex SHA-256 of the backend module — recorded so "is the running plugin the one I
    /// approved" has an answer.
    pub backend_sha256: Option<String>,
    pub entries: usize,
    pub uncompressed_bytes: u64,
}

/// Read and parse `manifest.json` **without extracting anything**.
///
/// The first thing the pipeline does. A package for another kernel major, or with an id
/// that is not a valid plugin id, is refused before its bytes reach the filesystem.
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

    // The entry count is checked here, before the manifest, because a central directory
    // with a million entries is itself the attack: refusing it costs one integer compare
    // and saves the extraction loop from ever seeing it.
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

    // `take` and not `entry.size()`: the header is the archive's claim about itself, and a
    // 256 KiB claim in front of a gigabyte of JSON is a one-line denial of service.
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

    // The schema first, so the error names the field (`frontend.module must be a relative
    // path …`) rather than serde's line and column; the types second.
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

/// Extract the allowed entries into `staging`, enforcing every cap while streaming.
///
/// `staging` must be empty and on the same filesystem as `PLUGINS_DIR` — the install ends
/// in a rename, and a cross-device rename is a copy that can be interrupted half-way.
///
/// **The root itself is checked, not only the entry names.** Every other guard in this
/// module validates paths *inside* the archive; none of them can tell that the directory it
/// was handed already points somewhere it should not. The caller builds that directory from
/// manifest-controlled strings (`<staging>/work/<id>/<version>.<ulid>`), so a `..` that slips
/// through id/version validation would otherwise be laundered into arbitrary writes by
/// `create_dir_all` + `canonicalize` before the first entry is even read.
pub fn extract(
    archive: &Path,
    staging: &Path,
    manifest: &PluginManifest,
) -> Result<ExtractedPackage, ZipError> {
    // `..` only: `.` and a root are resolved harmlessly by `canonicalize`, and an operator
    // is entitled to configure `./data/staging`.
    if staging
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(ZipError::Traversal(staging.display().to_string()));
    }
    fs::create_dir_all(staging)?;
    // Absolute from here on: every path comparison below is `starts_with`, and a relative
    // root compared against a canonicalized candidate refuses everything, including the
    // entries that are fine.
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

        // A symlink is refused whatever it points at and wherever it sits — including one
        // inside `frontend/`, because the static route resolves paths on disk and a link
        // out of the package would be served (`web/CONTRACTS.md`).
        if entry.is_symlink() {
            return Err(ZipError::Symlink(name));
        }
        // Directory entries are validated and then dropped: parents are created as files
        // need them, so there is no second code path that makes directories.
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

        // `create_new`: an archive with the same name twice must not have its second copy
        // silently overwrite the first — the manifest the pipeline validated would then not
        // be the manifest on disk.
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

/// Is this entry name allowed out of the archive?
///
/// Lexical half of the traversal defence: no absolute paths, no `..` or `.` segments, no
/// backslashes or drive letters (a Windows-authored zip), no NUL, no leading `/`, and the
/// name must be either `manifest.json`, under `frontend/`, or exactly the manifest's
/// declared `backend.module`.
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

/// The lexical rules, with the error that names the reason — [`entry_allowed`] is the
/// boolean skin over it, and [`extract`] wants the specific refusal for its log line.
fn check_entry_name(name: &str) -> Result<(), ZipError> {
    if name.is_empty() {
        return Err(ZipError::Traversal(String::new()));
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(ZipError::AbsolutePath(name.to_string()));
    }
    // A Windows drive letter (`c:/x`) is absolute on the platform that wrote it, and the
    // colon is not a character any legitimate plugin asset needs.
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

/// The second half: the resolved path must still be inside `root` after canonicalization.
/// Belt and braces — the lexical check should already have caught it, and the one time it
/// does not is the one that matters.
pub fn inside_root(root: &Path, candidate: &Path) -> bool {
    let Ok(root) = std::path::absolute(root).and_then(|root| root.canonicalize()) else {
        return false;
    };
    let Ok(candidate) = std::path::absolute(candidate) else {
        return false;
    };

    // Lexical normalization first: `..` is popped rather than resolved, so a candidate
    // that climbs out fails here even if nothing on the path exists yet.
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

    // Then the filesystem's own answer, for the deepest ancestor that exists: if any
    // component is a symlink out of the tree, this is what notices. (`extract` refuses
    // symlink *entries*, so the only way one is here is if it was already on disk.)
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

/// Does this file look like a WebAssembly module that exports `name`?
///
/// A static scan of section 7 (exports) — no instantiation, no engine, no plugin code run.
/// It is what makes HOST-ABI.md §7.1 step 7 ("the declared module … and its
/// `ddd_abi_version` export") answerable at **install** time: the value that export returns
/// still needs a running instance, and the host re-checks it at activation before running
/// any of the plugin's own code. What this catches is the common, confusing case — a
/// manifest that declares a backend half next to a `.wasm` that was built without the
/// `abi_version!()` macro, or is not a module at all.
///
/// `Ok(false)` means "readable module, no such export"; an unreadable or truncated module
/// is also `Ok(false)` rather than an error, because "this is not a plugin module" is the
/// same answer for the caller and a parse error here would be an install failure with a
/// message about LEB128.
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

/// The export section is a vector of `(name, kind, index)`; only the names matter here.
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
        // name, then one byte of kind and a LEB128 index.
        cursor = end + 1;
        let Some((_, used)) = read_leb128(&section[cursor.min(section.len())..]) else {
            return false;
        };
        cursor += used;
    }
    false
}

/// Unsigned LEB128, capped at five bytes (a 32-bit value) → `(value, bytes consumed)`.
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

/// Wait until a file's size has been stable for `stable_for`, up to `timeout`.
///
/// What the directory watcher calls before touching a drop: a 20 MB zip being copied in is
/// a valid zip for none of the seconds it takes to arrive, and "manifest.json is
/// truncated" is a confusing way to learn that (SPEC §6.2: "the watcher waits for a stable
/// file").
///
/// **Blocking**, deliberately: it sleeps on a thread. The watcher calls it inside
/// `spawn_blocking`.
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

/// Hex SHA-256 of a file — the module fingerprint on the record.
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
    // The security cases live in `crates/server/tests/plugininstall_zip.rs`, where the
    // archive fixtures are shared with the pipeline tests: building a hostile zip is the
    // expensive part and both suites need the same ones. What stays here is the pure
    // path algebra, which has no fixtures at all.
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

        // Not declared, not extracted — even though the name is the conventional one.
        assert!(!entry_allowed("backend.wasm", &manifest(None)));
        // Everything else in the archive is ignored rather than trusted.
        assert!(!entry_allowed("README.md", &with_wasm));
        assert!(!entry_allowed("frontend", &with_wasm));
        assert!(!entry_allowed("Frontend/index.mjs", &with_wasm));
        assert!(!entry_allowed(".git/config", &with_wasm));
        // `@kernel` 3.0 has no protocol packages; a stale `protocols/` tree is ignored.
        // A plugin's types ship as `frontend/index.d.ts`, like every other asset.
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
        // A root that does not exist can contain nothing: the answer is "no", never a
        // panic and never an accidental `true`.
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

        // An empty module: the preamble and nothing else.
        let empty = dir.join("empty.wasm");
        fs::write(&empty, WASM_PREAMBLE).expect("write");
        assert!(!wasm_exports(&empty, "ddd_abi_version").expect("readable"));

        // A hand-assembled module whose only section is an export section naming one
        // function `ddd_abi_version` (function index 0).
        let mut module = WASM_PREAMBLE.to_vec();
        let name = b"ddd_abi_version";
        let mut section = vec![1u8]; // one export
        section.push(name.len() as u8);
        section.extend_from_slice(name);
        section.push(0x00); // kind: function
        section.push(0x00); // index 0
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
