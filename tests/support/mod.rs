#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;

use figment::Figment;
use figment::providers::{Format, Toml};
use magicshell::config::AppConfig;
use magicshell::kit::config::OcConfig;

/// No configuration: open mode on loopback.
pub const OPEN: &str = "[app]\nendpoint = \"{ENDPOINT}\"\nmodel = \"test-model\"\n";

/// Accounts mode: a database in a temporary data directory.
pub const ACCOUNTS: &str =
    "data_dir = \"{DATA}\"\n[app]\nendpoint = \"{ENDPOINT}\"\nmodel = \"test-model\"\ndatabase = \"magicshell.db\"\n";

/// An address nothing listens on, for tests that never reach the model.
const NOWHERE: &str = "http://127.0.0.1:9/v1";

pub struct TestApp {
    pub base: String,
    pub client: reqwest::Client,
    /// The data directory; it lives as long as the app.
    pub dir: tempfile::TempDir,
    /// The accounts database; `None` in open mode.
    pub pool: Option<sqlx::SqlitePool>,
}

/// The TOML for `ACCOUNTS` with the data directory and an unreachable endpoint filled in.
pub fn accounts_toml(dir: &std::path::Path) -> String {
    ACCOUNTS.replace("{DATA}", dir.to_str().unwrap()).replace("{ENDPOINT}", NOWHERE)
}

/// Starts the app on an existing data directory (for example one prepared with the `user` commands).
pub async fn spawn_in(cfg_toml: &str, dir: tempfile::TempDir) -> TestApp {
    start(cfg_toml, NOWHERE, dir).await
}

/// Starts the app on `127.0.0.1:0` with the given TOML; `bind` is replaced by the port the OS picked.
pub async fn spawn(cfg_toml: &str) -> TestApp {
    spawn_with(cfg_toml, NOWHERE).await
}

/// Like `spawn`, with `{ENDPOINT}` in the TOML replaced by the fake upstream's URL.
pub async fn spawn_against(cfg_toml: &str, fake: &FakeUpstream) -> TestApp {
    spawn_with(cfg_toml, fake.url.as_str()).await
}

async fn spawn_with(cfg_toml: &str, endpoint: &str) -> TestApp {
    start(cfg_toml, endpoint, tempfile::tempdir().unwrap()).await
}

async fn start(cfg_toml: &str, endpoint: &str, dir: tempfile::TempDir) -> TestApp {
    let cfg_toml = &cfg_toml.replace("{ENDPOINT}", endpoint).replace("{DATA}", dir.path().to_str().unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg: OcConfig = Figment::new().merge(Toml::string(cfg_toml)).extract().unwrap();
    cfg.bind = addr;
    let app_cfg: AppConfig = AppConfig::from_config(&cfg).unwrap();
    let pool = magicshell::app::open_pool(&cfg, &app_cfg).await.unwrap();
    let router = magicshell::app::build(&cfg, app_cfg, pool.clone()).await.unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    TestApp { base: format!("http://{addr}"), client: reqwest::Client::new(), dir, pool }
}

/// Creates a user straight in the database, with a password.
pub async fn add_user(app: &TestApp, name: &str, password: &str) {
    let pool = app.pool.as_ref().unwrap();
    magicshell::kit::identity::users::create(pool, name, password, time::OffsetDateTime::now_utc()).await.unwrap();
}

/// `name=value` of the session cookie a response sets. The cookie is Secure, so over plain
/// http the tests send it back by hand instead of trusting a cookie jar.
pub fn cookie_of(res: &reqwest::Response) -> String {
    let set = res.headers().get("set-cookie").expect("a Set-Cookie header").to_str().unwrap();
    set.split(';').next().unwrap().to_owned()
}

pub async fn post_json(app: &TestApp, path: &str, body: &serde_json::Value, cookie: Option<&str>) -> reqwest::Response {
    // A browser names its own origin on every post; the app refuses cookie posts that do not.
    let mut req = app.client.post(format!("{}{path}", app.base)).header("origin", &app.base).json(body);
    if let Some(c) = cookie {
        req = req.header("cookie", c);
    }
    req.send().await.unwrap()
}

pub async fn get_with(app: &TestApp, path: &str, cookie: Option<&str>) -> reqwest::Response {
    let mut req = app.client.get(format!("{}{path}", app.base));
    if let Some(c) = cookie {
        req = req.header("cookie", c);
    }
    req.send().await.unwrap()
}

/// Signs in and returns the session cookie.
pub async fn sign_in(app: &TestApp, name: &str, password: &str) -> String {
    let res =
        post_json(app, "/api/auth/sign-in", &serde_json::json!({"username": name, "password": password}), None).await;
    assert_eq!(res.status(), 204);
    cookie_of(&res)
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
