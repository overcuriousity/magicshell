use std::sync::Arc;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequestParts, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use serde::Deserialize;
use tower_sessions::Session;

use super::ApiState;
use crate::error::AppError;
use crate::kit::OcError;
use crate::kit::identity::{User, users};
use crate::kit::session::USER_KEY;

pub const SHORT_PASSWORD: &str = "Use at least 12 characters.";
const MIN_PASSWORD_CHARS: usize = 12;

/// The rule for every new password, from the page or the shell.
pub fn check_new_password(secret: &str) -> Result<(), AppError> {
    if secret.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AppError::Invalid(SHORT_PASSWORD.into()));
    }
    Ok(())
}

const UNREADABLE: &str = "The server could not read this request. Reload the page and try again.";

/// The signed-in user of this request, if any. Only accounts mode has sessions.
pub async fn current(st: &ApiState, parts: &mut Parts) -> Result<Option<User>, OcError> {
    let Some(pool) = &st.pool else {
        return Ok(None);
    };
    let session = Session::from_request_parts(parts, &()).await.map_err(|(_, why)| OcError::internal(why))?;
    let Some(id) = session.get::<i64>(USER_KEY).await.map_err(OcError::internal)? else {
        return Ok(None);
    };
    users::by_id(pool, id).await
}

/// A request that needs a signed-in user; anyone else gets 401 "Sign in first.".
pub struct SignedIn(pub User);

impl FromRequestParts<Arc<ApiState>> for SignedIn {
    type Rejection = OcError;

    async fn from_request_parts(parts: &mut Parts, st: &Arc<ApiState>) -> Result<Self, Self::Rejection> {
        current(st, parts).await?.map(SignedIn).ok_or(OcError::Unauthenticated)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignIn {
    username: String,
    password: String,
}

fn read<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, AppError> {
    body.map(|Json(v)| v).map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::TooLarge
        } else {
            AppError::Invalid(UNREADABLE.into())
        }
    })
}

pub async fn sign_in(
    State(st): State<Arc<ApiState>>,
    session: Session,
    body: Result<Json<SignIn>, JsonRejection>,
) -> Result<StatusCode, AppError> {
    let form = read(body)?;
    let pool = st.pool.as_ref().ok_or(OcError::NotFound)?;
    let Some(user) = users::verify_password(pool, form.username.trim(), &form.password).await? else {
        return Err(AppError::WrongLogin);
    };
    session.cycle_id().await.map_err(OcError::internal)?;
    session.insert(USER_KEY, user.id).await.map_err(OcError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn sign_out(session: Session) -> Result<StatusCode, AppError> {
    session.flush().await.map_err(OcError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangePassword {
    current: String,
    new: String,
}

pub async fn change_password(
    State(st): State<Arc<ApiState>>,
    SignedIn(user): SignedIn,
    body: Result<Json<ChangePassword>, JsonRejection>,
) -> Result<StatusCode, AppError> {
    let form = read(body)?;
    let pool = st.pool.as_ref().ok_or(OcError::NotFound)?;
    if users::verify_password(pool, &user.username, &form.current).await?.is_none() {
        return Err(AppError::Invalid("The current password is wrong.".into()));
    }
    check_new_password(&form.new)?;
    users::set_password(pool, user.id, &form.new).await?;
    Ok(StatusCode::NO_CONTENT)
}
