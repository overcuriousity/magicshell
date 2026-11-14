//! `GET /auth/oidc/start` and `GET /auth/oidc/callback`. Neither renders text, not even when
//! limited: both redirect, into the app or to the sign-in route, with one of the codes of
//! [`SignInError`] or, after a silent check, without one.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use time::OffsetDateTime;
use tower_sessions::Session;

use super::{ApiState, auth};
use crate::kit::OcError;
use crate::kit::identity::users;
use crate::kit::oidc::{Oidc, Pending, SignInError};
use crate::kit::security::{ClientIp, client_key};
use crate::kit::session::{PENDING_KEY, USER_KEY};
use crate::limit::Limiter;

const MAX_NEXT: usize = 512;

/// `next` when it is a fragment of at most 512 bytes of printable ASCII without a backslash; else `""`.
/// Browsers percent-encode everything else in a fragment, and a `Location` header takes nothing else.
/// The final redirect is `/` followed by it, so it cannot leave the origin.
pub fn safe_next(next: &str) -> &str {
    let ok =
        next.starts_with('#') && next.len() <= MAX_NEXT && !next.bytes().any(|b| b <= 0x20 || b >= 0x7f || b == b'\\');
    if ok { next } else { "" }
}

/// Every answer of both routes, the limited ones included.
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

type Params = Result<Query<HashMap<String, String>>, QueryRejection>;

fn param(q: &Params, key: &str) -> Option<String> {
    q.as_ref().ok().and_then(|Query(m)| m.get(key).cloned())
}

/// Only the exact value `1` is silent.
fn is_silent(q: &Params) -> bool {
    param(q, "silent").as_deref() == Some("1")
}

/// The allowances of a sign-in route, one for the silent check and one for the button. The page
/// goes to a silent start by itself, so a person who used up the button's allowance still gets the
/// check, and the reverse. Anyone can ask for a silent start, so its allowance is only twice the
/// button's: a limited silent check costs the person nothing but the trip, they see the form.
#[derive(Clone)]
pub struct SignInLimits {
    silent: Limiter,
    interactive: Limiter,
}

impl SignInLimits {
    pub fn new() -> Self {
        Self { silent: Limiter::with_burst(20, 10), interactive: Limiter::with_burst(10, 5) }
    }

    fn of(&self, silent: bool) -> &Limiter {
        if silent { &self.silent } else { &self.interactive }
    }
}

/// False when the client has used up `limiter`. Without a client address nothing is counted,
/// as in the kit's limiter.
fn allowed(limiter: &Limiter, req: &Request) -> bool {
    req.extensions().get::<ClientIp>().is_none_or(|ClientIp(ip)| limiter.take(&client_key(*ip).to_string()))
}

/// A limited silent start goes back to the form as a declined check would; the button says why.
pub async fn limit_start(State(l): State<SignInLimits>, req: Request, next: Next) -> Response {
    let silent = is_silent(&Query::try_from_uri(req.uri()));
    if allowed(l.of(silent), &req) {
        next.run(req).await
    } else if silent {
        see_other("/#/sign-in")
    } else {
        failure(SignInError::Limited)
    }
}

/// The callback counts against the allowance its sign-in started with, so the silent checks of
/// many tabs behind one address cannot use up the button's callbacks. A callback without a
/// pending sign-in counts as the button's.
pub async fn limit_callback(State(l): State<SignInLimits>, req: Request, next: Next) -> Response {
    let session = req.extensions().get::<Session>().cloned();
    let pending = match &session {
        Some(s) => s.get::<Pending>(PENDING_KEY).await.ok().flatten(),
        None => None,
    };
    let silent = pending.is_some_and(|p| p.silent);
    if allowed(l.of(silent), &req) {
        return next.run(req).await;
    }
    match session {
        // Single use, as in the callback itself.
        Some(s) if silent => {
            if let Err(e) = s.remove::<Pending>(PENDING_KEY).await {
                tracing::warn!(error = %e, "could not remove the pending sign-in of a limited silent check");
            }
            quiet(&s).await
        }
        _ => failure(SignInError::Limited),
    }
}

