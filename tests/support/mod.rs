#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;

use figment::Figment;
use figment::providers::{Format, Toml};
use magicshell::config::AppConfig;
use magicshell::kit::config::OcConfig;

/// No configuration: open mode on loopback.
pub const OPEN: &str = "";

pub struct TestApp {
    pub base: String,
    pub client: reqwest::Client,
}

/// Starts the app on `127.0.0.1:0` with the given TOML; `bind` is replaced by the port the OS picked.
pub async fn spawn(cfg_toml: &str) -> TestApp {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg: OcConfig = Figment::new().merge(Toml::string(cfg_toml)).extract().unwrap();
    cfg.bind = addr;
    let app_cfg: AppConfig = cfg.app().unwrap();
    let router = magicshell::app::build(&cfg, app_cfg, None).unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    TestApp { base: format!("http://{addr}"), client: reqwest::Client::new() }
}
