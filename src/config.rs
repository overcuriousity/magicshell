use serde::Deserialize;
use url::Url;

use crate::kit::OcError;
use crate::kit::config::{OcConfig, Secret};

fn runs_per_minute() -> u32 {
    60
}

fn why_max_words() -> u32 {
    300
}

fn why_per_minute() -> u32 {
    600
}

fn upstream_timeout_secs() -> u64 {
    60
}

/// The `[app]` section. `endpoint` and `model` have no default.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    /// Base of the model endpoint; the server calls `<endpoint>/systemone`.
    pub endpoint: Url,
    pub api_key: Option<Secret>,
    pub model: String,
    /// Path of the SQLite file for accounts mode; absent means open mode.
    pub database: Option<String>,
    #[serde(default = "runs_per_minute")]
    pub runs_per_minute: u32,
    /// Longest situation "Why?" accepts, in words; 0 turns "Why?" off.
    #[serde(default = "why_max_words")]
    pub why_max_words: u32,
    /// "Why?" questions one user may ask per minute, counted apart from runs.
    #[serde(default = "why_per_minute")]
    pub why_per_minute: u32,
    #[serde(default = "upstream_timeout_secs")]
    pub upstream_timeout_secs: u64,
}

impl AppConfig {
    /// Reads `[app]`; a missing `endpoint` or `model` is an error that names the key.
    pub fn from_config(cfg: &OcConfig) -> Result<Self, OcError> {
        let Some(app) = &cfg.app else {
            return Err(OcError::Config("Invalid [app] configuration: missing field `endpoint`.".into()));
        };
        let app: Self = app.deserialize().map_err(|e| OcError::Config(format!("Invalid [app] configuration: {e}.")))?;
        if app.model.trim().is_empty() {
            return Err(OcError::Config("Invalid [app] configuration: `model` must not be empty.".into()));
        }
        Ok(app)
    }
}
