pub mod auth;
mod config;
mod history;
mod oidc;
mod run;
mod setups;
mod storage;

use std::sync::Arc;

use axum::Router;
use axum::middleware::{from_fn_with_state, map_response};
use axum::routing::{get, post, put};
use sqlx::SqlitePool;
use tower_http::limit::RequestBodyLimitLayer;

use crate::kit::oidc::Oidc;
use crate::kit::security::rate_limit;
use crate::limit::Limiter;
use crate::preheat::Preheat;
use crate::upstream::Upstream;

/// The body `POST /api/run` takes: 600 KB of pictures as base64 and the rest of the run, under the
/// 1 MB of the shipped nginx template.
pub const RUN_BODY_BYTES: usize = 960 * 1024;
/// The body every other route takes.
const BODY_BYTES: usize = 64 * 1024;

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
    /// The cooldown of `POST /api/preheat`; `None` when `[app] preheat` is off or in open mode.
    pub preheat: Option<Preheat>,
    /// Pictures a run may carry on this server; 0 is off.
    pub max_pictures: usize,
    /// The edge the page shrinks pictures to.
    pub picture_max_edge: u32,
}

pub struct Why {
    pub limiter: Limiter,
    pub max_words: u32,
}

pub fn router(state: Arc<ApiState>) -> Router {
    let mut router = Router::new().route("/api/config", get(config::get));
    if state.preheat.is_some() {
        router = router.route("/api/preheat", post(run::preheat));
    }
    if state.pool.is_some() {
        router = router
            .route("/api/auth/sign-in", post(auth::sign_in).layer(rate_limit(10, 5)))
            .route("/api/auth/password", post(auth::change_password).layer(rate_limit(10, 5)));
        if state.oidc.is_some() {
            router = router
                .route(
                    "/auth/oidc/start",
                    get(oidc::start)
                        .layer(from_fn_with_state(oidc::SignInLimits::new(), oidc::limit_start))
                        .layer(map_response(oidc::no_store)),
                )
                .route(
                    "/auth/oidc/callback",
                    get(oidc::callback)
                        .layer(from_fn_with_state(oidc::SignInLimits::new(), oidc::limit_callback))
                        .layer(map_response(oidc::no_store)),
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
    // Only a run carries pictures; everything else keeps the small limit.
    router.layer(RequestBodyLimitLayer::new(BODY_BYTES)).route("/api/run", post(run::post)).with_state(state)
}
