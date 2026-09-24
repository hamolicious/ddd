//! Hostile plugin packages (SPEC §6.2, `backend/HOST-ABI.md` §7.1).
//!
//! Every case here is an attack that a plugin installer which "just extracts the zip" would
//! execute for the attacker, and the one check that stops it. They need no database and no
//! router: the unit under test is [`plugininstall::zipcheck`], and the fixtures are real
//! archives built with the `zip` crate under `CARGO_TARGET_TMPDIR`.
//!
//! The assertion that matters in all of them is the same, and it is not the error type: it
//! is that **nothing exists outside the staging root afterwards**. A refusal that has
//! already written the file is not a refusal.
//!
//! **Owner:** the `install-flow` builder.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use life_manager_server::domain::new_id;
use life_manager_server::plugininstall::zipcheck::{self, ZipError};
use life_manager_server::plugins::PluginManifest;
use zip::write::SimpleFileOptions;

/// A throwaway directory per case.
fn workspace(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("zipcheck-{name}-{}", new_id()));
    fs::create_dir_all(&dir).expect("a workspace");
    dir
}

fn manifest_json(backend: bool) -> String {
    let backend = if backend {
        r#", "backend": { "module": "backend.wasm" }"#
    } else {
        ""
    };
    format!(
        r#"{{"id":"demo","version":"1.0.0","kernel":"^1.0","frontend":{{"module":"frontend/index.mjs"}}{backend}}}"#
    )
}

/// The smallest module the install flow accepts: a preamble plus an export section naming
/// `lm_abi_version`.
fn wasm_with_abi_export() -> Vec<u8> {
    let mut module = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    let name = b"lm_abi_version";
    let mut section = vec![1u8];
    section.push(name.len() as u8);
    section.extend_from_slice(name);
    section.push(0x00);
    section.push(0x00);
    module.push(7);
    module.push(section.len() as u8);
    module.extend_from_slice(&section);
    module
}

