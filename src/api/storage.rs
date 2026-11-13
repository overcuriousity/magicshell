//! What the setup and history routes share.

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use sqlx::SqlitePool;

use super::ApiState;
use crate::error::AppError;
use crate::kit::OcError;

const MAX_ID: usize = 64;

/// The storage routes exist only with a database; this is the pool they use.
pub fn pool_of(st: &ApiState) -> Result<&SqlitePool, OcError> {
    st.pool.as_ref().ok_or(OcError::NotFound)
}

/// Ids are made by the browser (UUIDs): 1 to 64 of letters, digits and `-`.
pub fn check_id(id: &str) -> Result<(), AppError> {
    let ok = (1..=MAX_ID).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok { Ok(()) } else { Err(AppError::Invalid("This id is not valid.".into())) }
}

pub fn read_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, AppError> {
    body.map(|Json(v)| v).map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::TooLarge
        } else {
            AppError::Invalid("The server could not read this request. Reload the page and try again.".into())
        }
    })
}
