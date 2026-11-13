use std::net::IpAddr;
use std::sync::Arc;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequestParts, State};
use axum::http::StatusCode;
use axum::http::request::Parts;

use super::ApiState;
use super::auth::SignedIn;
use crate::error::AppError;
use crate::kit::security::{ClientIp, client_key};
use crate::systemone::Run;
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
    if !st.limiter.take(&caller) {
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
    Ok(Json(st.upstream.run(&run).await?))
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
