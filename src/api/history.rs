//! A user's run history, newest first, at most 500 entries.

use std::collections::{BTreeMap, BTreeSet};
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
/// The kept Why? part, measured on its own so the whole request stays under the 64 KB body limit.
const MAX_WHY: usize = 40 * 1024;

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
    /// The kept Why? result. Held raw so that a part that does not fit gets one clear sentence;
    /// `check_why` parses it as a `WhyPart`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<Value>,
}

/// How each word of the situation moved the answers; see `check_why` for what must hold.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WhyPart {
    v: u8,
    words: u32,
    done: u32,
    q: BTreeMap<String, WhyQuestion>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WhyQuestion {
    vals: Vec<f64>,
    flips: BTreeMap<String, Value>,
}

fn check_why(why: &Value, run: &Run) -> Result<(), AppError> {
    let size = serde_json::to_string(why).map_err(OcError::internal)?.len();
    if size > MAX_WHY {
        return Err(AppError::Invalid("The kept Why? result of this entry is too large to keep.".into()));
    }
    let bad = || AppError::Invalid("The kept Why? result of this entry is not valid.".into());
    let part: WhyPart = serde_json::from_value(why.clone()).map_err(|_| bad())?;
    let done = part.done as usize;
    if part.v != 1 || part.done > part.words || part.words as usize != crate::systemone::word_count(&run.state) {
        return Err(bad());
    }
    let keys: BTreeSet<&str> = run.questions.iter().map(|q| q.key.as_str()).collect();
    if part.q.len() != keys.len() || !part.q.keys().all(|k| keys.contains(k.as_str())) {
        return Err(bad());
    }
    for question in part.q.values() {
        if question.vals.len() != done || !question.vals.iter().all(|v| v.is_finite()) {
            return Err(bad());
        }
        for (word, flip) in &question.flips {
            let word_ok = word.parse::<usize>().is_ok_and(|w| w < done && w.to_string() == *word);
            if !word_ok || !(flip.is_boolean() || flip.is_u64()) {
                return Err(bad());
            }
        }
    }
    Ok(())
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
    if !entry.total_ms.as_f64().is_some_and(|ms| ms.is_finite() && ms >= 0.0) {
        return Err(AppError::Invalid("The duration of this entry is not valid.".into()));
    }
    let stored = serde_json::to_string(&entry.run).map_err(OcError::internal)?.len()
        + serde_json::to_string(&entry.reply).map_err(OcError::internal)?.len();
    if stored > MAX_STORED {
        return Err(AppError::Invalid("This entry is too large to keep.".into()));
    }
    if let Some(why) = &entry.why {
        check_why(why, &entry.run)?;
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
    let kept =
        sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!: i64" FROM history WHERE user_id = ? AND id = ?"#, user.id, id)
            .fetch_one(&mut *tx)
            .await
            .map_err(OcError::from)?;
    if kept == 0 {
        // Dropping the transaction rolls it back, so neither the entry nor the trim is kept.
        return Err(AppError::Invalid("History keeps only its 500 newest entries, and this one is older.".into()));
    }
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
