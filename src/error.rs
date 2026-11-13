use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::kit::OcError;

/// Every message is one sentence a user can act on.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Kit(#[from] OcError),
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::Kit(e) => e.status(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::Kit(e) => e.into_response(),
        }
    }
}
