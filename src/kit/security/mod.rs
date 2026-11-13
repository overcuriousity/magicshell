//! The middleware every oc app runs behind. Each piece is a small, independent function.

mod client_ip;
mod headers;
mod origin;
mod rate;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::http::header;
use axum::middleware::from_fn_with_state;
use ipnet::IpNet;
use tower_http::compression::CompressionLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::sensitive_headers::SetSensitiveRequestHeadersLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::kit::config::Deployment;

pub use client_ip::ClientIp;
pub use headers::CSP;
pub use rate::{client_key, rate_limit};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub body_bytes: usize,
    pub timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self { body_bytes: 1024 * 1024, timeout: Duration::from_secs(30) }
    }
}

pub(crate) struct Ctx {
    pub dep: Deployment,
    pub proxies: Vec<IpNet>,
}

/// Wraps a router in the full security stack. Apply it last, around everything the app serves.
/// The timeout bounds producing response headers, so long-lived SSE bodies are not cut off.
pub fn secure(router: Router, dep: &Deployment, proxies: &[IpNet], limits: Limits) -> Router {
    let ctx = Arc::new(Ctx { dep: dep.clone(), proxies: proxies.to_vec() });
    router
        .layer(CompressionLayer::new())
        .layer(RequestBodyLimitLayer::new(limits.body_bytes))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .layer(from_fn_with_state(ctx.clone(), origin::origin_check))
        .layer(from_fn_with_state(ctx.clone(), origin::host_check))
        .layer(TimeoutLayer::with_status_code(axum::http::StatusCode::REQUEST_TIMEOUT, limits.timeout))
        .layer(from_fn_with_state(ctx, headers::security_headers))
        .layer(TraceLayer::new_for_http())
        .layer(SetSensitiveRequestHeadersLayer::new([header::AUTHORIZATION, header::COOKIE]))
}
