use sqlx::SqlitePool;
use time::OffsetDateTime;

use super::password;
use crate::kit::error::OcError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct User {
    pub id: i64,
    pub username: String,
}

pub async fn create(pool: &SqlitePool, username: &str, secret: &str, now: OffsetDateTime) -> Result<User, OcError> {
    let hash = password::hash_blocking(secret).await?;
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

/// The user of a session signed in under `epoch`; `None` once the password changed since.
/// `sso`: the user must have an identity row; otherwise a non-empty password hash.
pub async fn by_session(pool: &SqlitePool, id: i64, epoch: i64, sso: bool) -> Result<Option<User>, OcError> {
    Ok(sqlx::query_as!(
        User,
        r#"SELECT id AS "id!: i64", username AS "username!" FROM users
           WHERE id = ? AND session_epoch = ?
             AND CASE WHEN ? THEN EXISTS (SELECT 1 FROM oidc_identities WHERE user_id = users.id)
                      ELSE password_hash <> '' END"#,
        id,
        epoch,
        sso
    )
    .fetch_optional(pool)
    .await?)
}

/// False for an empty name, one over 255 bytes, or one with a control character.
pub fn usable_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 255 && !name.chars().any(char::is_control)
}

fn is_unique(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.is_unique_violation())
}

/// The user of `(issuer, subject)`; created when unknown and `auto_provision`. `None`: unknown and not allowed.
pub async fn find_or_provision_oidc(
    pool: &SqlitePool,
    issuer: &str,
    subject: &str,
    name: &str,
    auto_provision: bool,
    now: OffsetDateTime,
) -> Result<Option<User>, OcError> {
    if let Some(user) = by_identity(pool, issuer, subject).await? {
        return Ok(Some(user));
    }
    if !auto_provision {
        return Ok(None);
    }
    // A concurrent first sign-in loses on a unique violation; it then finds the winner's row.
    // The retry covers a clash that the lookup could not see yet.
    for _ in 0..2 {
        match provision(pool, issuer, subject, name, now).await {
            Ok(user) => return Ok(Some(user)),
            Err(e) if is_unique(&e) => {
                if let Some(user) = by_identity(pool, issuer, subject).await? {
                    return Ok(Some(user));
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(OcError::internal("could not create the account for a new identity"))
}

async fn by_identity(pool: &SqlitePool, issuer: &str, subject: &str) -> Result<Option<User>, OcError> {
    Ok(sqlx::query_as!(
        User,
        r#"SELECT u.id AS "id!: i64", u.username AS "username!" FROM oidc_identities i
           JOIN users u ON u.id = i.user_id WHERE i.issuer = ? AND i.subject = ?"#,
        issuer,
        subject
    )
    .fetch_optional(pool)
    .await?)
}

/// One transaction: the user (first free of `name`, `name-2`, ...) and its identity row.
/// The first statement writes, so the transaction holds the write lock from the start.
async fn provision(
    pool: &SqlitePool,
    issuer: &str,
    subject: &str,
    name: &str,
    now: OffsetDateTime,
) -> Result<User, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let mut username = name.to_owned();
    let mut n = 1_u32;
    let id = loop {
        // A SAVEPOINT is not needed: a failed statement leaves the transaction usable.
        let inserted = sqlx::query_scalar!(
            r#"INSERT INTO users (username, password_hash, created_at) VALUES (?, '', ?) RETURNING id AS "id!: i64""#,
            username,
            now
        )
        .fetch_one(&mut *tx)
        .await;
        match inserted {
            Ok(id) => break id,
            Err(e) if is_unique(&e) => {
                n += 1;
                username = format!("{name}-{n}");
            }
            Err(e) => return Err(e),
        }
    };
    sqlx::query!("INSERT INTO oidc_identities (issuer, subject, user_id) VALUES (?, ?, ?)", issuer, subject, id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(User { id, username })
}

/// The value a new session of this user records; `None` when there is no such user.
pub async fn session_epoch(pool: &SqlitePool, id: i64) -> Result<Option<i64>, OcError> {
    Ok(sqlx::query_scalar!(r#"SELECT session_epoch AS "e!: i64" FROM users WHERE id = ?"#, id)
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

/// Sets the password and ends every session of the user; returns the epoch for a session that stays.
pub async fn set_password(pool: &SqlitePool, user_id: i64, secret: &str) -> Result<i64, OcError> {
    let hash = password::hash_blocking(secret).await?;
    Ok(sqlx::query_scalar!(
        r#"UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?
           RETURNING session_epoch AS "e!: i64""#,
        hash,
        user_id
    )
    .fetch_one(pool)
    .await?)
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
