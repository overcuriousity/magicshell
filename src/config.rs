use serde::Deserialize;

/// The `[app]` section; Task 5 fills it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct AppConfig {}
