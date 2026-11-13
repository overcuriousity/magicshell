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
    /// The model endpoint did not answer in time (504).
    #[error("The model took too long to answer. Try again.")]
    UpstreamTimeout,
    /// A sign-in that matched no user and password (401).
    #[error("Wrong username or password.")]
    WrongLogin,
    /// A body over the size limit (413).
    #[error("This request is too large. Shorten it and try again.")]
    TooLarge,
    /// One client asked too often (429).
    #[error("Too many questions. Wait a minute and try again.")]
    RateLimited,
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::Kit(e) => e.status(),
            Self::Invalid(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
            Self::UpstreamTimeout => StatusCode::GATEWAY_TIMEOUT,
            Self::WrongLogin => StatusCode::UNAUTHORIZED,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
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
