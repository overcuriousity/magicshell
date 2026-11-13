use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::kit::OcError;

/// Every message is one sentence a user can act on.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Kit(#[from] OcError),
    /// A request the server refuses with the sentence to show (422).
    #[error("{0}")]
    Invalid(String),
    /// The model endpoint answered in a way this app cannot read (502).
    #[error("{0}")]
    Upstream(String),
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::Kit(e) => e.status(),
            Self::Invalid(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::Kit(e) => e.into_response(),
            other => (other.status(), other.to_string()).into_response(),
        }
    }
}
