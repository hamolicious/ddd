use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use ddd_server::domain::new_id;
use ddd_server::plugininstall::zipcheck::{self, ZipError};
use ddd_server::plugins::PluginManifest;
use zip::write::SimpleFileOptions;

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
        r#"{{"id":"demo","version":"1.0.0","kernel":"^3.0","frontend":{{"module":"frontend/index.mjs"}}{backend}}}"#
    )
}

fn wasm_with_abi_export() -> Vec<u8> {
    let mut module = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    let name = b"ddd_abi_version";
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

enum Entry {
    File(&'static str, Vec<u8>),
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
            Entry::File("manifest.json", manifest_json(false).into_bytes()),
            Entry::File("frontend/index.mjs", b"x".to_vec()),
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

    let len = zipcheck::wait_for_stable(
        &path,
        std::time::Duration::from_millis(50),
        std::time::Duration::from_secs(2),
    )
    .expect("a stable file");
    assert_eq!(len, 5);

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

#[test]
fn a_version_string_cannot_escape_the_staging_root() {
    for bad in [
        "1.0.0-../../../../srv/web/evil",
        "1.0.0+../evil",
        "1.0.0-..",
        "1.0.0-a/b",
    ] {
        assert!(
            !ddd_server::plugins::is_valid_version(bad),
            "`{bad}` must not validate as a version"
        );
    }

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
