use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequestParts, State};
use axum::http::StatusCode;
use axum::http::request::Parts;

use super::ApiState;
use super::auth::SignedIn;
use crate::error::AppError;
use crate::kit::OcError;
use crate::kit::security::{ClientIp, client_key};
use crate::limit::Limiter;
use crate::preheat::warm_up_run;
use crate::systemone::{Run, word_count};
use crate::upstream::Reply;

/// Who the rate limit counts: the signed-in user in accounts mode, the client address in open mode.
pub struct Caller(String);

impl FromRequestParts<Arc<ApiState>> for Caller {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &Arc<ApiState>) -> Result<Self, Self::Rejection> {
        if st.pool.is_some() {
            let SignedIn(user) = SignedIn::from_request_parts(parts, st).await?;
            return Ok(Self(format!("user:{}", user.id)));
        }
        let ClientIp(ip) = ClientIp::from_request_parts(parts, st).await?;
        Ok(Self(ip_caller(ip)))
    }
}

/// An open-mode caller: the client address, an IPv6 client by its /64.
fn ip_caller(ip: IpAddr) -> String {
    format!("ip:{}", client_key(ip))
}

pub async fn post(
    State(st): State<Arc<ApiState>>,
    Caller(caller): Caller,
    body: Result<Json<Run>, JsonRejection>,
) -> Result<Json<Reply>, AppError> {
    let run = read_run(&st.limiter, &caller, body)?;
    touch(&st);
    Ok(Json(st.upstream.run(&run).await?))
}

/// "Why?": the same run, asked again with a word left out; accounts only, with its own allowance
/// and a limit on the words of the situation.
pub async fn post_why(
    State(st): State<Arc<ApiState>>,
    SignedIn(user): SignedIn,
    body: Result<Json<Run>, JsonRejection>,
) -> Result<Json<Reply>, AppError> {
    let Some(why) = &st.why else {
        return Err(OcError::NotFound.into());
    };
    let run = read_run(&why.limiter, &format!("user:{}", user.id), body)?;
    let words = word_count(&run.state);
    if words > why.max_words as usize {
        return Err(AppError::Invalid(format!(
            "Why? works up to {} words; this situation has {words}.",
            why.max_words
        )));
    }
    touch(&st);
    Ok(Json(st.upstream.run(&run).await?))
}

/// A run that reached validation keeps the model warm, so it starts the preheat cooldown.
fn touch(st: &ApiState) {
    if let Some(preheat) = &st.preheat {
        preheat.touch(Instant::now());
    }
}

/// Answers at once; at most once a minute for the whole server it sends one minimal request in the
/// background. It never takes from the run allowance, and the model's reply does not matter.
pub async fn preheat(State(st): State<Arc<ApiState>>, _caller: Caller) -> StatusCode {
    if st.preheat.as_ref().is_some_and(|p| p.take(Instant::now())) {
        let upstream = st.upstream.clone();
        tokio::spawn(async move {
            if let Err(e) = upstream.run(&warm_up_run()).await {
                tracing::debug!(error = %e, "preheat request failed");
            }
        });
    }
    StatusCode::NO_CONTENT
}

/// Takes from `limiter`, then reads and validates the body.
fn read_run(limiter: &Limiter, caller: &str, body: Result<Json<Run>, JsonRejection>) -> Result<Run, AppError> {
    if !limiter.take(caller) {
        return Err(AppError::RateLimited);
    }
    let Json(run) = body.map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::TooLarge
        } else {
            AppError::Invalid("The server could not read this request. Reload the page and try again.".into())
        }
    })?;
    run.validate()?;
    Ok(run)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn ipv6_callers_in_one_64_are_one_caller() {
        let a = ip_caller("2001:db8:1:2::1".parse().unwrap());
        assert_eq!(a, ip_caller("2001:db8:1:2:dead:beef:0:7".parse().unwrap()));
        assert_ne!(a, ip_caller("2001:db8:1:3::1".parse().unwrap()));
        assert_ne!(ip_caller("192.0.2.1".parse().unwrap()), ip_caller("192.0.2.2".parse().unwrap()));
    }
}
