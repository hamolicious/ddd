use std::future::Future;
use std::path::{Path, PathBuf};

use axum::extract::Multipart;
use tokio::io::AsyncWriteExt;

use crate::config::Config;
use crate::domain::new_id;
use crate::error::{AppError, AppResult};

use super::{InstallSource, staging_dir, zipcheck};

pub const MAX_PACKAGE_BYTES: u64 = zipcheck::MAX_ARCHIVE_BYTES;

pub const PACKAGE_FIELD: &str = "package";
pub const SOURCE_FIELD: &str = "source";
pub const URL_FIELD: &str = "url";
pub const UPDATE_FIELD: &str = "update";

pub const MAX_SOURCE_ID_CHARS: usize = 64;
pub const MAX_URL_CHARS: usize = 2048;

const OTHER_FIELDS_BUDGET: u64 = 64 * 1024;

const STAGING_SUBDIR: &str = "uploads";

pub struct StagedPackage {
    pub archive: PathBuf,
    pub source: InstallSource,
    pub update: Option<String>,
}

impl StagedPackage {
    pub async fn discard(&self) {
        let _ = tokio::fs::remove_file(&self.archive).await;
    }
}

pub trait PackageSource: Send {
    fn stage(self, config: &Config) -> impl Future<Output = AppResult<StagedPackage>> + Send;
}

pub struct UploadedPackage(pub Multipart);

impl PackageSource for UploadedPackage {
    async fn stage(self, config: &Config) -> AppResult<StagedPackage> {
        stage_upload(config, self.0).await
    }
}

#[derive(Debug, Default)]
struct UploadDetails {
    source: Option<String>,
    url: Option<String>,
    update: Option<String>,
}

impl UploadDetails {
    fn accept(&mut self, name: &str, value: String) -> AppResult<()> {
        let value = value.trim().to_string();
        if value.is_empty() {
            return Ok(());
        }
        match name {
            SOURCE_FIELD => {
                validate_source_id(&value)?;
                self.source = Some(value);
            }
            URL_FIELD => self.url = Some(recorded_url(&value)?),
            UPDATE_FIELD => self.update = Some(value),
            _ => {}
        }
        Ok(())
    }

    fn origin(self, filename: String) -> (InstallSource, Option<String>) {
        let source = match (self.source, self.url) {
            (Some(via), Some(url)) => InstallSource::Remote { url, via },
            _ => InstallSource::Upload { filename },
        };
        (source, self.update)
    }
}

async fn staging_file(config: &Config, filename: &str) -> AppResult<PathBuf> {
    let directory = staging_dir(config).join(STAGING_SUBDIR);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| io_error("creating the plugin staging directory", error))?;
    Ok(directory.join(format!("{}-{}", new_id(), filename)))
}

async fn stage_upload(config: &Config, mut multipart: Multipart) -> AppResult<StagedPackage> {
    let mut details = UploadDetails::default();
    let mut staged: Option<(PathBuf, String)> = None;
    let mut other_bytes: u64 = 0;

    let outcome = async {
        while let Some(mut field) = multipart
            .next_field()
            .await
            .map_err(|error| AppError::bad_request(format!("malformed multipart body: {error}")))?
        {
            let is_package = field.file_name().is_some() || field.name() == Some(PACKAGE_FIELD);
            if !is_package {
                let name = field.name().unwrap_or_default().to_string();
                let mut value = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(|error| {
                    AppError::bad_request(format!("malformed multipart body: {error}"))
                })? {
                    other_bytes += chunk.len() as u64;
                    if other_bytes > OTHER_FIELDS_BUDGET {
                        return Err(AppError::bad_request(
                            "multipart body has too much non-file content",
                        ));
                    }
                    value.extend_from_slice(&chunk);
                }
                details.accept(&name, String::from_utf8_lossy(&value).into_owned())?;
                continue;
            }
            if staged.is_some() {
                return Err(AppError::bad_request("send one package per upload"));
            }

            let filename = sanitize_package_name(field.file_name());
            let path = staging_file(config, &filename).await?;
            let mut sink = PackageSink::create(&path).await?;
            staged = Some((path, filename));
            loop {
                let chunk = match field.chunk().await {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        sink.abandon().await;
                        return Err(AppError::bad_request(format!(
                            "upload interrupted: {error}"
                        )));
                    }
                };
                let Some(chunk) = chunk else { break };
                sink.write(&chunk).await?;
            }
            sink.finish("the uploaded package is empty").await?;
        }
        Ok(())
    }
    .await;

    if let Err(error) = outcome {
        if let Some((path, _)) = &staged {
            let _ = tokio::fs::remove_file(path).await;
        }
        return Err(error);
    }
    let Some((archive, filename)) = staged else {
        return Err(AppError::bad_request(format!(
            "multipart body has no package part (send the zip as `{PACKAGE_FIELD}`)"
        )));
    };
    let (source, update) = details.origin(filename);
    Ok(StagedPackage {
        archive,
        source,
        update,
    })
}

pub fn validate_source_id(id: &str) -> AppResult<()> {
    let well_formed = !id.is_empty()
        && id.chars().count() <= MAX_SOURCE_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
    if well_formed {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "a source id is 1 to {MAX_SOURCE_ID_CHARS} letters, digits, `-`, `_`, `.` or `:`"
        )))
    }
}

