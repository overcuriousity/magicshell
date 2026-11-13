pub mod auth;
mod config;
mod run;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};
use sqlx::SqlitePool;

use crate::kit::security::rate_limit;
use crate::limit::Limiter;
use crate::upstream::Upstream;

pub struct ApiState {
    pub upstream: Upstream,
    pub limiter: Limiter,
    pub model: String,
    /// The accounts database; `None` is open mode.
    pub pool: Option<SqlitePool>,
}

pub fn router(state: Arc<ApiState>) -> Router {
    let mut router = Router::new().route("/api/config", get(config::get)).route("/api/run", post(run::post));
    if state.pool.is_some() {
        router = router
            .route("/api/auth/sign-in", post(auth::sign_in).layer(rate_limit(10, 5)))
            .route("/api/auth/sign-out", post(auth::sign_out))
            .route("/api/auth/password", post(auth::change_password).layer(rate_limit(10, 5)));
    }
    router.with_state(state)
}
