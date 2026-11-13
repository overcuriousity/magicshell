use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::request::Parts;
use serde_json::{Value, json};

use super::{ApiState, auth};
use crate::kit::OcError;

/// What the page needs to know (the version is for its footer); never the endpoint or the key.
pub async fn get(State(st): State<Arc<ApiState>>, mut parts: Parts) -> Result<Json<Value>, OcError> {
    let mode = if st.pool.is_some() { "accounts" } else { "open" };
    let user = auth::current(&st, &mut parts).await?.map(|u| json!({ "username": u.username }));
    Ok(Json(json!({ "mode": mode, "model": st.model, "user": user, "version": env!("CARGO_PKG_VERSION") })))
}
