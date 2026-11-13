use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{Next, from_fn};
use axum::response::Response;
use axum::routing::get;
use sqlx::SqlitePool;

use crate::api::{self, ApiState};
use crate::assets;
use crate::config::AppConfig;
use crate::error::AppError;
use crate::kit::config::OcConfig;
use crate::kit::security::{Limits, secure};
use crate::kit::{db, session};
use crate::limit::Limiter;
use crate::upstream::Upstream;

/// Opens the accounts database and applies the migrations; `None` when `[app] database` is not set.
pub async fn open_pool(cfg: &OcConfig, app: &AppConfig) -> Result<Option<SqlitePool>, AppError> {
    let Some(file) = &app.database else {
        return Ok(None);
    };
    let pool = db::connect(&cfg.data_dir("magicshell"), file).await?;
    sqlx::migrate!("./migrations").run(&pool).await.map_err(crate::kit::OcError::internal)?;
    Ok(Some(pool))
}

/// Accounts mode when `pool` is given; the session layer exists only then.
pub async fn build(cfg: &OcConfig, app: AppConfig, pool: Option<SqlitePool>) -> Result<Router, AppError> {
    let dep = cfg.deployment()?;
    let timeout = Duration::from_secs(app.upstream_timeout_secs);
    let sessions = match &pool {
        Some(pool) => Some(session::session_layer(pool, "magicshell").await?),
        None => None,
    };
    let state = Arc::new(ApiState {
        upstream: Upstream::new(app.endpoint, app.api_key, app.model.clone(), timeout)?,
        limiter: Limiter::new(app.runs_per_minute),
        model: app.model,
        pool,
    });
    let mut api = api::router(state);
    if let Some(sessions) = sessions {
        api = api.layer(sessions);
    }
    let router = Router::new().route("/healthz", get(|| async { "ok" })).merge(api).fallback(assets::serve);
    let limits = Limits { body_bytes: 64 * 1024, timeout: timeout + Duration::from_secs(15) };
    Ok(secure(router, &dep, &cfg.trusted_proxies, limits).layer(from_fn(too_large_sentence)))
}

/// The body limit answers 413 with no text; the page shows one sentence instead.
async fn too_large_sentence(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if res.status() == StatusCode::PAYLOAD_TOO_LARGE {
        *res.body_mut() = Body::from(AppError::TooLarge.to_string());
        res.headers_mut().remove(header::CONTENT_LENGTH);
        res.headers_mut().remove(header::CONTENT_ENCODING);
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    }
    res
}
