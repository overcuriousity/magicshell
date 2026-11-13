use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Every message is one sentence a user can act on.
#[derive(Debug, thiserror::Error)]
pub enum OcError {
    #[error("{0}")]
    Config(String),
    #[error("Sign in first.")]
    Unauthenticated,
    #[error("You do not have access to this.")]
    Forbidden,
    #[error("Not found.")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unprocessable(String),
    #[error("{0}")]
    Conflict(String),
    #[error("Something went wrong. Try again later.")]
    Internal(String),
}

impl OcError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::Config(_) | Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Unauthenticated => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Conflict(_) => StatusCode::CONFLICT,
        }
    }

    pub fn internal(e: impl std::fmt::Display) -> Self {
        Self::Internal(e.to_string())
    }
}

impl IntoResponse for OcError {
    fn into_response(self) -> Response {
        if let Self::Internal(detail) = &self {
            tracing::error!(%detail, "internal error");
        }
        (self.status(), self.to_string()).into_response()
    }
}
