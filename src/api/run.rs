use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;

use super::ApiState;
use crate::error::AppError;
use crate::kit::security::ClientIp;
use crate::systemone::Run;
use crate::upstream::Reply;

pub async fn post(
    State(st): State<Arc<ApiState>>,
    ClientIp(ip): ClientIp,
    body: Result<Json<Run>, JsonRejection>,
) -> Result<Json<Reply>, AppError> {
    if !st.limiter.take(&format!("ip:{ip}")) {
        return Err(AppError::RateLimited);
    }
    let Json(run) = body.map_err(|_| {
        AppError::Invalid("The server could not read this request. Reload the page and try again.".into())
    })?;
    run.validate()?;
    Ok(Json(st.upstream.run(&run).await?))
}
