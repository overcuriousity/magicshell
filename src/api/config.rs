use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::request::Parts;
use serde_json::{Value, json};

use super::{ApiState, auth};
use crate::kit::OcError;
use crate::kit::identity::users;

/// What the page needs to know (the version is for its footer); never the endpoint or the key.
pub async fn get(State(st): State<Arc<ApiState>>, mut parts: Parts) -> Result<Json<Value>, OcError> {
    let mode = if st.pool.is_some() { "accounts" } else { "open" };
    let user = match (auth::current(&st, &mut parts).await?, &st.pool) {
        (Some(u), Some(pool)) => {
            Some(json!({ "username": u.username, "password": users::has_password(pool, u.id).await? }))
        }
        _ => None,
    };
    let why = st.why.as_ref().map(|w| json!({ "maxWords": w.max_words }));
    let sso = st.oidc.as_ref().map(|o| json!({ "label": o.label() }));
    Ok(Json(json!({
        "mode": mode, "model": st.model, "user": user, "why": why, "sso": sso, "preheat": st.preheat.is_some(), "version": env!("CARGO_PKG_VERSION")
    })))
}
