use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use serde::{Deserialize, Serialize};

use super::ApiState;
use super::run::Caller;
use crate::error::AppError;
use crate::kit::OcError;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbedRequest {
    texts: Vec<String>,
}

#[derive(Serialize)]
pub struct EmbedReply {
    vectors: Vec<Vec<f64>>,
}

pub async fn post(
    State(st): State<Arc<ApiState>>,
    Caller(caller): Caller,
    body: Result<Json<EmbedRequest>, JsonRejection>,
) -> Result<Json<EmbedReply>, AppError> {
    let Some(similar) = &st.similar else { return Err(OcError::NotFound.into()) };
    let Json(request) = body.map_err(|_| AppError::Invalid("The server could not read this request.".into()))?;
    if !(1..=64).contains(&request.texts.len()) {
        return Err(AppError::Invalid("Send 1 to 64 texts.".into()));
    }
    if request.texts.iter().any(|text| text.trim().is_empty()) {
        return Err(AppError::Invalid("Every text must be non-empty.".into()));
    }
    if !similar.limiter.take_n(&caller, request.texts.len() as u32) {
        return Err(AppError::RateLimited);
    }
    let vectors = similar.upstream.embed(&request.texts).await?;
    Ok(Json(EmbedReply { vectors }))
}
