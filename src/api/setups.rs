//! A user's saved setups: a name, questions and a sample situation.

use std::sync::Arc;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::ApiState;
use super::auth::SignedIn;
use super::storage::{check_id, pool_of, read_body};
use crate::error::AppError;
use crate::kit::OcError;
use crate::systemone::{Question, Run};

const MAX_SETUPS: i64 = 100;
const MAX_NAME: usize = 60;
const MAX_STATE: usize = 8000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Setup {
    pub id: String,
    pub name: String,
    pub questions: Vec<Question>,
    pub sample_state: String,
}

impl Setup {
    /// Name first, then the sample situation, then the questions like a run (an empty question
    /// text is allowed: the built-in "Yes or no" setup has one).
    fn validate(&self) -> Result<(), AppError> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("Name the setup.".into()));
        }
        if name.chars().count() > MAX_NAME {
            return Err(AppError::Invalid("Keep the setup name to 60 characters or fewer.".into()));
        }
        if self.sample_state.chars().count() > MAX_STATE {
            return Err(AppError::Invalid("Shorten the situation to 8,000 characters or fewer.".into()));
        }
        Run { state: String::new(), questions: self.questions.clone() }.validate_questions(true)
    }
}

pub async fn list(State(st): State<Arc<ApiState>>, SignedIn(user): SignedIn) -> Result<Json<Vec<Value>>, AppError> {
    let rows = sqlx::query!("SELECT body FROM setups WHERE user_id = ? ORDER BY name COLLATE NOCASE, id", user.id)
        .fetch_all(pool_of(&st)?)
        .await
        .map_err(OcError::from)?;
    let setups = rows
        .iter()
        .map(|r| serde_json::from_str(&r.body).map_err(OcError::internal))
        .collect::<Result<Vec<Value>, _>>()?;
    Ok(Json(setups))
}

pub async fn put(
    State(st): State<Arc<ApiState>>,
    SignedIn(user): SignedIn,
    Path(id): Path<String>,
    body: Result<Json<Setup>, JsonRejection>,
) -> Result<StatusCode, AppError> {
    check_id(&id)?;
    let setup = read_body(body)?;
    if setup.id != id {
        return Err(AppError::Invalid("The setup id does not match its address.".into()));
    }
    setup.validate()?;
    let name = setup.name.trim().to_owned();
    let text = serde_json::to_string(&setup).map_err(OcError::internal)?;
    let mut tx = pool_of(&st)?.begin_with("BEGIN IMMEDIATE").await.map_err(OcError::from)?;
    let exists =
        sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!: i64" FROM setups WHERE user_id = ? AND id = ?"#, user.id, id)
            .fetch_one(&mut *tx)
            .await
            .map_err(OcError::from)?
            > 0;
    if !exists {
        let count = sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!: i64" FROM setups WHERE user_id = ?"#, user.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(OcError::from)?;
        if count >= MAX_SETUPS {
            return Err(AppError::Invalid("Delete a setup before adding another.".into()));
        }
    }
    sqlx::query!(
        "INSERT INTO setups (id, user_id, name, body) VALUES (?, ?, ?, ?) \
         ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, body = excluded.body",
        id,
        user.id,
        name,
        text
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
    sqlx::query!("DELETE FROM setups WHERE user_id = ? AND id = ?", user.id, id)
        .execute(pool_of(&st)?)
        .await
        .map_err(OcError::from)?;
    Ok(StatusCode::NO_CONTENT)
}
