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

/// The body of the routes that carry no run: sign-in, password, sign-out, preheat.
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
    /// Pictures a run may carry on this server; 0 is off, `None` is no limit.
    pub max_pictures: Option<usize>,
    /// The edge the page shrinks pictures to.
    pub picture_max_edge: u32,
    /// The body of the routes that carry a run or a setup (`[app] max_request_mb`).
    pub max_body_bytes: usize,
}

pub struct Why {
    pub limiter: Limiter,
    pub max_words: u32,
}

pub fn router(state: Arc<ApiState>) -> Router {
    // Routes that carry no run keep the small limit; the rest take `[app] max_request_mb`.
    let mut small = Router::new();
    let mut large = Router::new().route("/api/run", post(run::post));
    if state.preheat.is_some() {
        small = small.route("/api/preheat", post(run::preheat));
    }
    if state.pool.is_some() {
        small = small
            .route("/api/auth/sign-in", post(auth::sign_in).layer(rate_limit(10, 5)))
            .route("/api/auth/password", post(auth::change_password).layer(rate_limit(10, 5)));
        if state.oidc.is_some() {
            small = small
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
        small = small.route("/api/auth/sign-out", post(auth::sign_out));
        large = large
            .route("/api/setups", get(setups::list))
            .route("/api/setups/{id}", put(setups::put).delete(setups::delete))
            .route("/api/history", get(history::list).delete(history::clear))
            .route("/api/history/{id}", put(history::put).delete(history::delete));
        if state.why.is_some() {
            large = large.route("/api/why", post(run::post_why));
        }
    }
    let large = large.layer(RequestBodyLimitLayer::new(state.max_body_bytes));
    Router::new()
        .route("/api/config", get(config::get))
        .merge(small)
        .layer(RequestBodyLimitLayer::new(BODY_BYTES))
        .merge(large)
        .with_state(state)
}
