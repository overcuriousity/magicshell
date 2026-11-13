use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::kit::error::OcError;

impl From<sqlx::Error> for OcError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => OcError::NotFound,
            e => OcError::internal(e),
        }
    }
}

pub async fn connect(data_dir: &Path, file: &str) -> Result<SqlitePool, OcError> {
    create_private_dir(data_dir)?;
    let url = format!("sqlite://{}", data_dir.join(file).display());
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(OcError::internal)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    Ok(SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?)
}

fn create_private_dir(dir: &Path) -> Result<(), OcError> {
    use std::os::unix::fs::DirBuilderExt;
    if dir.exists() {
        return Ok(());
    }
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| OcError::Config(format!("Cannot create data directory {}: {e}.", dir.display())))
}
