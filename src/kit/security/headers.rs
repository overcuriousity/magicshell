use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

use super::Ctx;

pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

pub(super) async fn security_headers(State(ctx): State<Arc<Ctx>>, req: Request, next: Next) -> Response {
    let authenticated = req.headers().contains_key(header::COOKIE) || req.headers().contains_key(header::AUTHORIZATION);
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    let is_html = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("text/html"));
    if is_html {
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    if ctx.dep.secure {
        h.insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=63072000"));
    }
    if authenticated && !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}
