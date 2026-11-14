pub mod auth;
mod config;
mod history;
mod oidc;
mod run;
mod setups;
mod storage;

use std::sync::Arc;

use axum::Router;
use axum::middleware::map_response;
use axum::routing::{get, post, put};
use sqlx::SqlitePool;

use crate::kit::oidc::Oidc;
use crate::kit::security::rate_limit;
use crate::limit::Limiter;
use crate::upstream::Upstream;

pub struct ApiState {
    pub upstream: Upstream,
    pub limiter: Limiter,
    pub model: String,
    /// The accounts database; `None` is open mode.
    pub pool: Option<SqlitePool>,
    /// "Why?": accounts mode only, and only while its word limit is above 0.
    pub why: Option<Why>,
    /// Sign-in through `[auth.oidc]`: accounts mode only; password sign-in stays routed beside it.
    pub oidc: Option<Arc<Oidc>>,
}

pub struct Why {
    pub limiter: Limiter,
    pub max_words: u32,
}

pub fn router(state: Arc<ApiState>) -> Router {
    let mut router = Router::new().route("/api/config", get(config::get)).route("/api/run", post(run::post));
    if state.pool.is_some() {
        router = router
            .route("/api/auth/sign-in", post(auth::sign_in).layer(rate_limit(10, 5)))
            .route("/api/auth/password", post(auth::change_password).layer(rate_limit(10, 5)));
        if state.oidc.is_some() {
            router = router
                .route(
                    "/auth/oidc/start",
                    get(oidc::start).layer(rate_limit(10, 5)).layer(map_response(oidc::no_store)),
                )
                .route(
                    "/auth/oidc/callback",
                    get(oidc::callback).layer(rate_limit(10, 5)).layer(map_response(oidc::no_store)),
                );
        }
        router = router
            .route("/api/auth/sign-out", post(auth::sign_out))
            .route("/api/setups", get(setups::list))
            .route("/api/setups/{id}", put(setups::put).delete(setups::delete))
            .route("/api/history", get(history::list).delete(history::clear))
            .route("/api/history/{id}", put(history::put).delete(history::delete));
        if state.why.is_some() {
            router = router.route("/api/why", post(run::post_why));
        }
    }
    router.with_state(state)
}
