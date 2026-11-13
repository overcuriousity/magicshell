#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use serde_json::{Value, json};
use support::{
    ACCOUNTS, FakeReply, OPEN, TestApp, add_user, fake_upstream, fixture_reply, get_with, post_json, sign_in,
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

fn with_state(state: &str) -> Value {
    let mut run = triage_run();
    run["state"] = json!(state);
    run
}

fn replies(n: usize) -> Vec<FakeReply> {
    (0..n).map(|_| fixture_reply("response-triage")).collect()
}

async fn config_why(app: &TestApp) -> Value {
    let body: Value = get_with(app, "/api/config", None).await.json().await.unwrap();
    body["why"].clone()
}

#[tokio::test]
async fn why_does_not_exist_in_open_mode() {
    let fake = fake_upstream(replies(1)).await;
    let app = spawn_against(OPEN, &fake).await;
    let res = post_json(&app, "/api/why", &triage_run(), None).await;
    assert_eq!(res.status(), 404);
    assert_eq!(config_why(&app).await, Value::Null);
    assert_eq!(fake.requests.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn why_needs_a_signed_in_user() {
    let (app, fake) = app_with_ada(replies(1), "").await;
    let res = post_json(&app, "/api/why", &triage_run(), None).await;
    assert_eq!(res.status(), 401);
    assert_eq!(fake.requests.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn why_answers_like_a_run() {
    let (app, _fake) = app_with_ada(replies(2), "").await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    let run: Value = post_json(&app, "/api/run", &triage_run(), Some(&cookie)).await.json().await.unwrap();
    let res = post_json(&app, "/api/why", &triage_run(), Some(&cookie)).await;
    assert_eq!(res.status(), 200);
    let why: Value = res.json().await.unwrap();
    assert_eq!(why["answers"], run["answers"]);
}

#[tokio::test]
async fn why_has_its_own_allowance() {
    let extra = "runs_per_minute = 1\nwhy_per_minute = 2\n";
    let (app, _fake) = app_with_ada(replies(4), extra).await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    for status in [200, 200, 429] {
        let res = post_json(&app, "/api/why", &triage_run(), Some(&cookie)).await;
        assert_eq!(res.status(), status);
        if status == 429 {
            assert_eq!(res.text().await.unwrap(), "Too many questions. Wait a minute and try again.");
        }
    }
    assert_eq!(post_json(&app, "/api/run", &triage_run(), Some(&cookie)).await.status(), 200);

    let (app, _fake) = app_with_ada(replies(4), extra).await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    assert_eq!(post_json(&app, "/api/run", &triage_run(), Some(&cookie)).await.status(), 200);
    assert_eq!(post_json(&app, "/api/run", &triage_run(), Some(&cookie)).await.status(), 429);
    assert_eq!(post_json(&app, "/api/why", &triage_run(), Some(&cookie)).await.status(), 200);
}

#[tokio::test]
async fn why_refuses_more_words_than_the_limit() {
    let (app, fake) = app_with_ada(replies(2), "why_max_words = 3\n").await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    let res = post_json(&app, "/api/why", &with_state("a b c"), Some(&cookie)).await;
    assert_eq!(res.status(), 200);
    let res = post_json(&app, "/api/why", &with_state("a  b\nc d"), Some(&cookie)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "Why? works up to 3 words; this situation has 4.");
    assert_eq!(fake.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn why_validates_the_run_like_a_run() {
    let (app, fake) = app_with_ada(replies(1), "").await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    let mut run = triage_run();
    run["questions"] = json!([]);
    let res = post_json(&app, "/api/why", &run, Some(&cookie)).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "Add at least one question.");
    assert_eq!(fake.requests.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn why_set_to_zero_words_is_off() {
    let (app, _fake) = app_with_ada(replies(1), "why_max_words = 0\n").await;
    let cookie = sign_in(&app, "ada", PASSWORD).await;
    assert_eq!(post_json(&app, "/api/why", &triage_run(), Some(&cookie)).await.status(), 404);
    assert_eq!(config_why(&app).await, Value::Null);
}

#[tokio::test]
async fn the_configuration_tells_the_word_limit() {
    let (app, _fake) = app_with_ada(vec![], "").await;
    assert_eq!(config_why(&app).await, json!({"maxWords": 300}));
}
