use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};

use figment::Figment;
use figment::providers::{Env, Format, Toml};
use ipnet::IpNet;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use url::Url;

use crate::kit::error::OcError;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct OcConfig {
    pub public_url: Option<Url>,
    pub bind: SocketAddr,
    pub trusted_proxies: Vec<IpNet>,
    pub data_dir: Option<PathBuf>,
    /// The app's own settings under `[app]`, read with [`OcConfig::app`].
    pub app: Option<figment::value::Value>,
    pub auth: AuthConfig,
}

impl Default for OcConfig {
    fn default() -> Self {
        Self {
            public_url: None,
            bind: SocketAddr::from(([127, 0, 0, 1], 8080)),
            trusted_proxies: ["127.0.0.1/32", "::1/128"].iter().filter_map(|s| s.parse().ok()).collect(),
            data_dir: None,
            app: None,
            auth: AuthConfig::default(),
        }
    }
}

/// The `[auth]` section; without `[auth.oidc]` sign-in stays with local passwords.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct AuthConfig {
    pub oidc: Option<OidcConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcConfig {
    /// Kept verbatim: discovery and token validation compare it byte for byte, trailing slash included.
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Secret,
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub auto_provision: bool,
    #[serde(default = "default_display_name")]
    pub display_name: String,
}

fn default_scopes() -> Vec<String> {
    vec!["openid".into(), "profile".into()]
}

fn default_display_name() -> String {
    "Sign in with SSO".into()
}

#[derive(Clone, Default)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        match raw.strip_prefix("file://") {
            Some(path) => std::fs::read_to_string(path)
                .map(|s| Secret(s.trim_end_matches(['\n', '\r']).to_owned()))
                .map_err(|e| serde::de::Error::custom(format!("Cannot read secret file {path}: {e}."))),
            None => Ok(Secret(raw)),
        }
    }
}

/// Loads `T` from an optional TOML file, then `{APP}__SECTION__KEY` environment variables.
/// `{APP}__…__NAME_FILE=/path` sets `name` to the contents of that file, for any key.
pub fn load<T: DeserializeOwned>(app: &str, file: Option<&Path>) -> Result<T, OcError> {
    let prefix = format!("{}__", app.to_ascii_uppercase());
    let mut fig = Figment::new();
    if let Some(path) = file {
        if !path.exists() {
            return Err(OcError::Config(format!("Config file {} does not exist.", path.display())));
        }
        fig = fig.merge(Toml::file(path));
    }
    fig = fig.merge(Env::prefixed(&prefix).split("__").filter(|k| !k.as_str().to_ascii_lowercase().ends_with("_file")));
    for (key, value) in std::env::vars() {
        let Some(rest) = key.strip_prefix(&prefix) else {
            continue;
        };
        let Some(name) = rest.strip_suffix("_FILE") else {
            continue;
        };
        let key = name.to_ascii_lowercase().replace("__", ".");
        let content = std::fs::read_to_string(&value)
            .map_err(|e| OcError::Config(format!("Cannot read {key} from {value}: {e}.")))?;
        let parsed: figment::value::Value = content
            .trim_end_matches(['\n', '\r'])
            .parse()
            .unwrap_or_else(|never: std::convert::Infallible| match never {});
        fig = fig.merge((key, parsed));
    }
    fig.extract().map_err(|e| OcError::Config(format!("Invalid configuration: {e}.")))
}

#[derive(Debug, Clone)]
pub struct Deployment {
    pub origin: String,
    pub secure: bool,
    pub public_url: Url,
    port: u16,
    loopback_dev: bool,
}

const LOOPBACK_NAMES: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

impl Deployment {
    pub fn host_allowed(&self, host: &str) -> bool {
        if self.loopback_dev {
            return LOOPBACK_NAMES
                .iter()
                .any(|n| host == format!("{n}:{}", self.port) || (self.port == 80 && host == *n));
        }
        let expected = self.public_url.host_str().unwrap_or_default();
        match self.public_url.port() {
            Some(p) => host == format!("{expected}:{p}"),
            None => host == expected,
        }
    }

    pub fn origin_allowed(&self, origin: &str) -> bool {
        if self.loopback_dev {
            return LOOPBACK_NAMES.iter().any(|n| origin == format!("http://{n}:{}", self.port));
        }
        origin == self.origin
    }
}

impl OcConfig {
    pub fn app<T: DeserializeOwned + Default>(&self) -> Result<T, OcError> {
        match &self.app {
            Some(v) => v.deserialize().map_err(|e| OcError::Config(format!("Invalid [app] configuration: {e}."))),
            None => Ok(T::default()),
        }
    }

    pub fn data_dir(&self, app: &str) -> PathBuf {
        if let Some(d) = &self.data_dir {
            return d.clone();
        }
        if let Some(d) = std::env::var_os("STATE_DIRECTORY") {
            return PathBuf::from(d);
        }
        if let Some(d) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(d).join(app);
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local/share").join(app);
        }
        PathBuf::from("./data")
    }

    pub fn deployment(&self) -> Result<Deployment, OcError> {
        let loopback_bind = self.bind.ip().is_loopback();
        let Some(url) = &self.public_url else {
            if !loopback_bind {
                return Err(OcError::Config("Set public_url when binding to a non-loopback address.".into()));
            }
            let origin = format!("http://localhost:{}", self.bind.port());
            return Ok(Deployment {
                public_url: Url::parse(&origin).map_err(OcError::internal)?,
                origin,
                secure: false,
                port: self.bind.port(),
                loopback_dev: true,
            });
        };
        let host = url.host_str().unwrap_or_default().to_owned();
        let is_loopback_host =
            host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()) || host == "[::1]";
        match url.scheme() {
            "https" => {}
            "http" if is_loopback_host => {}
            _ => {
                return Err(OcError::Config("public_url must be https unless it is localhost.".into()));
            }
        }
        Ok(Deployment {
            origin: url.origin().ascii_serialization(),
            secure: url.scheme() == "https",
            public_url: url.clone(),
            port: url.port_or_known_default().unwrap_or(443),
            loopback_dev: false,
        })
    }
}
