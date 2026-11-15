use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

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

fn embedding_min_similarity() -> f64 {
    0.75
}

fn embeds_per_minute() -> u32 {
    600
}

fn preheat() -> bool {
    true
}

fn upstream_timeout_secs() -> u64 {
    60
}

fn max_request_mb() -> u32 {
    16
}

fn picture_max_edge() -> u32 {
    768
}

#[derive(Debug, Clone)]
pub struct EmbeddingConfig {
    pub model: String,
    pub endpoint: Url,
    pub api_key: Option<Secret>,
    pub prefix: String,
    pub min_similarity: f64,
    pub per_minute: u32,
    pub id: String,
}

/// The `[app]` section. `endpoint` and `model` have no default.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    /// Base of the model endpoint; the server calls `<endpoint>/systemone`.
    pub endpoint: Url,
    pub api_key: Option<Secret>,
    pub model: String,
    #[serde(default)]
    pub embedding_model: Option<String>,
    #[serde(default)]
    pub embedding_endpoint: Option<Url>,
    #[serde(default)]
    pub embedding_api_key: Option<Secret>,
    #[serde(default)]
    pub embedding_prefix: String,
    #[serde(default = "embedding_min_similarity")]
    pub embedding_min_similarity: f64,
    #[serde(default = "embeds_per_minute")]
    pub embeds_per_minute: u32,
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
    /// Pictures one run may carry; 0 turns pictures off, absent sets no limit.
    #[serde(default)]
    pub max_pictures: Option<u32>,
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
        if app.embedding_model.as_deref().is_some_and(|model| model.trim().is_empty()) {
            return Err(OcError::Config("Invalid [app] configuration: `embedding_model` must not be empty.".into()));
        }
        if !app.embedding_min_similarity.is_finite() || !(0.0..=1.0).contains(&app.embedding_min_similarity) {
            return Err(OcError::Config(
                "Invalid [app] configuration: `embedding_min_similarity` must be finite and between 0 and 1.".into(),
            ));
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

    pub fn embedding(&self) -> Option<EmbeddingConfig> {
        let model = self.embedding_model.clone()?;
        let endpoint = self.embedding_endpoint.clone().unwrap_or_else(|| self.endpoint.clone());
        let api_key =
            if self.embedding_endpoint.is_some() { self.embedding_api_key.clone() } else { self.api_key.clone() };
        let prefix = self.embedding_prefix.clone();
        let mut hasher = DefaultHasher::new();
        model.hash(&mut hasher);
        endpoint.as_str().hash(&mut hasher);
        prefix.hash(&mut hasher);
        let id = format!("{:016x}", hasher.finish());
        Some(EmbeddingConfig {
            model,
            endpoint,
            api_key,
            prefix,
            min_similarity: self.embedding_min_similarity,
            per_minute: self.embeds_per_minute,
            id,
        })
    }
}
