use sqlx::SqlitePool;
use time::OffsetDateTime;

use super::password;
use crate::kit::error::OcError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
}

pub async fn create(
    pool: &SqlitePool,
    username: &str,
    password: Option<&str>,
    now: OffsetDateTime,
) -> Result<User, OcError> {
    let hash = match password {
        Some(p) => Some(password::hash_blocking(p).await?),
        None => None,
    };
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(username)
    .bind(hash)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => {
            OcError::Conflict(format!("The username {username} is taken."))
        }
        e => e.into(),
    })?;
    Ok(User { id, username: username.to_owned() })
}

pub async fn by_id(pool: &SqlitePool, id: i64) -> Result<Option<User>, OcError> {
    Ok(sqlx::query_as::<_, User>("SELECT id, username FROM users WHERE id = ?").bind(id).fetch_optional(pool).await?)
}

pub async fn by_username(pool: &SqlitePool, username: &str) -> Result<Option<User>, OcError> {
    Ok(sqlx::query_as::<_, User>("SELECT id, username FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await?)
}

pub async fn verify_password(pool: &SqlitePool, username: &str, secret: &str) -> Result<Option<User>, OcError> {
    let row = sqlx::query_as::<_, (i64, String, Option<String>)>(
        "SELECT id, username, password_hash FROM users WHERE username = ?",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    let Some((id, username, hash)) = row else {
        password::verify_blocking(secret, None).await;
        return Ok(None);
    };
    let ok = password::verify_blocking(secret, hash.as_deref()).await;
    Ok(ok.then_some(User { id, username }))
}

pub async fn set_password(pool: &SqlitePool, user_id: i64, secret: &str) -> Result<(), OcError> {
    let hash = password::hash_blocking(secret).await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash).bind(user_id).execute(pool).await?;
    Ok(())
}

pub async fn count(pool: &SqlitePool) -> Result<i64, OcError> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users").fetch_one(pool).await?)
}
