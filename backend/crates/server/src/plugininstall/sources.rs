use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::extract::Multipart;
use ddd_plugin_abi as abi;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::config::Config;
use crate::domain::new_id;
use crate::error::{AppError, AppResult};
use crate::pluginhost::host_fns;

use super::{InstallSource, staging_dir, zipcheck};

pub const MAX_PACKAGE_BYTES: u64 = zipcheck::MAX_ARCHIVE_BYTES;

pub const PACKAGE_FIELD: &str = "package";

pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

pub const MAX_SOURCE_ID_CHARS: usize = 64;

pub const MAX_LOOKUP_BYTES: usize = 1024 * 1024;

const OTHER_FIELDS_BUDGET: u64 = 64 * 1024;

const STAGING_SUBDIR: &str = "uploads";

pub struct StagedPackage {
    pub archive: PathBuf,
    pub source: InstallSource,
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

#[derive(Debug, Clone, Deserialize)]
pub struct RemotePackage {
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub via: String,
}

impl PackageSource for RemotePackage {
    async fn stage(self, config: &Config) -> AppResult<StagedPackage> {
        stage_remote(config, self).await
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
    let mut other_bytes: u64 = 0;
    loop {
        let Some(mut field) = multipart
            .next_field()
            .await
            .map_err(|error| AppError::bad_request(format!("malformed multipart body: {error}")))?
        else {
            return Err(AppError::bad_request(format!(
                "multipart body has no package part (send the zip as `{PACKAGE_FIELD}`)"
            )));
        };

        let is_package = field.file_name().is_some() || field.name() == Some(PACKAGE_FIELD);
        if !is_package {
            while let Some(chunk) = field.chunk().await.map_err(|error| {
                AppError::bad_request(format!("malformed multipart body: {error}"))
            })? {
                other_bytes += chunk.len() as u64;
                if other_bytes > OTHER_FIELDS_BUDGET {
                    return Err(AppError::bad_request(
                        "multipart body has too much non-file content",
                    ));
                }
            }
            continue;
        }

        let filename = sanitize_package_name(field.file_name());
        let path = staging_file(config, &filename).await?;
        let mut sink = PackageSink::create(&path).await?;
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

        return Ok(StagedPackage {
            archive: path,
            source: InstallSource::Upload { filename },
        });
    }
}

async fn stage_remote(config: &Config, request: RemotePackage) -> AppResult<StagedPackage> {
    validate_source_id(&request.via)?;
    let url = parse_package_url(&request.url)?;
    let headers = request_headers(&request.headers)?;
    let authenticated = !headers.is_empty();

    let filename = sanitize_package_name(
        url.path_segments()
            .and_then(|mut segments| segments.next_back())
            .filter(|segment| !segment.is_empty()),
    );
    let path = staging_file(config, &filename).await?;
    let sink = PackageSink::create(&path).await?;

    download(config, url.clone(), headers, sink).await?;

    Ok(StagedPackage {
        archive: path,
        source: InstallSource::Remote {
            url: recorded_url(&url),
            via: request.via,
            authenticated,
        },
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
            "`via` names the source that asked for this package: 1 to {MAX_SOURCE_ID_CHARS} \
             letters, digits, `-`, `_`, `.` or `:`"
        )))
    }
}

pub fn parse_package_url(raw: &str) -> AppResult<reqwest::Url> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|error| AppError::bad_request(format!("`{raw}` is not a URL: {error}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(AppError::bad_request(format!(
            "`{}` is not a scheme a package can be downloaded from; use http or https",
            url.scheme()
        )));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(AppError::bad_request(format!("{url} has no host")));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::bad_request(
            "put credentials in a request header, not in the URL",
        ));
    }
    Ok(url)
}

pub fn recorded_url(url: &reqwest::Url) -> String {
    let mut recorded = url.clone();
    recorded.set_query(None);
    recorded.set_fragment(None);
    recorded.to_string()
}

