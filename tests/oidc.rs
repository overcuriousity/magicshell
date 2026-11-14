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
async fn passwords_work_beside_sso() {
    let (_idp, app) = sso_app(true).await;
    add_user(&app, "grace", "a long enough password").await;
    let res =
        post_json(&app, "/api/auth/sign-in", &json!({"username": "grace", "password": "a long enough password"}), None)
            .await;
    assert_eq!(res.status(), 204);
    let cookie = cookie_of(&res);
    let cfg = config(&app, Some(&cookie)).await;
    assert_eq!(cfg["user"]["username"], "grace");
    assert_eq!(cfg["user"]["password"], true);
    let change = post_json(
        &app,
        "/api/auth/password",
        &json!({"current": "a long enough password", "new": "another long password"}),
        Some(&cookie),
    )
    .await;
    assert_eq!(change.status(), 204);
}

#[tokio::test]
async fn a_provider_account_reports_no_password() {
    let (idp, app) = sso_app(true).await;
    let cookie = sso_sign_in(&app, &idp, "").await.cookie.unwrap();
    assert_eq!(config(&app, Some(&cookie)).await["user"]["password"], false);
    for password in ["", "anything-at-all"] {
        let res = post_json(&app, "/api/auth/sign-in", &json!({"username": "ada", "password": password}), None).await;
        assert_eq!(res.status(), 401, "{password:?}");
    }
}

async fn put_setup(app: &TestApp, cookie: &str, id: &str) {
    let setup = json!({
        "id": id, "name": id, "sampleState": "The server crashed twice today.",
        "questions": [{"key": "team", "type": "choice", "text": "Which team?",
                       "options": [{"id": "o1", "name": "ops"}, {"id": "o2", "name": "support"}]}]
    });
    let res = app
        .client
        .put(format!("{}/api/setups/{id}", app.base))
        .header("origin", &app.base)
        .header("cookie", cookie)
        .json(&setup)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
}

