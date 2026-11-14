#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use serde_json::{Value, json};
use support::fake_idp::{self, Idp, query};
use support::*;

async fn sso_app(auto_provision: bool) -> (Idp, TestApp) {
    let idp = fake_idp::spawn().await;
    let app = spawn(&sso_toml(&idp.issuer, auto_provision)).await;
    (idp, app)
}

async fn config(app: &TestApp, cookie: Option<&str>) -> Value {
    let res = get_with(app, "/api/config", cookie).await;
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

/// The user name `/api/config` shows after an SSO sign-in.
async fn signed_in_name(app: &TestApp, idp: &Idp) -> String {
    let res = sso_sign_in(app, idp, "").await;
    assert_eq!(res.location, "/");
    let cfg = config(app, res.cookie.as_deref()).await;
    cfg["user"]["username"].as_str().unwrap().to_owned()
}

fn origin(app: &TestApp) -> String {
    let port = url::Url::parse(&app.base).unwrap().port().unwrap();
    format!("http://localhost:{port}")
}

#[tokio::test]
async fn start_redirects_to_the_provider_with_pkce() {
    let (idp, app) = sso_app(true).await;
    let res = sso_start_response(&app, "").await;
    assert_eq!(res.status(), 303);
    assert_eq!(res.headers()["cache-control"], "no-store");
    let url = url::Url::parse(res.headers()["location"].to_str().unwrap()).unwrap();
    let provider = url::Url::parse(&idp.issuer).unwrap();
    assert_eq!(url.host_str(), provider.host_str());
    assert_eq!(url.port(), provider.port());
    assert_eq!(query(&url, "response_type").as_deref(), Some("code"));
    assert_eq!(query(&url, "client_id").as_deref(), Some("magicshell"));
    assert_eq!(query(&url, "code_challenge_method").as_deref(), Some("S256"));
    for key in ["state", "nonce", "code_challenge"] {
        assert!(query(&url, key).is_some_and(|v| !v.is_empty()), "{key} missing");
    }
    assert_eq!(query(&url, "redirect_uri").unwrap(), format!("{}/auth/oidc/callback", origin(&app)));
    let scope = query(&url, "scope").unwrap();
    let scopes: Vec<&str> = scope.split(' ').collect();
    assert!(scopes.contains(&"openid") && scopes.contains(&"profile"), "{scope}");
}

#[tokio::test]
async fn a_first_sign_in_creates_the_account_and_lands_on_next() {
    let (idp, app) = sso_app(true).await;
    let res = sso_sign_in(&app, &idp, "#/history").await;
    assert_eq!(res.location, "/#/history");
    let cfg = config(&app, res.cookie.as_deref()).await;
    assert_eq!(cfg["user"]["username"], "ada");
    assert_eq!(cfg["sso"]["label"], "Sign in with SSO");
}

#[tokio::test]
async fn a_second_sign_in_reaches_the_same_data() {
    let (idp, app) = sso_app(true).await;
    let first = sso_sign_in(&app, &idp, "").await.cookie.unwrap();
    let setup = json!({
        "id": "s1", "name": "First", "sampleState": "The server crashed twice today.",
        "questions": [{"key": "team", "type": "choice", "text": "Which team?",
                       "options": [{"id": "o1", "name": "ops"}, {"id": "o2", "name": "support"}]}]
    });
    let put = app
        .client
        .put(format!("{}/api/setups/s1", app.base))
        .header("origin", &app.base)
        .header("cookie", &first)
        .json(&setup)
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 204);
    assert_eq!(post_json(&app, "/api/auth/sign-out", &json!({}), Some(&first)).await.status(), 204);

    let second = sso_sign_in(&app, &idp, "").await.cookie.unwrap();
    let list: Value = get_with(&app, "/api/setups", Some(&second)).await.json().await.unwrap();
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["s1"]);
}

#[tokio::test]
async fn the_session_id_changes_on_sign_in() {
    let (idp, app) = sso_app(true).await;
    let (authorize, before) = sso_start(&app, "").await;
    let code = idp.grant(&authorize);
    let state = query(&authorize, "state").unwrap();
    let res = no_redirects()
        .get(format!("{}/auth/oidc/callback?code={code}&state={state}", app.base))
        .header("cookie", &before)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 303);
    assert_eq!(res.headers()["location"], "/");
    let after = cookie_of(&res);
    assert_ne!(after, before);
    assert_eq!(config(&app, Some(&after)).await["user"]["username"], "ada");
}

#[tokio::test]
async fn the_name_comes_from_userinfo_when_the_id_token_has_none() {
    let (idp, app) = sso_app(true).await;
    {
        let mut s = idp.script.lock().unwrap();
        s.preferred_username = None;
        s.userinfo_username = Some("grace".into());
    }
    assert_eq!(signed_in_name(&app, &idp).await, "grace");
}

#[tokio::test]
async fn the_subject_names_the_account_when_nothing_else_does() {
    let (idp, app) = sso_app(true).await;
    idp.script.lock().unwrap().preferred_username = None;
    assert_eq!(signed_in_name(&app, &idp).await, "sub-ada");
}

#[tokio::test]
async fn a_name_with_spaces_and_an_at_sign_is_kept() {
    let (idp, app) = sso_app(true).await;
    idp.script.lock().unwrap().preferred_username = Some("Ada L@cloud".into());
    assert_eq!(signed_in_name(&app, &idp).await, "Ada L@cloud");
}

#[tokio::test]
async fn next_must_be_a_fragment() {
    let (idp, app) = sso_app(true).await;
    let long = format!("#{}", "a".repeat(599));
    for next in ["https://evil.example", "//evil.example", "/x", long.as_str()] {
        assert_eq!(sso_sign_in(&app, &idp, next).await.location, "/", "{next}");
    }
}

#[tokio::test]
async fn an_encoded_next_arrives_unchanged() {
    let (idp, app) = sso_app(true).await;
    assert_eq!(sso_sign_in(&app, &idp, "#/setups/a%20b").await.location, "/#/setups/a%20b");
}

#[tokio::test]
async fn password_routes_are_gone_in_sso_mode() {
    let (idp, app) = sso_app(true).await;
    let sign_in = post_json(&app, "/api/auth/sign-in", &json!({"username": "ada", "password": "x"}), None).await;
    assert_eq!(sign_in.status(), 404);
    let password = post_json(&app, "/api/auth/password", &json!({"current": "x", "new": "y"}), None).await;
    assert_eq!(password.status(), 404);
    let cookie = sso_sign_in(&app, &idp, "").await.cookie.unwrap();
    assert_eq!(post_json(&app, "/api/auth/sign-out", &json!({}), Some(&cookie)).await.status(), 204);
    assert_eq!(config(&app, Some(&cookie)).await["user"], Value::Null);
}

#[tokio::test]
async fn config_reports_no_sso_in_password_mode() {
    let app = spawn(ACCOUNTS).await;
    assert_eq!(config(&app, None).await["sso"], Value::Null);
    assert!(config(&app, None).await.get("sso").is_some());
    assert_eq!(no_redirects().get(format!("{}/auth/oidc/start", app.base)).send().await.unwrap().status(), 404);
}
