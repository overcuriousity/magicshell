mod config;
mod run;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};

use crate::limit::Limiter;
use crate::upstream::Upstream;

pub struct ApiState {
    pub upstream: Upstream,
    pub limiter: Limiter,
    pub model: String,
}

pub fn router(state: Arc<ApiState>) -> Router {
    Router::new().route("/api/config", get(config::get)).route("/api/run", post(run::post)).with_state(state)
}
