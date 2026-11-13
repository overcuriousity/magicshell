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

/// One canned answer of the fake model endpoint.
#[derive(Debug, Clone)]
pub struct FakeReply {
    pub status: u16,
    pub body: String,
    pub delay: std::time::Duration,
}

impl FakeReply {
    pub fn ok(body: impl Into<String>) -> Self {
        Self { status: 200, body: body.into(), delay: std::time::Duration::ZERO }
    }

    pub fn status(status: u16, body: impl Into<String>) -> Self {
        Self { status, body: body.into(), delay: std::time::Duration::ZERO }
    }
}

/// What the fake endpoint saw.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub path: String,
    pub authorization: Option<String>,
    pub body: String,
}

pub struct FakeUpstream {
    /// Ends in `/v1`, like a production endpoint.
    pub url: url::Url,
    pub requests: std::sync::Arc<std::sync::Mutex<Vec<Recorded>>>,
}

#[derive(Clone)]
struct FakeState {
    replies: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<FakeReply>>>,
    requests: std::sync::Arc<std::sync::Mutex<Vec<Recorded>>>,
}

async fn fake_handler(
    axum::extract::State(state): axum::extract::State<FakeState>,
    req: axum::extract::Request,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    state.requests.lock().unwrap().push(Recorded {
        path: parts.uri.path().to_owned(),
        authorization: parts.headers.get("authorization").map(|v| v.to_str().unwrap().to_owned()),
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    });
    let reply = state.replies.lock().unwrap().pop_front();
    let Some(reply) = reply else {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "no reply queued").into_response();
    };
    tokio::time::sleep(reply.delay).await;
    (axum::http::StatusCode::from_u16(reply.status).unwrap(), reply.body).into_response()
}

/// A fake model endpoint on `127.0.0.1:0` that answers any path with the queued replies in order.
pub async fn fake_upstream(replies: Vec<FakeReply>) -> FakeUpstream {
    let state = FakeState {
        replies: std::sync::Arc::new(std::sync::Mutex::new(replies.into())),
        requests: std::sync::Arc::default(),
    };
    let requests = state.requests.clone();
    let router = axum::Router::new().fallback(fake_handler).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    FakeUpstream { url: format!("http://{addr}/v1").parse().unwrap(), requests }
}

/// Replays the captured `body` of `fixtures/systemone/<name>.json` with status 200; a `null` body
/// becomes a text body that is not JSON.
pub fn fixture_reply(name: &str) -> FakeReply {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("fixtures/systemone/{name}.json"));
    let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    match &fixture["body"] {
        serde_json::Value::Null => FakeReply::ok("<html>oops</html>"),
        body => FakeReply::ok(body.to_string()),
    }
}
