#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{
    ACCOUNTS, FakeReply, FakeUpstream, OPEN, add_user, fake_upstream, fixture_reply, get_with, post_json, sign_in,
    spawn, spawn_against,
};

fn triage_run() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/systemone/response-triage.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fixture["run"].clone()
}

/// The reply to the warm-up request is thrown away, so the tests queue one the server cannot parse.
fn warm_up_reply() -> FakeReply {
    FakeReply::ok("{}")
}

fn seen(fake: &FakeUpstream) -> usize {
    fake.requests.lock().unwrap().len()
}

async fn wait_for_requests(fake: &FakeUpstream, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while seen(fake) < count && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn preheat(app: &support::TestApp, cookie: Option<&str>) -> reqwest::Response {
    post_json(app, "/api/preheat", &json!({}), cookie).await
}

#[tokio::test]
async fn preheat_sends_one_small_request() {
    let fake = fake_upstream(vec![warm_up_reply()]).await;
    let app = spawn_against(OPEN, &fake).await;
    assert_eq!(preheat(&app, None).await.status(), 204);
    wait_for_requests(&fake, 1).await;
    {
        let requests = fake.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let body: Value = serde_json::from_str(&requests[0].body).unwrap();
        assert_eq!(body["model"], "test-model");
        assert!(requests[0].body.contains("\"ready\""));
    }
    assert_eq!(preheat(&app, None).await.status(), 204);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(seen(&fake), 1);
}

#[tokio::test]
async fn a_run_starts_the_cooldown() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    let app = spawn_against(OPEN, &fake).await;
    assert_eq!(post_json(&app, "/api/run", &triage_run(), None).await.status(), 200);
    assert_eq!(preheat(&app, None).await.status(), 204);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(seen(&fake), 1);
}

#[tokio::test]
async fn preheat_answers_at_once_when_the_model_is_down() {
    let app = spawn(OPEN).await;
    let started = Instant::now();
    assert_eq!(preheat(&app, None).await.status(), 204);
    assert!(started.elapsed() < Duration::from_secs(1));
    let res = post_json(&app, "/api/run", &triage_run(), None).await;
    assert_eq!(res.status(), 502);
    assert!(res.text().await.unwrap().contains("cannot be reached"));
}

#[tokio::test]
async fn preheat_does_not_use_the_run_allowance() {
    let fake = fake_upstream(vec![warm_up_reply(), fixture_reply("response-triage")]).await;
    let app = spawn_against(&format!("{OPEN}runs_per_minute = 1\n"), &fake).await;
    assert_eq!(preheat(&app, None).await.status(), 204);
    wait_for_requests(&fake, 1).await;
    assert_eq!(post_json(&app, "/api/run", &triage_run(), None).await.status(), 200);
}

#[tokio::test]
async fn preheat_needs_a_session_in_accounts_mode() {
    let fake = fake_upstream(vec![warm_up_reply()]).await;
    let app = spawn_against(ACCOUNTS, &fake).await;
    add_user(&app, "ada", "a long enough password").await;
    assert_eq!(preheat(&app, None).await.status(), 401);
    let cookie = sign_in(&app, "ada", "a long enough password").await;
    assert_eq!(preheat(&app, Some(&cookie)).await.status(), 204);
}

#[tokio::test]
async fn preheat_off() {
    let app = spawn(&format!("{OPEN}preheat = false\n")).await;
    assert_eq!(preheat(&app, None).await.status(), 404);
    let config: Value = get_with(&app, "/api/config", None).await.json().await.unwrap();
    assert_eq!(config["preheat"], false);
    let app = spawn(OPEN).await;
    let config: Value = get_with(&app, "/api/config", None).await.json().await.unwrap();
    assert_eq!(config["preheat"], true);
}
