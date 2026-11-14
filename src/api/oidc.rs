//! `GET /auth/oidc/start` and `GET /auth/oidc/callback`. Neither renders text: both redirect,
//! into the app or to the sign-in route with one of the codes of [`SignInError`].

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use time::OffsetDateTime;
use tower_sessions::Session;

use super::{ApiState, auth};
use crate::kit::OcError;
use crate::kit::identity::users;
use crate::kit::oidc::{Oidc, Pending, SignInError};
use crate::kit::session::PENDING_KEY;

const MAX_NEXT: usize = 512;

/// `next` when it is a fragment of at most 512 bytes with no space, control byte or backslash; else `""`.
/// The final redirect is `/` followed by it, so it cannot leave the origin.
pub fn safe_next(next: &str) -> &str {
    let ok =
        next.starts_with('#') && next.len() <= MAX_NEXT && !next.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\');
    if ok { next } else { "" }
}

/// Every answer of both routes, including the rate limit's.
pub async fn no_store(mut res: Response) -> Response {
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn see_other(location: &str) -> Response {
    match HeaderValue::from_str(location) {
        Ok(v) => (StatusCode::SEE_OTHER, [(header::LOCATION, v)]).into_response(),
        Err(_) => failure(SignInError::Failed),
    }
}

fn failure(e: SignInError) -> Response {
    (StatusCode::SEE_OTHER, [(header::LOCATION, format!("/#/sign-in/{}", e.code()))]).into_response()
}

/// A storage fault is not the provider's, but the page still gets only a code.
fn internal(e: &OcError) -> SignInError {
    tracing::error!(error = %e, "OIDC sign-in failed inside the app");
    SignInError::Failed
}

fn oidc(st: &ApiState) -> Result<&Oidc, SignInError> {
    st.oidc.as_deref().ok_or(SignInError::Failed)
}

fn param(q: &Result<Query<HashMap<String, String>>, QueryRejection>, key: &str) -> Option<String> {
    q.as_ref().ok().and_then(|Query(m)| m.get(key).cloned())
}

pub async fn start(
    State(st): State<Arc<ApiState>>,
    session: Session,
    q: Result<Query<HashMap<String, String>>, QueryRejection>,
) -> Response {
    let next = param(&q, "next").unwrap_or_default();
    match begin(&st, &session, safe_next(&next)).await {
        Ok(url) => see_other(&url),
        Err(e) => failure(e),
    }
}

async fn begin(st: &ApiState, session: &Session, next: &str) -> Result<String, SignInError> {
    let (url, mut pending) = oidc(st)?.authorize().await?;
    pending.next = next.to_owned();
    session.insert(PENDING_KEY, pending).await.map_err(|e| internal(&OcError::internal(e)))?;
    Ok(url)
}

pub async fn callback(
    State(st): State<Arc<ApiState>>,
    session: Session,
    q: Result<Query<HashMap<String, String>>, QueryRejection>,
) -> Response {
    match finish(&st, &session, &q).await {
        Ok(next) => see_other(&format!("/{next}")),
        Err(e) => failure(e),
    }
}

/// Returns the `next` of the sign-in on success.
async fn finish(
    st: &ApiState,
    session: &Session,
    q: &Result<Query<HashMap<String, String>>, QueryRejection>,
) -> Result<String, SignInError> {
    let o = oidc(st)?;
    let pool = st.pool.as_ref().ok_or(SignInError::Failed)?;
    // Single use: removed before anything can fail.
    let pending = session.remove::<Pending>(PENDING_KEY).await.map_err(|e| internal(&OcError::internal(e)))?;
    let Some(pending) = pending else {
        tracing::warn!("OIDC callback without a pending sign-in");
        return Err(SignInError::Failed);
    };
    let (Some(code), Some(state)) = (param(q, "code"), param(q, "state")) else {
        tracing::warn!(error = ?param(q, "error"), "OIDC callback without a code or state");
        return Err(SignInError::Failed);
    };
    if state != pending.state {
        tracing::warn!("OIDC callback state does not match");
        return Err(SignInError::Failed);
    }
    let id = o.finish(&pending, &code).await?;
    let user = users::find_or_provision_oidc(
        pool,
        &id.issuer,
        &id.subject,
        &id.name,
        o.auto_provision(),
        OffsetDateTime::now_utc(),
    )
    .await
    .map_err(|e| internal(&e))?;
    let Some(user) = user else {
        tracing::warn!("OIDC sign-in of an unknown identity while auto_provision is off");
        return Err(SignInError::NoAccount);
    };
    let epoch = users::session_epoch(pool, user.id).await.map_err(|e| internal(&e))?.ok_or(SignInError::Failed)?;
    auth::start(session, user.id, epoch).await.map_err(|e| internal(&e))?;
    Ok(pending.next)
}
