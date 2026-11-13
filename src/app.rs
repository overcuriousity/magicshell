use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::routing::get;
use sqlx::SqlitePool;

use crate::api::{self, ApiState};
use crate::assets;
use crate::config::AppConfig;
use crate::error::AppError;
use crate::kit::config::OcConfig;
use crate::kit::security::{Limits, secure};
use crate::limit::Limiter;
use crate::upstream::Upstream;

pub fn build(cfg: &OcConfig, app: AppConfig, _pool: Option<SqlitePool>) -> Result<Router, AppError> {
    let dep = cfg.deployment()?;
    let timeout = Duration::from_secs(app.upstream_timeout_secs);
    let state = Arc::new(ApiState {
        upstream: Upstream::new(app.endpoint, app.api_key, app.model.clone(), timeout)?,
        limiter: Limiter::new(app.runs_per_minute),
        model: app.model,
    });
    let router =
        Router::new().route("/healthz", get(|| async { "ok" })).merge(api::router(state)).fallback(assets::serve);
    let limits = Limits { body_bytes: 64 * 1024, timeout: timeout + Duration::from_secs(15) };
    Ok(secure(router, &dep, &cfg.trusted_proxies, limits))
}
