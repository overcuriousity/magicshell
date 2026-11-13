#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Duration;

use magicshell::error::AppError;
use magicshell::kit::config::Secret;
use magicshell::systemone::{Run, request_json};
use magicshell::upstream::Upstream;
use support::{FakeReply, fake_upstream, fixture_reply};

const MODEL: &str = "test-model";

fn triage_run() -> Run {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/systemone/response-triage.json");
    let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    serde_json::from_value(fixture["run"].clone()).unwrap()
}

fn upstream(url: url::Url, key: Option<&str>, timeout: Duration) -> Upstream {
    Upstream::new(url, key.map(Secret::new), MODEL.to_owned(), timeout).unwrap()
}

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

async fn error_of(reply: FakeReply) -> AppError {
    let fake = fake_upstream(vec![reply]).await;
    upstream(fake.url, None, secs(5)).run(&triage_run()).await.unwrap_err()
}

#[tokio::test]
async fn a_triage_run_returns_all_three_answers() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    let reply = upstream(fake.url, None, secs(5)).run(&triage_run()).await.unwrap();
    assert_eq!(reply.outcome.answers.len(), 3);
    assert!(reply.outcome.input_tokens > 0);
    let json = serde_json::to_value(&reply).unwrap();
    assert!(json["answers"].is_object());
    assert!(json["model"].is_string());
    assert!(json["inputTokens"].is_u64());
    assert!(json["upstreamMs"].is_u64());
}

#[tokio::test]
async fn the_request_goes_to_systemone_with_the_configured_model() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    let run = triage_run();
    upstream(fake.url.clone(), None, secs(5)).run(&run).await.unwrap();
    let seen = fake.requests.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/v1/systemone");
    assert_eq!(seen[0].body, request_json(&run, MODEL));
}

#[tokio::test]
async fn the_key_is_sent_as_a_bearer_token() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    upstream(fake.url.clone(), Some("s3cret"), secs(5)).run(&triage_run()).await.unwrap();
    assert_eq!(fake.requests.lock().unwrap()[0].authorization.as_deref(), Some("Bearer s3cret"));
}

#[tokio::test]
async fn no_authorization_header_is_sent_without_a_key() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    upstream(fake.url.clone(), None, secs(5)).run(&triage_run()).await.unwrap();
    assert_eq!(fake.requests.lock().unwrap()[0].authorization, None);
}

#[tokio::test]
async fn a_reply_that_is_not_json_is_a_bad_gateway_with_one_sentence() {
    let err = error_of(fixture_reply("response-non-json")).await;
    assert!(matches!(err, AppError::Upstream(_)));
    assert_eq!(err.to_string(), "The model endpoint sent an answer this app does not understand.");
}

#[tokio::test]
async fn a_refused_key_is_reported() {
    for status in [401, 403] {
        let err = error_of(FakeReply::status(status, "no")).await;
        assert!(matches!(err, AppError::Upstream(_)));
        assert_eq!(err.to_string(), "The model endpoint refused the key. Check the server configuration.");
    }
}

#[tokio::test]
async fn an_unknown_model_is_reported() {
    let err = error_of(FakeReply::status(404, "no")).await;
    assert_eq!(err.to_string(), "The model endpoint does not know this model. Check the server configuration.");
    let err = error_of(FakeReply::status(501, "no")).await;
    assert_eq!(err.to_string(), "This model is not a decision model. Check the server configuration.");
}

#[tokio::test]
async fn any_other_error_status_is_reported_with_its_number() {
    let err = error_of(FakeReply::status(500, "boom")).await;
    assert!(matches!(err, AppError::Upstream(_)));
    assert_eq!(err.to_string(), "The model endpoint answered with an error (500). Try again later.");
}

#[tokio::test]
async fn a_slow_endpoint_times_out() {
    let mut slow = fixture_reply("response-triage");
    slow.delay = secs(1);
    let fake = fake_upstream(vec![slow]).await;
    let err = upstream(fake.url, None, Duration::from_millis(200)).run(&triage_run()).await.unwrap_err();
    assert!(matches!(err, AppError::UpstreamTimeout));
    assert_eq!(err.status(), axum::http::StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(err.to_string(), "The model took too long to answer. Try again.");
}

#[tokio::test]
async fn a_closed_port_cannot_be_reached() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let url: url::Url = format!("http://127.0.0.1:{port}/v1").parse().unwrap();
    let err = upstream(url, None, secs(5)).run(&triage_run()).await.unwrap_err();
    assert!(matches!(err, AppError::Upstream(_)));
    assert_eq!(err.to_string(), "The model endpoint cannot be reached. Try again later.");
}

#[tokio::test]
async fn a_trailing_slash_on_the_endpoint_is_ignored() {
    let fake = fake_upstream(vec![fixture_reply("response-triage")]).await;
    let url: url::Url = format!("{}/", fake.url).parse().unwrap();
    upstream(url, None, secs(5)).run(&triage_run()).await.unwrap();
    assert_eq!(fake.requests.lock().unwrap()[0].path, "/v1/systemone");
}