pub fn recorded_url(raw: &str) -> AppResult<String> {
    let mut url = reqwest::Url::parse(raw.trim())
        .map_err(|error| AppError::bad_request(format!("`{raw}` is not a URL: {error}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(AppError::bad_request(format!(
            "`{}` is not a package address; use http or https",
            url.scheme()
        )));
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    let recorded = url.to_string();
    if recorded.chars().count() > MAX_URL_CHARS {
        return Err(AppError::bad_request(format!(
            "a package address may be at most {MAX_URL_CHARS} characters"
        )));
    }
    Ok(recorded)
}

struct PackageSink {
    path: PathBuf,
    file: tokio::fs::File,
    size: u64,
}

impl PackageSink {
    async fn create(path: &Path) -> AppResult<PackageSink> {
        let file = tokio::fs::File::create(path)
            .await
            .map_err(|error| io_error("creating the staged package file", error))?;
        Ok(PackageSink {
            path: path.to_path_buf(),
            file,
            size: 0,
        })
    }

    async fn write(&mut self, chunk: &[u8]) -> AppResult<()> {
        self.size += chunk.len() as u64;
        if self.size > MAX_PACKAGE_BYTES {
            let len = self.size;
            self.remove().await;
            return Err(AppError::PayloadTooLarge {
                len,
                limit: MAX_PACKAGE_BYTES,
            });
        }
        if let Err(error) = self.file.write_all(chunk).await {
            self.remove().await;
            return Err(io_error("writing the staged package", error));
        }
        Ok(())
    }

    async fn finish(mut self, empty_message: &str) -> AppResult<()> {
        if self.size == 0 {
            self.remove().await;
            return Err(AppError::bad_request(empty_message));
        }
        let synced = async {
            self.file
                .flush()
                .await
                .map_err(|error| io_error("flushing the staged package", error))?;
            self.file
                .sync_all()
                .await
                .map_err(|error| io_error("syncing the staged package", error))
        }
        .await;
        if synced.is_err() {
            self.remove().await;
        }
        synced
    }

    async fn abandon(self) {
        self.remove().await;
    }

    async fn remove(&self) {
        let _ = tokio::fs::remove_file(&self.path).await;
    }
}

fn io_error(step: &str, error: std::io::Error) -> AppError {
    AppError::Internal(anyhow::anyhow!("{step}: {error}"))
}

pub fn sanitize_package_name(raw: Option<&str>) -> String {
    let candidate = raw
        .unwrap_or("package.zip")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("package.zip")
        .trim();
    let cleaned: String = candidate
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(96)
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        "package.zip".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_id_is_a_short_plain_name() {
        for good in ["upload", "gitlab", "0193f1c2-aa", "a.b_c:d"] {
            assert!(validate_source_id(good).is_ok(), "{good}");
        }
        for bad in ["", "has space", "slash/y", &"x".repeat(MAX_SOURCE_ID_CHARS + 1)] {
            assert!(validate_source_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_recorded_url_keeps_no_credentials_query_or_fragment() {
        assert_eq!(
            recorded_url("https://user:secret@cdn.example.com/p.zip?X-Amz-Signature=abc#top")
                .expect("a url"),
            "https://cdn.example.com/p.zip"
        );
        assert!(recorded_url("file:///etc/passwd").is_err());
        assert!(recorded_url("not a url").is_err());
    }

    #[test]
    fn upload_details_name_the_source_only_with_both_source_and_url() {
        let mut details = UploadDetails::default();
        details.accept(SOURCE_FIELD, "work-gitlab".into()).expect("a source");
        details
            .accept(URL_FIELD, "https://g.example.com/a.zip?private_token=x".into())
            .expect("a url");
        details.accept(UPDATE_FIELD, "tasks".into()).expect("an update");
        let (source, update) = details.origin("a.zip".into());
        assert_eq!(
            source,
            InstallSource::Remote {
                url: "https://g.example.com/a.zip".into(),
                via: "work-gitlab".into(),
            }
        );
        assert_eq!(update.as_deref(), Some("tasks"));

        let mut details = UploadDetails::default();
        details.accept(SOURCE_FIELD, "work-gitlab".into()).expect("a source");
        let (source, update) = details.origin("a.zip".into());
        assert_eq!(source, InstallSource::Upload { filename: "a.zip".into() });
        assert!(update.is_none());

        assert!(UploadDetails::default().accept(SOURCE_FIELD, "bad id".into()).is_err());
    }

    #[test]
    fn an_uploaded_filename_can_never_escape_the_staging_directory() {
        assert_eq!(
            sanitize_package_name(Some("plugin-1.0.0.zip")),
            "plugin-1.0.0.zip"
        );
        assert_eq!(sanitize_package_name(Some("../../etc/cron.d/x")), "x");
        assert_eq!(sanitize_package_name(Some("/etc/passwd")), "passwd");
        assert_eq!(sanitize_package_name(Some("..\\..\\windows")), "windows");
        assert_eq!(sanitize_package_name(Some("..")), "package.zip");
        assert_eq!(sanitize_package_name(Some("   ")), "package.zip");
        assert_eq!(sanitize_package_name(None), "package.zip");
        assert_eq!(sanitize_package_name(Some("a b;c$.zip")), "abc.zip");
        assert!(!sanitize_package_name(Some("a".repeat(500).as_str())).is_empty());
        assert!(sanitize_package_name(Some("a".repeat(500).as_str())).len() <= 96);
        for name in ["../x", "/x", "a\0b.zip", "x/../y"] {
            let cleaned = sanitize_package_name(Some(name));
            assert!(!cleaned.contains('/') && !cleaned.contains("..") && !cleaned.contains('\0'));
        }
    }
}