pub fn request_headers(
    headers: &BTreeMap<String, String>,
) -> AppResult<reqwest::header::HeaderMap> {
    if headers.len() > abi::limits::MAX_HTTP_REQUEST_HEADERS {
        return Err(AppError::bad_request(format!(
            "{} request headers, the limit is {}",
            headers.len(),
            abi::limits::MAX_HTTP_REQUEST_HEADERS
        )));
    }
    let mut map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        let lower = name.trim().to_ascii_lowercase();
        if host_fns::REFUSED_REQUEST_HEADERS.contains(&lower.as_str()) {
            return Err(AppError::bad_request(format!(
                "`{name}` describes the connection, not the request, and the server sets it"
            )));
        }
        if lower.len() + value.len() > abi::limits::MAX_HTTP_HEADER_BYTES {
            return Err(AppError::bad_request(format!(
                "header `{name}` is over the {} byte cap",
                abi::limits::MAX_HTTP_HEADER_BYTES
            )));
        }
        let header_name = reqwest::header::HeaderName::from_bytes(lower.as_bytes())
            .map_err(|_| AppError::bad_request(format!("`{name}` is not a header name")))?;
        let mut header_value = reqwest::header::HeaderValue::from_str(value).map_err(|_| {
            AppError::bad_request(format!("the value of `{name}` is not a legal header value"))
        })?;
        header_value.set_sensitive(true);
        map.insert(header_name, header_value);
    }
    Ok(map)
}

async fn fetch(
    config: &Config,
    mut url: reqwest::Url,
    mut headers: reqwest::header::HeaderMap,
) -> AppResult<reqwest::Response> {
    let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
    let origin = host_fns::origin_of(&url);
    let shown = recorded_url(&url);
    let mut hops = 0u32;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(AppError::Unavailable(format!(
                "fetching {shown} ran out of time"
            )));
        }

        let host = url.host_str().unwrap_or_default().to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let addresses =
            host_fns::resolve_pinned(&host, port, &config.plugin_http_allow_cidrs, remaining)
                .await
                .map_err(refused)?;

        let client = reqwest::Client::builder()
            .resolve_to_addrs(&host, &addresses)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(remaining)
            .user_agent(concat!("ddd/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| AppError::Internal(error.into()))?;

        let response = client
            .get(url.clone())
            .headers(headers.clone())
            .send()
            .await
            .map_err(|error| AppError::Unavailable(format!("fetching {shown} failed: {error}")))?;

        let status = response.status();
        if !host_fns::is_redirect(status) {
            return Ok(response);
        }
        if hops >= abi::limits::MAX_HTTP_REDIRECTS {
            return Err(AppError::bad_request(format!(
                "more than {} redirects from {shown}",
                abi::limits::MAX_HTTP_REDIRECTS
            )));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                AppError::Unavailable(format!("{shown} answered {status} with no Location"))
            })?;
        url = url.join(location).map_err(|error| {
            AppError::Unavailable(format!(
                "{shown} redirected to something unparseable: {error}"
            ))
        })?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(AppError::bad_request(format!(
                "{shown} redirected to a `{}` URL",
                url.scheme()
            )));
        }
        if host_fns::origin_of(&url) != origin {
            headers.clear();
        }
        hops += 1;
    }
}

