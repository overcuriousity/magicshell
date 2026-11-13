//! A user's run history, newest first, at most 500 entries.

use std::sync::Arc;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::ApiState;
use super::auth::SignedIn;
use super::storage::{check_id, pool_of, read_body};
use crate::error::AppError;
use crate::kit::OcError;
use crate::systemone::Run;

const MAX_ENTRIES: i64 = 500;
const MAX_STORED: usize = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub at: String,
    pub guided: bool,
    /// Validated when it was run; stored as it came.
    pub run: Run,
    /// Opaque: later browser code may add fields.
    pub reply: Map<String, Value>,
    pub total_ms: Number,
}

/// UTC with fixed width, so the text sorts like the time.
fn sortable(at: &str) -> Result<String, AppError> {
    let parsed = OffsetDateTime::parse(at, &Rfc3339)
        .map_err(|_| AppError::Invalid("The time of this entry is not valid.".into()))?
        .to_offset(time::UtcOffset::UTC);
    let format =
        time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6]Z");
    parsed.format(&format).map_err(|e| OcError::internal(e).into())
}

pub async fn list(State(st): State<Arc<ApiState>>, SignedIn(user): SignedIn) -> Result<Json<Vec<Value>>, AppError> {
    let rows = sqlx::query!(
        "SELECT body FROM history WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?",
        user.id,
        MAX_ENTRIES
    )
    .fetch_all(pool_of(&st)?)
    .await
    .map_err(OcError::from)?;
    let entries = rows
        .iter()
        .map(|r| serde_json::from_str(&r.body).map_err(OcError::internal))
        .collect::<Result<Vec<Value>, _>>()?;
    Ok(Json(entries))
}

pub async fn put(
    State(st): State<Arc<ApiState>>,
    SignedIn(user): SignedIn,
    Path(id): Path<String>,
    body: Result<Json<Entry>, JsonRejection>,
) -> Result<StatusCode, AppError> {
    check_id(&id)?;
    let entry = read_body(body)?;
    if entry.id != id {
        return Err(AppError::Invalid("The entry id does not match its address.".into()));
    }
    let at = sortable(&entry.at)?;
    let stored = serde_json::to_string(&entry.run).map_err(OcError::internal)?.len()
        + serde_json::to_string(&entry.reply).map_err(OcError::internal)?.len();
    if stored > MAX_STORED {
        return Err(AppError::Invalid("This entry is too large to keep.".into()));
    }
    let text = serde_json::to_string(&entry).map_err(OcError::internal)?;
    let mut tx = pool_of(&st)?.begin_with("BEGIN IMMEDIATE").await.map_err(OcError::from)?;
    sqlx::query!(
        "INSERT INTO history (id, user_id, at, body) VALUES (?, ?, ?, ?) \
         ON CONFLICT (user_id, id) DO UPDATE SET at = excluded.at, body = excluded.body",
        id,
        user.id,
        at,
        text
    )
    .execute(&mut *tx)
    .await
    .map_err(OcError::from)?;
    sqlx::query!(
        "DELETE FROM history WHERE user_id = ?1 AND id NOT IN \
         (SELECT id FROM history WHERE user_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2)",
        user.id,
        MAX_ENTRIES
    )
    .execute(&mut *tx)
    .await
    .map_err(OcError::from)?;
    tx.commit().await.map_err(OcError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(
    State(st): State<Arc<ApiState>>,
    SignedIn(user): SignedIn,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    check_id(&id)?;
    sqlx::query!("DELETE FROM history WHERE user_id = ? AND id = ?", user.id, id)
        .execute(pool_of(&st)?)
        .await
        .map_err(OcError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn clear(State(st): State<Arc<ApiState>>, SignedIn(user): SignedIn) -> Result<StatusCode, AppError> {
    sqlx::query!("DELETE FROM history WHERE user_id = ?", user.id)
        .execute(pool_of(&st)?)
        .await
        .map_err(OcError::from)?;
    Ok(StatusCode::NO_CONTENT)
}