/// One entry to put in a fixture archive.
enum Entry {
    File(&'static str, Vec<u8>),
    /// A symlink entry: the name, and what it points at.
    Symlink(&'static str, &'static str),
    Dir(&'static str),
}

fn archive(dir: &Path, entries: Vec<Entry>) -> PathBuf {
    let path = dir.join("package.zip");
    let file = fs::File::create(&path).expect("create the archive");
    let mut writer = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for entry in entries {
        match entry {
            Entry::File(name, bytes) => {
                writer.start_file(name, options).expect("start a file");
                writer.write_all(&bytes).expect("write");
            }
            Entry::Symlink(name, target) => {
                writer
                    .add_symlink(name, target, options)
                    .expect("add a symlink");
            }
            Entry::Dir(name) => {
                writer
                    .add_directory(name, options)
                    .expect("add a directory");
            }
        }
    }
    writer.finish().expect("finish the archive");
    path
}

fn manifest_of(archive: &Path) -> PluginManifest {
    zipcheck::read_manifest(archive).expect("the manifest parses")
}

/// Nothing may exist outside `staging` — the assertion every refusal shares.
fn assert_contained(staging: &Path, escape: &Path) {
    assert!(
        !escape.exists(),
        "{} exists: the refusal came after the write",
        escape.display()
    );
    if staging.exists() {
        for entry in fs::read_dir(staging)
            .expect("read the staging root")
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(
                name == "manifest.json" || name == "frontend" || name == "backend.wasm",
                "unexpected `{name}` in the staging root"
            );
        }
    }
}

#[test]
fn the_happy_path_extracts_exactly_the_three_allowed_things() {
    let dir = workspace("happy");
    let package = archive(
        &dir,
        vec![
            Entry::File("manifest.json", manifest_json(true).into_bytes()),
            Entry::Dir("frontend/"),
            Entry::File("frontend/index.mjs", b"export default 1;\n".to_vec()),
            Entry::File("frontend/style.css", b".x{}\n".to_vec()),
            Entry::File("backend.wasm", wasm_with_abi_export()),
        ],
    );

    let manifest = manifest_of(&package);
    let staging = dir.join("staging");
    let extracted = zipcheck::extract(&package, &staging, &manifest).expect("extracts");

    assert!(staging.join("manifest.json").is_file());
    assert!(staging.join("frontend/index.mjs").is_file());
    assert!(staging.join("frontend/style.css").is_file());
    assert!(staging.join("backend.wasm").is_file());
    assert_eq!(extracted.entries, 4);
    assert!(extracted.backend_wasm.is_some());
    assert_eq!(
        extracted.backend_sha256.as_ref().map(|hex| hex.len()),
        Some(64),
        "the module fingerprint is a hex sha256"
    );
}

#[test]
fn zip_slip_is_refused_before_anything_is_written() {
    let dir = workspace("slip");
    let package = archive(
        &dir,
        vec![
            Entry::File("manifest.json", manifest_json(false).into_bytes()),
            Entry::File("frontend/index.mjs", b"export default 1;\n".to_vec()),
            Entry::File("../../pwned", b"owned\n".to_vec()),
        ],
    );

    let manifest = manifest_of(&package);
    let staging = dir.join("staging");
    let error = zipcheck::extract(&package, &staging, &manifest).expect_err("must be refused");
    assert!(
        matches!(error, ZipError::Traversal(_) | ZipError::OutsideFrontend(_)),
        "unexpected refusal: {error}"
    );
    assert_contained(&staging, &dir.join("../../pwned"));
    assert!(!Path::new("/tmp/pwned").exists());
}

#[test]
fn an_absolute_entry_is_refused() {
    let dir = workspace("absolute");
    let package = archive(
        &dir,
        vec![
            Entry::File("manifest.json", manifest_json(false).into_bytes()),
            Entry::File("frontend/index.mjs", b"x".to_vec()),
            Entry::File("/etc/cron.d/pwned", b"* * * * * root sh\n".to_vec()),
        ],
    );

    let manifest = manifest_of(&package);
    let staging = dir.join("staging");
    let error = zipcheck::extract(&package, &staging, &manifest).expect_err("must be refused");
    assert!(
        matches!(
            error,
            ZipError::AbsolutePath(_) | ZipError::Traversal(_) | ZipError::OutsideFrontend(_)
        ),
        "unexpected refusal: {error}"
    );
    // The staging root must not have grown an `etc/` either: an absolute name that is
    // merely *stripped* rather than refused is the bug this asserts against.
    assert!(!staging.join("etc").exists());
}

#[test]
fn a_symlink_entry_is_refused_outright() {
    let dir = workspace("symlink");
    let package = archive(
        &dir,
        vec![
            Entry::File("manifest.json", manifest_json(false).into_bytes()),
            Entry::File("frontend/index.mjs", b"x".to_vec()),
            // Inside `frontend/`, which is what makes it interesting: the static route
            // resolves paths on disk, so a link out of the package would be *served*.
            Entry::Symlink("frontend/secrets", "/etc/passwd"),
        ],
    );

    let manifest = manifest_of(&package);
    let staging = dir.join("staging");
    let error = zipcheck::extract(&package, &staging, &manifest).expect_err("must be refused");
    assert!(
        matches!(error, ZipError::Symlink(_)),
        "unexpected refusal: {error}"
    );
    assert!(!staging.join("frontend/secrets").exists());
}

#[test]
fn a_zip_bomb_is_stopped_while_streaming() {
    let dir = workspace("bomb");
    // 60 MB of zeroes compresses to a few kilobytes and expands past the 50 MB cap. The
    // cap is enforced on bytes written, so this stops mid-entry rather than on the header.
    let mut entries = vec![
        Entry::File("manifest.json", manifest_json(false).into_bytes()),
        Entry::File("frontend/index.mjs", b"x".to_vec()),
    ];
    let chunk = vec![0u8; 12 * 1024 * 1024];
    for name in [
        "frontend/a.bin",
        "frontend/b.bin",
        "frontend/c.bin",
        "frontend/d.bin",
        "frontend/e.bin",
    ] {
        entries.push(Entry::File(name, chunk.clone()));
    }
    let package = archive(&dir, entries);
    assert!(
        fs::metadata(&package).expect("stat").len() < 1024 * 1024,
        "the fixture is supposed to be a small archive"
    );

    let manifest = manifest_of(&package);
    let staging = dir.join("staging");
    let error = zipcheck::extract(&package, &staging, &manifest).expect_err("must be refused");
    assert!(
        matches!(
            error,
            ZipError::Bomb { .. } | ZipError::EntryTooLarge { .. }
        ),
        "unexpected refusal: {error}"
    );
}

#[test]
fn a_declared_module_that_is_not_in_the_archive_is_refused() {
    let dir = workspace("missing-wasm");
    let package = archive(
        &dir,
        vec![
            Entry::File("manifest.json", manifest_json(true).into_bytes()),
            Entry::File("frontend/index.mjs", b"x".to_vec()),
        ],
    );

    let manifest = manifest_of(&package);
    let staging = dir.join("staging");
    let error = zipcheck::extract(&package, &staging, &manifest).expect_err("must be refused");
    assert!(
        matches!(error, ZipError::MissingDeclared(ref name) if name == "backend.wasm"),
        "unexpected refusal: {error}"
    );
}

#[test]
fn a_module_the_manifest_does_not_declare_is_refused() {
    let dir = workspace("undeclared-wasm");
    let package = archive(
        &dir,
        vec![
            // No `backend` in the manifest…
            Entry::File("manifest.json", manifest_json(false).into_bytes()),
            Entry::File("frontend/index.mjs", b"x".to_vec()),
            // …so this is just a file with a suggestive name, and SPEC §6.2's rule is
            // "reject entries outside `frontend/**` + declared wasm".
            Entry::File("backend.wasm", wasm_with_abi_export()),
        ],
    );

    let manifest = manifest_of(&package);
    let staging = dir.join("staging");
    let error = zipcheck::extract(&package, &staging, &manifest).expect_err("must be refused");
    assert!(
        matches!(error, ZipError::OutsideFrontend(ref name) if name == "backend.wasm"),
        "unexpected refusal: {error}"
    );
    assert!(!staging.join("backend.wasm").exists());
}

/// SPEC §6.2 says **reject** entries outside the allowlist, not "ignore them", so a stray
/// file is an install error naming it rather than a silent omission.
///
/// The cost is deliberate and worth stating: a zip made by dragging a folder onto a
/// Finder window (`__MACOSX/`, `.DS_Store`) or one that carries a `README.md` is refused
/// with a message naming the entry. The alternative — extracting the allowlist and
/// ignoring the rest — makes "what is in the package I approved?" unanswerable from the
/// package, which is the wrong trade for a full-trust artifact (SPEC §6.1).
#[test]
fn an_entry_outside_the_allowlist_is_refused_even_when_it_is_harmless() {
    let dir = workspace("stray");
    let package = archive(
        &dir,
        vec![
            Entry::File("manifest.json", manifest_json(false).into_bytes()),
            Entry::File("frontend/index.mjs", b"x".to_vec()),
            Entry::File("README.md", b"hello\n".to_vec()),
        ],
    );

    let manifest = manifest_of(&package);
    let staging = dir.join("staging");
    let error = zipcheck::extract(&package, &staging, &manifest).expect_err("must be refused");
    assert!(
        matches!(error, ZipError::OutsideFrontend(ref name) if name == "README.md"),
        "unexpected refusal: {error}"
    );
}

#[test]
fn an_archive_with_no_manifest_is_refused_without_extracting() {
    let dir = workspace("no-manifest");
    let package = archive(&dir, vec![Entry::File("frontend/index.mjs", b"x".to_vec())]);
    let error = zipcheck::read_manifest(&package).expect_err("must be refused");
    assert!(matches!(error, ZipError::MissingManifest), "{error}");
}

#[test]
fn a_manifest_that_is_not_json_is_refused_without_extracting() {
    let dir = workspace("bad-manifest");
    let package = archive(
        &dir,
        vec![
            Entry::File("manifest.json", b"{ not json".to_vec()),
            Entry::File("frontend/index.mjs", b"x".to_vec()),
        ],
    );
    let error = zipcheck::read_manifest(&package).expect_err("must be refused");
    assert!(matches!(error, ZipError::BadManifest(_)), "{error}");
    // Nothing was staged, because nothing was extracted: the manifest is read from the
    // archive in place.
    assert!(!dir.join("staging").exists());
}

#[test]
fn a_file_that_is_not_a_zip_is_refused() {
    let dir = workspace("not-zip");
    let path = dir.join("package.zip");
    fs::write(&path, b"this is not a zip archive").expect("write");
    let error = zipcheck::read_manifest(&path).expect_err("must be refused");
    assert!(matches!(error, ZipError::NotZip(_)), "{error}");
}

#[test]
fn a_stable_file_is_waited_for_and_a_growing_one_times_out() {
    let dir = workspace("stable");
    let path = dir.join("growing.zip");
    fs::write(&path, b"first").expect("write");

    // Already stable: returns its size promptly.
    let len = zipcheck::wait_for_stable(
        &path,
        std::time::Duration::from_millis(50),
        std::time::Duration::from_secs(2),
    )
    .expect("a stable file");
    assert_eq!(len, 5);

    // Still being written: a copy in progress must not be handed to the installer.
    let growing = path.clone();
    let writer = std::thread::spawn(move || {
        for _ in 0..20 {
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(&growing)
                .expect("append");
            file.write_all(b"more").expect("write");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });
    let error = zipcheck::wait_for_stable(
        &path,
        std::time::Duration::from_millis(400),
        std::time::Duration::from_millis(600),
    )
    .expect_err("a growing file must not be declared stable");
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    writer.join().expect("the writer thread");
}

/// The version string is a filesystem path component, and the manifest supplies it.
///
/// This is the *other* zip slip, and it went around every check in this module: the entry names
/// were all legal (`manifest.json`, `frontend/**`), and the escape was in the directory the
/// installer built out of `manifest.version` before extraction began —
/// `<staging>/work/<id>/1.0.0-../../../../srv/web/evil.<ulid>`. `create_dir_all` made the
/// literal `1.0.0-..` segment, `canonicalize` then resolved the `../../../..` upward, and every
/// allowlisted entry landed outside the staging tree as the server process. With
/// `PLUGINS_DIR`/`PLUGIN_STAGING_DIR` beside `WEB_DIST_DIR` (the Compose layout) a
/// `frontend/evil.js` became a persistent same-origin script for every user that rejecting the
/// package could not remove — and the inbox watcher reaches the same primitive with no admin
/// click at all.
///
/// Two defences, tested separately because either alone would be enough and neither should be
/// removed on the strength of the other.
#[test]
fn a_version_string_cannot_escape_the_staging_root() {
    // 1. The validator refuses the version, so no such directory is ever built.
    for bad in [
        "1.0.0-../../../../srv/web/evil",
        "1.0.0+../evil",
        "1.0.0-..",
        "1.0.0-a/b",
    ] {
        assert!(
            !life_manager_server::plugins::is_valid_version(bad),
            "`{bad}` must not validate as a version"
        );
    }

    // 2. And `extract` refuses a root with a `..` in it whatever built it, so a future caller
    //    that constructs a path some other way cannot launder one through `canonicalize`.
    let dir = workspace("version-escape");
    let package = archive(
        &dir,
        vec![
            Entry::File("manifest.json", manifest_json(false).into_bytes()),
            Entry::File("frontend/index.mjs", b"export default 1;\n".to_vec()),
        ],
    );
    let manifest = manifest_of(&package);
    let escaping = dir.join("staging/work/demo/1.0.0-../../../../escaped");
    let error = zipcheck::extract(&package, &escaping, &manifest).expect_err("must be refused");
    assert!(
        matches!(error, ZipError::Traversal(_)),
        "unexpected refusal: {error}"
    );
    assert!(
        !dir.join("../../../escaped").exists(),
        "the root was created before it was checked"
    );
}
