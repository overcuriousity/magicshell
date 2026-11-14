//! Copied from https://github.com/overcuriousity/overcuriousity-dev-manifest, tag v2026.11.1
//! (commit 2fe09ea1f8beaf80c48747ac3562910e261275f3), `crates/oc-kit/src/`, under MIT OR Apache-2.0.
//! Trimmed to what magicshell uses: no passkeys, tokens or admin flags; OIDC without bearer tokens.
//! Added: `config::defer_credentials`, so `check-config` can run while the service is stopped.

pub mod config;
pub mod db;
pub mod error;
pub mod identity;
pub mod oidc;
pub mod security;
pub mod session;

pub use error::OcError;