async fn download(
    config: &Config,
    url: reqwest::Url,
    headers: reqwest::header::HeaderMap,
    mut sink: PackageSink,
) -> AppResult<()> {
    let shown = recorded_url(&url);
    let outcome = async {
        let mut response = fetch(config, url, headers).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(AppError::bad_request(refusal_message(&shown, status)));
        }
        if let Some(claimed) = response.content_length()
            && claimed > MAX_PACKAGE_BYTES
        {
            return Err(AppError::PayloadTooLarge {
                len: claimed,
                limit: MAX_PACKAGE_BYTES,
            });
        }
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            AppError::Unavailable(format!("downloading {shown} was interrupted: {error}"))
        })? {
            sink.write(&chunk).await?;
        }
        Ok(())
    }
    .await;

    match outcome {
        Ok(()) => sink.finish("the downloaded package is empty").await,
        Err(error) => {
            sink.abandon().await;
            Err(error)
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoteLookup {
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LookupResult {
    pub status: u16,
    pub body: serde_json::Value,
}

pub async fn lookup(config: &Config, request: RemoteLookup) -> AppResult<LookupResult> {
    let url = parse_package_url(&request.url)?;
    let headers = request_headers(&request.headers)?;
    let shown = recorded_url(&url);
    let mut response = fetch(config, url, headers).await?;
    let status = response.status().as_u16();

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        AppError::Unavailable(format!("reading {shown} was interrupted: {error}"))
    })? {
        if bytes.len() + chunk.len() > MAX_LOOKUP_BYTES {
            return Err(AppError::PayloadTooLarge {
                len: (bytes.len() + chunk.len()) as u64,
                limit: MAX_LOOKUP_BYTES as u64,
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    Ok(LookupResult { status, body })
}

fn refused(error: abi::HostError) -> AppError {
    match error.code {
        abi::ErrorCode::Blocked => AppError::BadRequest(error.message),
        _ => AppError::Unavailable(error.message),
    }
}

pub fn refusal_message(shown: &str, status: reqwest::StatusCode) -> String {
    let hint = match status.as_u16() {
        401 | 403 => " — the token is missing, wrong, or cannot read this package",
        404 => " — check the address, and that the token can see it",
        _ => "",
    };
    format!("{shown} answered {status}{hint}")
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
        for good in ["upload", "gitlab", "gitlab-packages:generic", "a.b_c"] {
            assert!(validate_source_id(good).is_ok(), "{good}");
        }
        for bad in ["", "has space", "slash/y", &"x".repeat(MAX_SOURCE_ID_CHARS + 1)] {
            assert!(validate_source_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_http_urls_without_credentials_are_accepted() {
        assert!(parse_package_url("https://gitlab.example.com/api/v4/x.zip").is_ok());
        assert!(parse_package_url("http://10.0.0.1:8080/x.zip").is_ok());
        assert!(parse_package_url("file:///etc/passwd").is_err());
        assert!(parse_package_url("ftp://example.com/x.zip").is_err());
        assert!(parse_package_url("https://user:secret@example.com/x.zip").is_err());
        assert!(parse_package_url("not a url").is_err());
    }

    #[test]
    fn the_recorded_url_drops_the_query_and_fragment() {
        let url = reqwest::Url::parse("https://cdn.example.com/p.zip?X-Amz-Signature=abc#top")
            .expect("a url");
        assert_eq!(recorded_url(&url), "https://cdn.example.com/p.zip");
    }

    #[test]
    fn connection_headers_are_refused_and_tokens_are_marked_sensitive() {
        let mut headers = BTreeMap::new();
        headers.insert("PRIVATE-TOKEN".to_string(), "glpat-abc".to_string());
        let map = request_headers(&headers).expect("a token header is fine");
        let value = map.get("private-token").expect("lowercased");
        assert!(value.is_sensitive());

        let mut headers = BTreeMap::new();
        headers.insert("Host".to_string(), "elsewhere".to_string());
        assert!(request_headers(&headers).is_err());

        let mut headers = BTreeMap::new();
        headers.insert("x-token".to_string(), "line\nbreak".to_string());
        assert!(request_headers(&headers).is_err());
    }

    #[test]
    fn a_refusal_says_what_to_check() {
        let message = refusal_message("https://g/x.zip", reqwest::StatusCode::UNAUTHORIZED);
        assert!(message.contains("401"));
        assert!(message.contains("token"));
        let message = refusal_message("https://g/x.zip", reqwest::StatusCode::NOT_FOUND);
        assert!(message.contains("404"));
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
