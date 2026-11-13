#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use serde_json::{Value, json};
use support::{FakeReply, TestApp, fake_upstream, fixture_reply, spawn_against};

fn triage_run() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/systemone/response-triage.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fixture["run"].clone()
}

async fn post_run(app: &TestApp, body: &Value) -> reqwest::Response {
    app.client.post(format!("{}/api/run", app.base)).json(body).send().await.unwrap()
}

#[tokio::test]
async fn the_server_answers_a_health_check() {
    let app = support::spawn(support::OPEN).await;
    let res = app.client.get(format!("{}/healthz", app.base)).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "ok");
}

#[tokio::test]
async fn the_configuration_names_the_mode_and_the_model() {
    let app = support::spawn(support::OPEN).await;
    let res = app.client.get(format!("{}/api/config", app.base)).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body, json!({"mode": "open", "model": "test-model", "user": null}));
}

#[tokio::test]
async fn a_run_is_answered_through_the_server() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    let app = spawn_against(support::OPEN, &fake).await;
    let res = post_run(&app, &triage_run()).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert!(body["model"].is_string());
    assert!(body["answers"]["team"].is_object() || body["answers"]["team"].is_string());
    assert!(body["upstreamMs"].is_u64());
    assert_eq!(fake.requests.lock().unwrap()[0].path, "/v1/systemone");
}

#[tokio::test]
async fn the_browser_cannot_choose_the_model_or_add_fields() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    let app = spawn_against(support::OPEN, &fake).await;
    let mut run = triage_run();
    run["model"] = json!("another-model");
    let res = post_run(&app, &run).await;
    assert_eq!(res.status(), 422);
    assert_eq!(res.text().await.unwrap(), "The server could not read this request. Reload the page and try again.");
    assert!(fake.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_invalid_run_is_refused_before_calling_the_model() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    let app = spawn_against(support::OPEN, &fake).await;
    let mut run = triage_run();
    run["questions"] = json!([]);
    let res = post_run(&app, &run).await;
    assert_eq!(res.status(), 422);
    assert!(!res.text().await.unwrap().is_empty());
    assert_eq!(fake.requests.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn the_key_is_not_in_any_response() {
    let fake =
        fake_upstream(vec![fixture_reply("response-triage"), FakeReply::status(401, "bad key sk-secret-key")]).await;
    let toml = format!("{}api_key = \"sk-secret-key\"\n", support::OPEN);
    let app = spawn_against(&toml, &fake).await;
    let endpoint = fake.url.to_string();
    let mut seen = Vec::new();
    seen.push(app.client.get(format!("{}/api/config", app.base)).send().await.unwrap());
    seen.push(post_run(&app, &triage_run()).await);
    seen.push(post_run(&app, &triage_run()).await);
    seen.push(app.client.get(format!("{}/", app.base)).send().await.unwrap());
    for res in seen {
        let headers = format!("{:?}", res.headers());
        let body = res.text().await.unwrap();
        assert!(!body.contains("sk-secret-key") && !headers.contains("sk-secret-key"));
        assert!(!body.contains(&endpoint) && !headers.contains(&endpoint));
    }
    let seen = fake.requests.lock().unwrap();
    assert_eq!(seen[0].authorization.as_deref(), Some("Bearer sk-secret-key"));
}

#[tokio::test]
async fn runs_are_limited_per_client() {
    let fake = fake_upstream(vec![fixture_reply("response-triage"), fixture_reply("response-triage")]).await;
    let toml = format!("{}runs_per_minute = 2\n", support::OPEN);
    let app = spawn_against(&toml, &fake).await;
    assert_eq!(post_run(&app, &triage_run()).await.status(), 200);
    assert_eq!(post_run(&app, &triage_run()).await.status(), 200);
    let third = post_run(&app, &triage_run()).await;
    assert_eq!(third.status(), 429);
    assert_eq!(third.text().await.unwrap(), "Too many questions. Wait a minute and try again.");
    assert_eq!(fake.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn the_start_page_carries_the_manifest_csp() {
    let app = support::spawn(support::OPEN).await;
    let res = app.client.get(format!("{}/", app.base)).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-security-policy"], magicshell::kit::security::CSP);
    assert!(res.headers()["content-type"].to_str().unwrap().starts_with("text/html"));
    let html = res.text().await.unwrap();
    assert!(!html.contains("<script>") && !html.contains("<style>") && !html.contains("style="));
}

#[tokio::test]
async fn a_foreign_origin_may_not_post() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    let app = spawn_against(support::OPEN, &fake).await;
    let res = app
        .client
        .post(format!("{}/api/run", app.base))
        .header("origin", "https://evil.example")
        .json(&triage_run())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    assert!(fake.requests.lock().unwrap().is_empty());
}
