use serde::Deserialize;
use url::Url;

use crate::kit::OcError;
use crate::kit::config::{OcConfig, OidcConfig, Secret};

fn runs_per_minute() -> u32 {
    60
}

fn why_max_words() -> u32 {
    300
}

fn why_per_minute() -> u32 {
    600
}

fn preheat() -> bool {
    true
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
    /// `POST /api/preheat` loads the model before the first question, for signed-in users of accounts
    /// mode; false, or open mode, leaves the route out.
    #[serde(default = "preheat")]
    pub preheat: bool,
    #[serde(default = "upstream_timeout_secs")]
    pub upstream_timeout_secs: u64,
    /// From `[auth.oidc]`, filled by [`AppConfig::from_config`].
    #[serde(skip)]
    pub oidc: Option<OidcConfig>,
}

impl AppConfig {
    /// Reads `[app]`; a missing `endpoint` or `model` is an error that names the key.
    pub fn from_config(cfg: &OcConfig) -> Result<Self, OcError> {
        let Some(app) = &cfg.app else {
            return Err(OcError::Config("Invalid [app] configuration: missing field `endpoint`.".into()));
        };
        let mut app: Self =
            app.deserialize().map_err(|e| OcError::Config(format!("Invalid [app] configuration: {e}.")))?;
        if app.model.trim().is_empty() {
            return Err(OcError::Config("Invalid [app] configuration: `model` must not be empty.".into()));
        }
        if let Some(oidc) = &cfg.auth.oidc {
            if app.database.is_none() {
                return Err(OcError::Config(
                    "Sign-in through [auth.oidc] needs accounts. Set database under [app].".into(),
                ));
            }
            if Url::parse(&oidc.issuer).is_err() {
                return Err(OcError::Config(format!("auth.oidc.issuer is not a URL: {}.", oidc.issuer)));
            }
        }
        app.oidc = cfg.auth.oidc.clone();
        Ok(app)
    }
}
