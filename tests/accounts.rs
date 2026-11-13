#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use serde_json::{Value, json};
use support::{
    ACCOUNTS, FakeReply, TestApp, add_user, cookie_of, fake_upstream, fixture_reply, get_with, post_json, sign_in,
    spawn_against,
};

const PASSWORD: &str = "a long enough password";

fn triage_run() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/systemone/response-triage.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fixture["run"].clone()
}

async fn app_with_ada(replies: Vec<FakeReply>, extra: &str) -> (TestApp, support::FakeUpstream) {
    let fake = fake_upstream(replies).await;
    let app = spawn_against(&format!("{ACCOUNTS}{extra}"), &fake).await;
    add_user(&app, "ada", PASSWORD).await;
    (app, fake)
}

async fn user_of(app: &TestApp, cookie: Option<&str>) -> Value {
    let body: Value = get_with(app, "/api/config", cookie).await.json().await.unwrap();
    assert_eq!(body["mode"], "accounts");
    body["user"].clone()
}

#[tokio::test]
async fn a_run_needs_a_signed_in_user() {
    let (app, fake) = app_with_ada(vec![fixture_reply("response-triage")], "").await;
    let res = post_json(&app, "/api/run", &triage_run(), None).await;
    assert_eq!(res.status(), 401);
    assert_eq!(res.text().await.unwrap(), "Sign in first.");
    assert_eq!(fake.requests.lock().unwrap().len(), 0);
    assert_eq!(user_of(&app, None).await, Value::Null);
}

#[tokio::test]
async fn a_user_signs_in_and_runs() {
    let (app, fake) = app_with_ada(vec![fixture_reply("response-triage")], "").await;
    let cookie = sign_in(&app, "Ada", PASSWORD).await;
    assert_eq!(user_of(&app, Some(&cookie)).await, json!({"username": "ada"}));
    let res = post_json(&app, "/api/run", &triage_run(), Some(&cookie)).await;
    assert_eq!(res.status(), 200);
    assert_eq!(fake.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_wrong_password_is_refused() {
    let (app, _fake) = app_with_ada(vec![], "").await;
    for (name, pw) in [("ada", "not the password"), ("nobody", PASSWORD)] {
        let res = post_json(&app, "/api/auth/sign-in", &json!({"username": name, "password": pw}), None).await;
        assert_eq!(res.status(), 401);
        assert!(res.headers().get("set-cookie").is_none());
        assert_eq!(res.text().await.unwrap(), "Wrong username or password.");
    }
}

#[tokio::test]
async fn signing_out_ends_the_session() {
    let (app, _fake) = app_with_ada(vec![], "").await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    let res = post_json(&app, "/api/auth/sign-out", &json!({}), Some(&cookie)).await;
    assert_eq!(res.status(), 204);
    assert_eq!(user_of(&app, Some(&cookie)).await, Value::Null);
    let run = post_json(&app, "/api/run", &triage_run(), Some(&cookie)).await;
    assert_eq!(run.status(), 401);
}

#[tokio::test]
async fn the_session_id_changes_on_sign_in() {
    let (app, _fake) = app_with_ada(vec![], "").await;
    let first = sign_in(&app, "ada", PASSWORD).await;
    let res =
        post_json(&app, "/api/auth/sign-in", &json!({"username": "ada", "password": PASSWORD}), Some(&first)).await;
    assert_eq!(res.status(), 204);
    let second = cookie_of(&res);
    assert_ne!(first, second);
    assert_eq!(user_of(&app, Some(&first)).await, Value::Null);
    assert_eq!(user_of(&app, Some(&second)).await, json!({"username": "ada"}));
}

#[tokio::test]
async fn the_session_cookie_is_http_only_and_same_site_lax() {
    let (app, _fake) = app_with_ada(vec![], "").await;
    let res = post_json(&app, "/api/auth/sign-in", &json!({"username": "ada", "password": PASSWORD}), None).await;
    let set = res.headers()["set-cookie"].to_str().unwrap();
    assert!(set.starts_with("__Host-magicshell-session="), "{set}");
    for attribute in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"] {
        assert!(set.contains(attribute), "{attribute} missing in {set}");
    }
    assert!(!set.contains("Domain"), "{set}");
}

#[tokio::test]
async fn a_user_changes_their_password() {
    let (app, _fake) = app_with_ada(vec![], "").await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    let wrong = post_json(
        &app,
        "/api/auth/password",
        &json!({"current": "not the password", "new": "another long password"}),
        Some(&cookie),
    )
    .await;
    assert_eq!(wrong.status(), 422);
    assert_eq!(wrong.text().await.unwrap(), "The current password is wrong.");
    let ok = post_json(
        &app,
        "/api/auth/password",
        &json!({"current": PASSWORD, "new": "another long password"}),
        Some(&cookie),
    )
    .await;
    assert_eq!(ok.status(), 204);
    let old = post_json(&app, "/api/auth/sign-in", &json!({"username": "ada", "password": PASSWORD}), None).await;
    assert_eq!(old.status(), 401);
    sign_in(&app, "ada", "another long password").await;
    let anonymous =
        post_json(&app, "/api/auth/password", &json!({"current": PASSWORD, "new": "yet another password"}), None).await;
    assert_eq!(anonymous.status(), 401);
}

#[tokio::test]
async fn a_short_new_password_is_refused() {
    let (app, _fake) = app_with_ada(vec![], "").await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    let res =
        post_json(&app, "/api/auth/password", &json!({"current": PASSWORD, "new": "elevenchars"}), Some(&cookie)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "Use at least 12 characters.");
    sign_in(&app, "ada", PASSWORD).await;
}

#[tokio::test]
async fn runs_are_limited_per_user_not_per_address() {
    let replies =
        vec![fixture_reply("response-triage"), fixture_reply("response-triage"), fixture_reply("response-triage")];
    let (app, fake) = app_with_ada(replies, "runs_per_minute = 2\n").await;
    add_user(&app, "bob", PASSWORD).await;
    let ada = sign_in(&app, "ada", PASSWORD).await;
    let bob = sign_in(&app, "bob", PASSWORD).await;
    assert_eq!(post_json(&app, "/api/run", &triage_run(), Some(&ada)).await.status(), 200);
    assert_eq!(post_json(&app, "/api/run", &triage_run(), Some(&ada)).await.status(), 200);
    let third = post_json(&app, "/api/run", &triage_run(), Some(&ada)).await;
    assert_eq!(third.status(), 429);
    assert_eq!(third.text().await.unwrap(), "Too many questions. Wait a minute and try again.");
    assert_eq!(post_json(&app, "/api/run", &triage_run(), Some(&bob)).await.status(), 200);
    assert_eq!(fake.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn sign_in_attempts_are_limited_per_address() {
    let (app, _fake) = app_with_ada(vec![], "").await;
    let mut statuses = Vec::new();
    for _ in 0..12 {
        let res = post_json(&app, "/api/auth/sign-in", &json!({"username": "ada", "password": "wrong"}), None).await;
        statuses.push(res.status().as_u16());
    }
    assert_eq!(statuses[0], 401);
    assert!(statuses.contains(&429), "{statuses:?}");
}
