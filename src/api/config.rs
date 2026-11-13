use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

use super::ApiState;

/// What the page needs to know; never the endpoint or the key.
pub async fn get(State(st): State<Arc<ApiState>>) -> Json<Value> {
    Json(json!({ "mode": "open", "model": st.model, "user": null }))
}
