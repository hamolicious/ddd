use ddd::abi::JsonMap;
use ddd::abi::http::{HttpRouteRequest, HttpRouteResponse, base64_decode};
use ddd::{ErrorCode, HostError};
use ddd_plugin_sdk as ddd;
use serde::Deserialize;

ddd::abi_version!();

const DOWNLOAD_PATH: &str = "/download";
const MAX_NAME_CHARS: usize = 100;

#[derive(Debug, Deserialize)]
struct DownloadRequest {
    repo: String,
    asset: u64,
    #[serde(default)]
    token: Option<String>,
}

fn refused(code: ErrorCode, message: impl Into<String>) -> HostError {
    HostError::new(code, message.into())
}

fn is_github_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_CHARS
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn repository_path(repo: &str) -> Option<&str> {
    let (owner, name) = repo.split_once('/')?;
    (is_github_name(owner) && is_github_name(name)).then_some(repo)
}

fn asset_url(repo: &str, asset: u64) -> Result<String, HostError> {
    let path = repository_path(repo).ok_or_else(|| {
        refused(
            ErrorCode::InvalidArgument,
            format!("`{repo}` is not a GitHub repository like owner/name"),
        )
    })?;
    Ok(format!(
        "https://api.github.com/repos/{path}/releases/assets/{asset}"
    ))
}

fn text(value: &str) -> serde_json::Value {
    serde_json::Value::String(value.to_string())
}

fn asset_headers(token: Option<&str>) -> JsonMap {
    let mut headers = JsonMap::new();
    headers.insert("accept".to_string(), text("application/octet-stream"));
    headers.insert("x-github-api-version".to_string(), text("2022-11-28"));
    if let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) {
        headers.insert(
            "authorization".to_string(),
            text(&format!("Bearer {token}")),
        );
    }
    headers
}

fn github_refusal(status: u16) -> HostError {
    match status {
        401 | 403 => refused(
            ErrorCode::Forbidden,
            format!(
                "GitHub answered {status}: the token is missing, wrong, or cannot read the repository"
            ),
        ),
        404 => refused(
            ErrorCode::NotFound,
            "GitHub answered 404: check the repository, and that the token can see it",
        ),
        _ => refused(ErrorCode::Internal, format!("GitHub answered {status}")),
    }
}

fn download(request: &HttpRouteRequest) -> ddd::Result<HttpRouteResponse> {
    let body = request
        .body_base64
        .as_deref()
        .map(base64_decode)
        .transpose()
        .map_err(|_| refused(ErrorCode::InvalidArgument, "the request body is not base64"))?
        .unwrap_or_default();
    let wanted: DownloadRequest = serde_json::from_slice(&body).map_err(|error| {
        refused(
            ErrorCode::InvalidArgument,
            format!("expected {{ repo, asset, token? }}: {error}"),
        )
    })?;
    let url = asset_url(&wanted.repo, wanted.asset)?;
    let response = ddd::http::get_with_headers(&url, asset_headers(wanted.token.as_deref()))?;
    if !response.is_success() {
        return Err(github_refusal(response.status()));
    }
    let mut headers = JsonMap::new();
    headers.insert("content-type".to_string(), text("application/zip"));
    Ok(HttpRouteResponse {
        status: 200,
        headers,
        body_base64: response.0.body_base64,
    })
}

ddd::http_routes!(route);
fn route(request: HttpRouteRequest) -> ddd::Result<HttpRouteResponse> {
    if request.path != DOWNLOAD_PATH {
        return Err(refused(
            ErrorCode::NotFound,
            format!("github-packages has nothing at {}", request.path),
        ));
    }
    if !request.user.as_ref().is_some_and(|user| user.is_admin) {
        return Err(refused(
            ErrorCode::Forbidden,
            "only an admin can download plugin packages",
        ));
    }
    download(&request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_owner_and_name_reach_the_asset_url() {
        assert_eq!(
            asset_url("octo-org/ddd_plugins.v2", 42).unwrap(),
            "https://api.github.com/repos/octo-org/ddd_plugins.v2/releases/assets/42"
        );
        for bad in [
            "",
            "owner",
            "owner/",
            "/name",
            "owner/name/extra",
            "owner/..",
            "owner/na me",
            "owner/name?x=1",
            "owner/name#x",
            "ow%2Fner/name",
        ] {
            assert!(asset_url(bad, 1).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn the_token_is_sent_only_when_there_is_one() {
        assert!(!asset_headers(None).contains_key("authorization"));
        assert!(!asset_headers(Some("  ")).contains_key("authorization"));
        assert_eq!(
            asset_headers(Some(" ghp_abc ")).get("authorization"),
            Some(&text("Bearer ghp_abc"))
        );
    }
}
