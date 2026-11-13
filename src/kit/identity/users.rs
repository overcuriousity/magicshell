use sqlx::SqlitePool;
use time::OffsetDateTime;

use super::password;
use crate::kit::error::OcError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
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
    let id = sqlx::query_scalar!(
        r#"INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id AS "id!: i64""#,
        username,
        hash,
        now
    )
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
    Ok(sqlx::query_as!(User, r#"SELECT id AS "id!: i64", username AS "username!" FROM users WHERE id = ?"#, id)
        .fetch_optional(pool)
        .await?)
}

pub async fn by_username(pool: &SqlitePool, username: &str) -> Result<Option<User>, OcError> {
    Ok(sqlx::query_as!(
        User,
        r#"SELECT id AS "id!: i64", username AS "username!" FROM users WHERE username = ?"#,
        username
    )
    .fetch_optional(pool)
    .await?)
}

pub async fn verify_password(pool: &SqlitePool, username: &str, secret: &str) -> Result<Option<User>, OcError> {
    let row = sqlx::query!(
        r#"SELECT id AS "id!: i64", username AS "username!", password_hash FROM users WHERE username = ?"#,
        username
    )
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        password::verify_blocking(secret, None).await;
        return Ok(None);
    };
    let ok = password::verify_blocking(secret, Some(row.password_hash.as_str())).await;
    Ok(ok.then_some(User { id: row.id, username: row.username }))
}

pub async fn set_password(pool: &SqlitePool, user_id: i64, secret: &str) -> Result<(), OcError> {
    let hash = password::hash_blocking(secret).await?;
    sqlx::query!("UPDATE users SET password_hash = ? WHERE id = ?", hash, user_id).execute(pool).await?;
    Ok(())
}

pub async fn count(pool: &SqlitePool) -> Result<i64, OcError> {
    Ok(sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!: i64" FROM users"#).fetch_one(pool).await?)
}

/// Every user with the day they were created, oldest first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<(User, String)>, OcError> {
    let rows = sqlx::query!(r#"SELECT id AS "id!: i64", username AS "username!", created_at FROM users ORDER BY id"#)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| (User { id: r.id, username: r.username }, r.created_at)).collect())
}

/// Deletes the user and, through foreign keys, their data; false when there is no such user.
pub async fn delete_by_username(pool: &SqlitePool, username: &str) -> Result<bool, OcError> {
    let done = sqlx::query!("DELETE FROM users WHERE username = ?", username).execute(pool).await?;
    Ok(done.rows_affected() > 0)
}
