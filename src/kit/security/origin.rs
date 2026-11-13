use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::Ctx;
use super::client_ip::{ClientIp, resolve};

pub(super) async fn host_check(State(ctx): State<Arc<Ctx>>, req: Request, next: Next) -> Response {
    let (mut parts, body) = req.into_parts();
    // X-Forwarded-Host is ignored on purpose: nginx passes the client's Host through unchanged.
    let host = parts
        .headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| parts.uri.authority().map(|a| a.as_str()));
    if !host.is_some_and(|h| ctx.dep.host_allowed(h)) {
        return (StatusCode::MISDIRECTED_REQUEST, "This server does not answer for that host name.").into_response();
    }
    if let Some(ip) = resolve(&parts, &ctx.proxies) {
        parts.extensions.insert(ClientIp(ip));
    }
    next.run(Request::from_parts(parts, body)).await
}

/// Cookie-authenticated writes must come from our own origin. Non-browser clients send neither
/// `Origin` nor `Sec-Fetch-Site`; they are let through only when they carry no cookie.
pub(super) async fn origin_check(State(ctx): State<Arc<Ctx>>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    let h = req.headers();
    // `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on same-origin form posts,
    // so "null" counts as absent and Sec-Fetch-Site decides.
    let origin = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()).filter(|o| *o != "null");
    let site = h.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    let allowed = match (origin, site) {
        (Some(o), _) if !ctx.dep.origin_allowed(o) => false,
        (_, Some(s)) => matches!(s, "same-origin" | "none"),
        (Some(_), None) => true,
        // Without a cookie there is no ambient credential to forge, so the auth layer decides (401 or bearer).
        (None, None) => !h.contains_key(header::COOKIE),
    };
    if allowed {
        next.run(req).await
    } else {
        (StatusCode::FORBIDDEN, "This request came from another site and was blocked.").into_response()
    }
}