pub async fn start(State(st): State<Arc<ApiState>>, session: Session, q: Params) -> Response {
    let next = param(&q, "next").unwrap_or_default();
    let silent = is_silent(&q);
    match begin(&st, &session, safe_next(&next), silent).await {
        Ok(url) => see_other(&url),
        Err(e) => failure(e),
    }
}

async fn begin(st: &ApiState, session: &Session, next: &str, silent: bool) -> Result<String, SignInError> {
    let (url, mut pending) = oidc(st)?.authorize(silent).await?;
    pending.next = next.to_owned();
    session.insert(PENDING_KEY, pending).await.map_err(|e| internal(&OcError::internal(e)))?;
    Ok(url)
}

pub async fn callback(State(st): State<Arc<ApiState>>, session: Session, q: Params) -> Response {
    // Single use: removed before anything can fail.
    let pending = match session.remove::<Pending>(PENDING_KEY).await {
        Ok(p) => p,
        Err(e) => return failure(internal(&OcError::internal(e))),
    };
    let silent = pending.as_ref().is_some_and(|p| p.silent);
    match finish(&st, &session, &q, pending).await {
        Ok(Finished::SignedIn(next)) => see_other(&format!("/{next}")),
        Ok(Finished::Declined) => quiet(&session).await,
        // A silent check shows a code only where it tells the person something (`unreachable`,
        // `no-account`); `finish` has logged the failure.
        Err(SignInError::Failed) if silent => quiet(&session).await,
        Err(e) => failure(e),
    }
}

/// Back to the form without a code. A visitor who never signs in leaves no session behind.
async fn quiet(session: &Session) -> Response {
    let signed_in = session.get::<i64>(USER_KEY).await.ok().flatten().is_some();
    if !signed_in && let Err(e) = session.flush().await {
        tracing::warn!(error = %e, "could not remove the session of a silent OIDC check");
    }
    see_other("/#/sign-in")
}

enum Finished {
    /// The `next` of the sign-in.
    SignedIn(String),
    /// A silent check that the provider could not answer without a page: back to the form, no failure.
    Declined,
}

/// The errors a provider answers `prompt=none` with when the person has to act first.
const QUIET_ERRORS: [&str; 4] =
    ["login_required", "interaction_required", "consent_required", "account_selection_required"];

/// Returns what the callback leads to.
async fn finish(
    st: &ApiState,
    session: &Session,
    q: &Params,
    pending: Option<Pending>,
) -> Result<Finished, SignInError> {
    let o = oidc(st)?;
    let pool = st.pool.as_ref().ok_or(SignInError::Failed)?;
    let Some(pending) = pending else {
        tracing::warn!("OIDC callback without a pending sign-in");
        return Err(SignInError::Failed);
    };
    let quiet = pending.silent
        && param(q, "error").is_some_and(|e| QUIET_ERRORS.contains(&e.as_str()))
        && param(q, "state").is_some_and(|s| s == pending.state);
    if quiet {
        tracing::debug!("silent OIDC check declined by the provider");
        return Ok(Finished::Declined);
    }
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
    Ok(Finished::SignedIn(pending.next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_is_a_short_fragment_of_printable_ascii() {
        assert_eq!(safe_next("#/history"), "#/history");
        assert_eq!(safe_next("#/setups/a%20b"), "#/setups/a%20b");
        let longest = format!("#{}", "a".repeat(511));
        assert_eq!(safe_next(&longest), longest);
        let too_long = format!("#{}", "a".repeat(512));
        for bad in [
            "",
            "/x",
            "//evil.example",
            "https://evil.example",
            "#a b",
            "#a\tb",
            "#a\r\nb",
            "#a\u{7f}",
            "#a\\b",
            "#\u{e4}",
            &too_long,
        ] {
            assert_eq!(safe_next(bad), "", "{bad:?}");
        }
    }
}