async fn setup_ids(app: &TestApp, cookie: &str) -> Vec<String> {
    let list: Value = get_with(app, "/api/setups", Some(cookie)).await.json().await.unwrap();
    list.as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn the_same_name_twice_is_two_accounts() {
    let (idp, app) = sso_app(true).await;
    add_user(&app, "ada", "a long enough password").await;
    let password = sign_in(&app, "ada", "a long enough password").await;
    // The provider names its person "ada" too; the account gets the next free name.
    let sso = sso_sign_in(&app, &idp, "").await.cookie.unwrap();
    assert_eq!(config(&app, Some(&password)).await["user"]["username"], "ada");
    assert_eq!(config(&app, Some(&sso)).await["user"]["username"], "ada-2");
    put_setup(&app, &password, "mine").await;
    put_setup(&app, &sso, "theirs").await;
    assert_eq!(setup_ids(&app, &password).await, ["mine"]);
    assert_eq!(setup_ids(&app, &sso).await, ["theirs"]);
}

#[tokio::test]
async fn config_reports_no_sso_in_password_mode() {
    let app = spawn(ACCOUNTS).await;
    assert_eq!(config(&app, None).await["sso"], Value::Null);
    assert!(config(&app, None).await.get("sso").is_some());
    assert_eq!(no_redirects().get(format!("{}/auth/oidc/start", app.base)).send().await.unwrap().status(), 404);
}

// Failures, replay and the mode switch.

/// `GET /auth/oidc/callback?<query>`: where it redirects and the cookie it sets, if any.
async fn callback(app: &TestApp, query: &str, cookie: Option<&str>) -> SsoResult {
    let mut req = no_redirects().get(format!("{}/auth/oidc/callback?{query}", app.base));
    if let Some(c) = cookie {
        req = req.header("cookie", c);
    }
    let res = req.send().await.unwrap();
    assert_eq!(res.status(), 303);
    assert_eq!(res.headers()["cache-control"], "no-store");
    let location = res.headers()["location"].to_str().unwrap().to_owned();
    let cookie = res.headers().get("set-cookie").map(|_| cookie_of(&res));
    SsoResult { location, cookie }
}

/// The callback query the provider would send for this authorize URL.
fn granted(idp: &Idp, authorize: &url::Url) -> String {
    format!("code={}&state={}", idp.grant(authorize), query(authorize, "state").unwrap())
}

async fn users(app: &TestApp) -> i64 {
    magicshell::kit::identity::users::count(app.pool.as_ref().unwrap()).await.unwrap()
}

const FAILED: &str = "/#/sign-in/failed";

/// A sign-in against a provider scripted to misbehave ends in `failed` and makes no account.
async fn refused(change: impl FnOnce(&mut fake_idp::Script)) {
    let (idp, app) = sso_app(true).await;
    change(&mut idp.script.lock().unwrap());
    assert_eq!(sso_sign_in(&app, &idp, "#/history").await.location, FAILED);
    assert_eq!(users(&app).await, 0);
}

#[tokio::test]
async fn a_token_for_another_nonce_is_refused() {
    refused(|s| s.nonce = Some("other".into())).await;
}

#[tokio::test]
async fn a_token_for_another_audience_is_refused() {
    refused(|s| s.aud = Some("someone-else".into())).await;
}

#[tokio::test]
async fn an_expired_token_is_refused() {
    refused(|s| s.expired = true).await;
}

#[tokio::test]
async fn a_failing_token_endpoint_is_refused() {
    refused(|s| s.token_status = 500).await;
}

#[tokio::test]
async fn a_wrong_state_is_refused() {
    let (idp, app) = sso_app(true).await;
    let (authorize, cookie) = sso_start(&app, "").await;
    let query = format!("code={}&state=not-the-state", idp.grant(&authorize));
    assert_eq!(callback(&app, &query, Some(&cookie)).await.location, FAILED);
    assert_eq!(users(&app).await, 0);
}

#[tokio::test]
async fn a_callback_without_the_session_is_refused() {
    let (idp, app) = sso_app(true).await;
    let (authorize, _cookie) = sso_start(&app, "").await;
    assert_eq!(callback(&app, &granted(&idp, &authorize), None).await.location, FAILED);
    assert_eq!(users(&app).await, 0);
}

#[tokio::test]
async fn a_refusal_at_the_provider_is_refused_here() {
    let (_idp, app) = sso_app(true).await;
    let (authorize, cookie) = sso_start(&app, "").await;
    let query = format!("error=access_denied&state={}", query(&authorize, "state").unwrap());
    assert_eq!(callback(&app, &query, Some(&cookie)).await.location, FAILED);
    assert_eq!(users(&app).await, 0);
}

/// The second call carries the cookie from before the sign-in, whose session the sign-in replaced.
#[tokio::test]
async fn a_callback_cannot_be_replayed() {
    let (idp, app) = sso_app(true).await;
    let (authorize, cookie) = sso_start(&app, "").await;
    let query = granted(&idp, &authorize);
    assert_eq!(callback(&app, &query, Some(&cookie)).await.location, "/");
    assert_eq!(callback(&app, &query, Some(&cookie)).await.location, FAILED);
}

#[tokio::test]
async fn reopening_the_callback_keeps_the_person_signed_in() {
    let (idp, app) = sso_app(true).await;
    let (authorize, cookie) = sso_start(&app, "").await;
    let query = granted(&idp, &authorize);
    let signed_in = callback(&app, &query, Some(&cookie)).await.cookie.unwrap();
    assert_eq!(callback(&app, &query, Some(&signed_in)).await.location, FAILED);
    assert_eq!(config(&app, Some(&signed_in)).await["user"]["username"], "ada");
}

#[tokio::test]
async fn a_failing_userinfo_does_not_stop_the_sign_in() {
    let (idp, app) = sso_app(true).await;
    {
        let mut s = idp.script.lock().unwrap();
        s.preferred_username = None;
        s.userinfo_status = 500;
    }
    assert_eq!(signed_in_name(&app, &idp).await, "sub-ada");
}

/// `GET /auth/oidc/start` inside an existing session: the provider URL and the cookie to go on with.
async fn start_again(app: &TestApp, cookie: &str) -> (url::Url, String) {
    let res =
        no_redirects().get(format!("{}/auth/oidc/start", app.base)).header("cookie", cookie).send().await.unwrap();
    assert_eq!(res.status(), 303);
    let authorize = res.headers()["location"].to_str().unwrap().parse().unwrap();
    let cookie = res.headers().get("set-cookie").map_or_else(|| cookie.to_owned(), |_| cookie_of(&res));
    (authorize, cookie)
}

#[tokio::test]
async fn a_second_start_replaces_the_first() {
    let (idp, app) = sso_app(true).await;
    let (first, cookie) = sso_start(&app, "").await;
    let (_second, cookie) = start_again(&app, &cookie).await;
    assert_eq!(callback(&app, &granted(&idp, &first), Some(&cookie)).await.location, FAILED);
    // The failed attempt used up the pending entry; one more click in the same session works.
    let (third, cookie) = start_again(&app, &cookie).await;
    assert_eq!(callback(&app, &granted(&idp, &third), Some(&cookie)).await.location, "/");
}

#[tokio::test]
async fn a_name_with_a_control_character_falls_back() {
    let (idp, app) = sso_app(true).await;
    {
        let mut s = idp.script.lock().unwrap();
        s.preferred_username = Some("a\nb".into());
        s.userinfo_username = Some(String::new());
    }
    assert_eq!(signed_in_name(&app, &idp).await, "sub-ada");
}

#[tokio::test]
async fn without_auto_provision_nobody_new_gets_in() {
    let (idp, app) = sso_app(false).await;
    assert_eq!(sso_sign_in(&app, &idp, "").await.location, "/#/sign-in/no-account");
    assert_eq!(users(&app).await, 0);
    magicshell::kit::identity::users::find_or_provision_oidc(
        app.pool.as_ref().unwrap(),
        &idp.issuer,
        "sub-ada",
        "ada",
        true,
        time::OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    assert_eq!(sso_sign_in(&app, &idp, "").await.location, "/");
}

#[tokio::test]
async fn the_server_starts_while_the_provider_is_down() {
    let idp = fake_idp::spawn().await;
    idp.script.lock().unwrap().down = true;
    let app = spawn(&sso_toml(&idp.issuer, true)).await;
    assert_eq!(get_with(&app, "/healthz", None).await.status(), 200);
    let res = sso_start_response(&app, "").await;
    assert_eq!(res.status(), 303);
    assert_eq!(res.headers()["location"], "/#/sign-in/unreachable");
    idp.script.lock().unwrap().down = false;
    assert_eq!(sso_sign_in(&app, &idp, "").await.location, "/");
}

#[tokio::test]
async fn an_issuer_that_differs_from_the_providers_is_unreachable() {
    let idp = fake_idp::spawn().await;
    let app = spawn(&sso_toml(&format!("{}/", idp.issuer), true)).await;
    let res = sso_start_response(&app, "").await;
    assert_eq!(res.headers()["location"], "/#/sign-in/unreachable");
}

#[tokio::test]
async fn a_password_session_survives_switching_sso_on() {
    let app = spawn(ACCOUNTS).await;
    add_user(&app, "ada", "a long enough password").await;
    let cookie = sign_in(&app, "ada", "a long enough password").await;
    assert_eq!(config(&app, Some(&cookie)).await["user"]["username"], "ada");
    let idp = fake_idp::spawn().await;
    let app = spawn_in(&sso_toml(&idp.issuer, true), app.dir).await;
    assert_eq!(config(&app, Some(&cookie)).await["user"]["username"], "ada");
    assert_eq!(get_with(&app, "/api/setups", Some(&cookie)).await.status(), 200);
}

#[tokio::test]
async fn an_sso_session_ends_when_sso_is_switched_off() {
    let (idp, app) = sso_app(true).await;
    let cookie = sso_sign_in(&app, &idp, "").await.cookie.unwrap();
    assert_eq!(config(&app, Some(&cookie)).await["user"]["username"], "ada");
    let app = spawn_in(ACCOUNTS, app.dir).await;
    assert_eq!(config(&app, Some(&cookie)).await["user"], Value::Null);
    assert_eq!(get_with(&app, "/api/setups", Some(&cookie)).await.status(), 401);
    for password in ["", "anything-at-all"] {
        let res = post_json(&app, "/api/auth/sign-in", &json!({"username": "ada", "password": password}), None).await;
        assert_eq!(res.status(), 401, "{password:?}");
    }
}

#[tokio::test]
async fn the_start_route_is_rate_limited() {
    let (_idp, app) = sso_app(true).await;
    let mut limited = false;
    for _ in 0..8 {
        let res = sso_start_response(&app, "").await;
        limited |= res.status() == 429;
    }
    assert!(limited);
}

// The silent check: `start?silent=1` asks the provider with `prompt=none`.

/// `GET /auth/oidc/start?<query>`: the provider URL and the session cookie.
async fn start_with(app: &TestApp, query: &str) -> (url::Url, String) {
    let res = no_redirects().get(format!("{}/auth/oidc/start?{query}", app.base)).send().await.unwrap();
    assert_eq!(res.status(), 303);
    (res.headers()["location"].to_str().unwrap().parse().unwrap(), cookie_of(&res))
}

#[tokio::test]
async fn a_silent_start_asks_with_prompt_none() {
    let (_idp, app) = sso_app(true).await;
    let (url, _) = start_with(&app, "silent=1").await;
    assert_eq!(query(&url, "prompt").as_deref(), Some("none"));
    for q in ["", "silent=true", "silent=0"] {
        let (url, _) = start_with(&app, q).await;
        assert_eq!(query(&url, "prompt"), None, "{q:?}");
    }
}

#[tokio::test]
async fn a_silent_start_that_the_provider_grants_signs_in() {
    let (idp, app) = sso_app(true).await;
    let (authorize, cookie) = start_with(&app, "silent=1&next=%23%2Fhistory").await;
    let res = callback(&app, &granted(&idp, &authorize), Some(&cookie)).await;
    assert_eq!(res.location, "/#/history");
    assert_eq!(config(&app, res.cookie.as_deref()).await["user"]["username"], "ada");
}

#[tokio::test]
async fn a_silent_refusal_returns_to_the_form_quietly() {
    let (_idp, app) = sso_app(true).await;
    for error in ["login_required", "interaction_required", "consent_required", "account_selection_required"] {
        let (authorize, cookie) = start_with(&app, "silent=1").await;
        let q = format!("error={error}&state={}", query(&authorize, "state").unwrap());
        assert_eq!(callback(&app, &q, Some(&cookie)).await.location, "/#/sign-in", "{error}");
    }
    assert_eq!(users(&app).await, 0);
}

#[tokio::test]
async fn a_login_required_without_a_silent_start_is_a_failure() {
    let (_idp, app) = sso_app(true).await;
    // No pending sign-in.
    assert_eq!(callback(&app, "error=login_required&state=x", None).await.location, FAILED);
    // A pending sign-in that was not silent.
    let (authorize, cookie) = start_with(&app, "").await;
    let q = format!("error=login_required&state={}", query(&authorize, "state").unwrap());
    assert_eq!(callback(&app, &q, Some(&cookie)).await.location, FAILED);
    // A silent one, but the state is wrong or missing.
    for q in ["error=login_required&state=not-the-state", "error=login_required"] {
        let (_authorize, cookie) = start_with(&app, "silent=1").await;
        assert_eq!(callback(&app, q, Some(&cookie)).await.location, FAILED, "{q}");
    }
}

#[tokio::test]
async fn a_silent_start_while_the_provider_is_down() {
    let idp = fake_idp::spawn().await;
    idp.script.lock().unwrap().down = true;
    let app = spawn(&sso_toml(&idp.issuer, true)).await;
    let res = no_redirects().get(format!("{}/auth/oidc/start?silent=1", app.base)).send().await.unwrap();
    assert_eq!(res.status(), 303);
    assert_eq!(res.headers()["location"], "/#/sign-in/unreachable");
}

#[tokio::test]
async fn a_silent_sign_in_without_an_account() {
    let (idp, app) = sso_app(false).await;
    let (authorize, cookie) = start_with(&app, "silent=1").await;
    assert_eq!(callback(&app, &granted(&idp, &authorize), Some(&cookie)).await.location, "/#/sign-in/no-account");
    assert_eq!(users(&app).await, 0);
}
