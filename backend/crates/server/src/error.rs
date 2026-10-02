use axum::Json;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use ddd_core::CoreError;
use serde::Serialize;
use serde_json::json;
use thiserror::Error;

use crate::docstore::DocStoreError;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("authentication required")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Gone(String),
    #[error("revision mismatch: expected {expected}, got {provided}")]
    PreconditionFailed { expected: u32, provided: u32 },
    #[error("If-Match header required")]
    PreconditionRequired,
    #[error("payload too large: {len} bytes (limit {limit})")]
    PayloadTooLarge { len: u64, limit: u64 },
    #[error("unsupported media type: {0}")]
    UnsupportedMediaType(String),
    #[error("{0}")]
    Unprocessable(String),
    #[error("too many requests")]
    TooManyRequests { retry_after_secs: u64 },
    #[error("service unavailable: {0}")]
    Unavailable(String),

    #[error(transparent)]
    Core(#[from] CoreError),
    #[error(transparent)]
    DocStore(#[from] DocStoreError),
    #[error("database error: {0}")]
    Db(#[from] mongodb::error::Error),
    #[error("bson error: {0}")]
    Bson(#[from] bson::ser::Error),
    #[error("bson decode error: {0}")]
    BsonDe(#[from] bson::de::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Gone,
    PreconditionFailed,
    PreconditionRequired,
    PayloadTooLarge,
    UnsupportedMediaType,
    Unprocessable,
    TooManyRequests,
    Unavailable,
    Internal,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: ErrorPayload,
}

#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Gone(_) => StatusCode::GONE,
            AppError::PreconditionFailed { .. } => StatusCode::PRECONDITION_FAILED,
            AppError::PreconditionRequired => StatusCode::PRECONDITION_REQUIRED,
            AppError::PayloadTooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            AppError::UnsupportedMediaType(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            AppError::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            AppError::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
            AppError::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,

            AppError::Core(err) => match err {
                CoreError::DocumentTooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
                CoreError::FilterParse(_)
                | CoreError::FilterEval(_)
                | CoreError::FilterCompile(_)
                | CoreError::Date(_) => StatusCode::BAD_REQUEST,
                CoreError::SpliceTargetMissing(_) => StatusCode::UNPROCESSABLE_ENTITY,
            },

            AppError::DocStore(err) => match err {
                DocStoreError::NotFound(_) | DocStoreError::SnapshotNotFound(_) => {
                    StatusCode::NOT_FOUND
                }
                DocStoreError::AlreadyExists(_) => StatusCode::CONFLICT,
                DocStoreError::Graveyarded(_) => StatusCode::GONE,
                DocStoreError::TooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
                DocStoreError::InvalidId(_) | DocStoreError::MalformedUpdate(_) => {
                    StatusCode::BAD_REQUEST
                }
                DocStoreError::SpliceRefused(_) => StatusCode::UNPROCESSABLE_ENTITY,
                DocStoreError::Contended(_) => StatusCode::CONFLICT,
                DocStoreError::HistoryGap(..) => StatusCode::CONFLICT,
                DocStoreError::Db(_) | DocStoreError::Bson(_) | DocStoreError::Other(_) => {
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            },

            AppError::Db(_) | AppError::Bson(_) | AppError::BsonDe(_) | AppError::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }

    pub fn code(&self) -> ErrorCode {
        match self.status() {
            StatusCode::BAD_REQUEST => ErrorCode::BadRequest,
            StatusCode::UNAUTHORIZED => ErrorCode::Unauthorized,
            StatusCode::FORBIDDEN => ErrorCode::Forbidden,
            StatusCode::NOT_FOUND => ErrorCode::NotFound,
            StatusCode::CONFLICT => ErrorCode::Conflict,
            StatusCode::GONE => ErrorCode::Gone,
            StatusCode::PRECONDITION_FAILED => ErrorCode::PreconditionFailed,
            StatusCode::PRECONDITION_REQUIRED => ErrorCode::PreconditionRequired,
            StatusCode::PAYLOAD_TOO_LARGE => ErrorCode::PayloadTooLarge,
            StatusCode::UNSUPPORTED_MEDIA_TYPE => ErrorCode::UnsupportedMediaType,
            StatusCode::UNPROCESSABLE_ENTITY => ErrorCode::Unprocessable,
            StatusCode::TOO_MANY_REQUESTS => ErrorCode::TooManyRequests,
            StatusCode::SERVICE_UNAVAILABLE => ErrorCode::Unavailable,
            _ => ErrorCode::Internal,
        }
    }

    pub fn detail(&self) -> Option<serde_json::Value> {
        match self {
            AppError::NotFound(resource) => Some(json!({ "resource": resource })),
            AppError::PreconditionFailed { expected, provided } => {
                Some(json!({ "expected": expected, "provided": provided }))
            }
            AppError::PayloadTooLarge { len, limit } => Some(json!({ "len": len, "limit": limit })),
            AppError::UnsupportedMediaType(mime) => Some(json!({ "content_type": mime })),
            AppError::TooManyRequests { retry_after_secs } => {
                Some(json!({ "retry_after_secs": retry_after_secs }))
            }

            AppError::Core(CoreError::DocumentTooLarge { len, limit }) => {
                Some(json!({ "len": len, "limit": limit }))
            }

            AppError::DocStore(err) => match err {
                DocStoreError::TooLarge { len, limit } => {
                    Some(json!({ "len": len, "limit": limit }))
                }
                DocStoreError::AlreadyExists(id) | DocStoreError::Graveyarded(id) => {
                    Some(json!({ "id": id }))
                }
                DocStoreError::NotFound(id) | DocStoreError::SnapshotNotFound(id) => {
                    Some(json!({ "id": id }))
                }
                DocStoreError::Contended(id) => Some(json!({ "id": id, "retryable": true })),
                _ => None,
            },

            _ => None,
        }
    }

    pub fn is_internal(&self) -> bool {
        self.status().is_server_error()
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        AppError::BadRequest(message.into())
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        AppError::Conflict(message.into())
    }

    pub fn unprocessable(message: impl Into<String>) -> Self {
        AppError::Unprocessable(message.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let code = self.code();
        let detail = self.detail();

        if self.is_internal() {
            tracing::error!(error = ?self, "request failed");
        } else {
            tracing::debug!(error = %self, "request rejected");
        }

        let message = if status.is_server_error() {
            "internal server error".to_string()
        } else {
            self.to_string()
        };

        let mut headers = HeaderMap::new();
        if let AppError::TooManyRequests { retry_after_secs } = &self
            && let Ok(value) = HeaderValue::from_str(&retry_after_secs.to_string())
        {
            headers.insert(header::RETRY_AFTER, value);
        }

        (
            status,
            headers,
            Json(ErrorBody {
                error: ErrorPayload {
                    code,
                    message,
                    detail,
                },
            }),
        )
            .into_response()
    }
}
