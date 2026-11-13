use sqlx::SqlitePool;
use time::Duration;
use tower_sessions::cookie::SameSite;
use tower_sessions::{ExpiredDeletion, Expiry, SessionManagerLayer};
use tower_sessions_sqlx_store::SqliteStore;

use crate::kit::error::OcError;

pub const USER_KEY: &str = "oc.user_id";

/// `__Host-` cookies need Secure, which browsers also honour on `http://localhost`.
pub async fn session_layer(pool: &SqlitePool, app: &str) -> Result<SessionManagerLayer<SqliteStore>, OcError> {
    let store = SqliteStore::new(pool.clone()).with_table_name("sessions").map_err(OcError::internal)?;
    store.migrate().await.map_err(OcError::internal)?;
    tokio::spawn({
        let store = store.clone();
        async move {
            let _ = store.continuously_delete_expired(std::time::Duration::from_secs(3600)).await;
        }
    });
    Ok(SessionManagerLayer::new(store)
        .with_name(format!("__Host-{app}-session"))
        .with_secure(true)
        .with_http_only(true)
        .with_same_site(SameSite::Lax)
        .with_path("/")
        .with_expiry(Expiry::OnInactivity(Duration::days(14))))
}
