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
    let why = st.why.as_ref().map(|w| json!({ "maxWords": w.max_words }));
    let sso = st.oidc.as_ref().map(|o| json!({ "label": o.label() }));
    Ok(Json(json!({
        "mode": mode, "model": st.model, "user": user, "why": why, "sso": sso, "version": env!("CARGO_PKG_VERSION")
    })))
}
