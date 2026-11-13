use axum::Router;
use axum::routing::get;
use sqlx::SqlitePool;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::kit::config::OcConfig;
use crate::kit::security::{Limits, secure};

pub fn build(cfg: &OcConfig, _app: AppConfig, _pool: Option<SqlitePool>) -> Result<Router, AppError> {
    let dep = cfg.deployment()?;
    let router = Router::new().route("/healthz", get(|| async { "ok" }));
    Ok(secure(router, &dep, &cfg.trusted_proxies, Limits::default()))
}
