use serde::Deserialize;
use url::Url;

use crate::kit::OcError;
use crate::kit::config::{OcConfig, OidcConfig, Secret};
// Until pictures lose their own count (Task 4).
const MAX_PICTURES: usize = 4;

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

fn max_pictures() -> u32 {
    4
}

fn max_request_mb() -> u32 {
    16
}

fn picture_max_edge() -> u32 {
    768
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
    /// Pictures one run may carry, 0 to 4; 0 turns pictures off.
    #[serde(default = "max_pictures")]
    pub max_pictures: u32,
    /// Longest edge, in pixels, the page shrinks a picture to; 256 to 2048.
    #[serde(default = "picture_max_edge")]
    pub picture_max_edge: u32,
    /// The largest request the server reads, in MB: a run, a Why? question, a history entry or a
    /// setup; also the largest answer it reads from the endpoint. 1 to 1024.
    #[serde(default = "max_request_mb")]
    pub max_request_mb: u32,
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
        if app.max_pictures as usize > MAX_PICTURES {
            return Err(OcError::Config(format!(
                "Invalid [app] configuration: max_pictures must be 0 to {MAX_PICTURES}."
            )));
        }
        if !(1..=1024).contains(&app.max_request_mb) {
            return Err(OcError::Config("Invalid [app] configuration: max_request_mb must be 1 to 1024.".into()));
        }
        if !(256..=2048).contains(&app.picture_max_edge) {
            return Err(OcError::Config("Invalid [app] configuration: picture_max_edge must be 256 to 2048.".into()));
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
